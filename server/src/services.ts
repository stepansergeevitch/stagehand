import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { now, parseEnvVars, type DB, type EnvRow, type EnvServiceRow, type ServiceKind, type ServiceRow, type TaskRow } from "./db.js";
import { ensureSession, killSession, sessionExists } from "./tmux.js";

const execFileAsync = promisify(execFile);

const PORT_RANGE: Record<ServiceKind, [number, number]> = { be: [18000, 18999], fe: [13000, 13999] };

// How long a BE/FE gets to start listening on its port before it counts as failed (a Next/Vite dev server compiles
// first; a Python backend runs migrations). Same budgets the QA bring-up used to wait with.
export const START_TIMEOUT_MS: Record<ServiceKind, number> = { be: 180_000, fe: 300_000 };

export type ServiceState = "starting" | "running" | "failed";
export type ServiceStatus = ServiceRow & { running: boolean; state: ServiceState };

// The wrapper around every BE/FE command prints these markers into the log: one when it starts, one when the command
// exits (the pane then sleeps so the log stays readable). "exited" after the latest start marker = the process is gone.
const startMarker = (kind: ServiceKind): string => `[stagehand] ${kind.toUpperCase()} on `;
const exitMarker = (kind: ServiceKind): RegExp => new RegExp(`^\\[stagehand\\] ${kind.toUpperCase()} exited \\((.*)\\)`);

// The log lines written by the current start (after the latest start marker), oldest first.
const currentRunLog = (row: ServiceRow): string[] => {
    if (!existsSync(row.log_path)) return [];
    const lines = readFileSync(row.log_path, "utf8").split("\n");
    const start = lines.map((l, i) => (l.startsWith(startMarker(row.kind)) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
    return lines.slice(start + 1);
};

const portListening = async (port: number): Promise<boolean> => {
    try {
        const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
        return stdout.trim() !== "";
    } catch {
        return false;
    }
};

// Binding 127.0.0.1 alone is not enough: a server on `*`/`::` (e.g. next dev) still lets that bind succeed on macOS.
const portFree = async (port: number): Promise<boolean> => {
    if (await portListening(port)) return false;
    return new Promise((resolve) => {
        const srv = createServer();
        srv.once("error", () => resolve(false));
        srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
};

const render = (template: string, vars: Record<string, string>): string => template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "");

export const serviceSessionName = (ticketId: string, kind: ServiceKind): string => `sh-${ticketId.toLowerCase()}-${kind}`;

export class Services {
    constructor(
        private readonly db: DB,
        private readonly cfg: Config,
    ) {}

    list(taskId: string): ServiceRow[] {
        return this.db.prepare(`SELECT * FROM services WHERE task_id = ? AND stopped_at IS NULL ORDER BY kind`).all(taskId) as ServiceRow[];
    }

    get(taskId: string, kind: ServiceKind): ServiceRow | undefined {
        return this.db.prepare(`SELECT * FROM services WHERE task_id = ? AND kind = ? AND stopped_at IS NULL`).get(taskId, kind) as ServiceRow | undefined;
    }

    async status(taskId: string): Promise<ServiceStatus[]> {
        const out: ServiceStatus[] = [];
        for (const r of this.list(taskId)) out.push(await this.probe(r));
        return out;
    }

    // Where a service actually is, and why it is not up if it isn't: listening on its port = running; otherwise its
    // tmux session gone, its command exited (the log marker), or the start budget spent without a listener = failed —
    // recorded on the row so the state is stable (and the reason is kept) until the service is stopped or restarted.
    async probe(row: ServiceRow): Promise<ServiceStatus> {
        if (row.failed_at) return { ...row, running: false, state: "failed" };
        const listening = await portListening(row.port);
        if (listening) return { ...row, running: true, state: "running" };
        const kind = row.kind.toUpperCase();
        let error: string | null = null;
        if (!(await sessionExists(row.tmux))) error = `its tmux session ${row.tmux} is gone — the host or tmux server restarted, or it was killed by hand`;
        else {
            const exited = currentRunLog(row).map((l) => exitMarker(row.kind).exec(l)).find((m) => m);
            if (exited) error = `the ${kind} command exited (status ${exited[1]}) without leaving anything listening on port ${row.port}`;
            else if (Date.now() - Date.parse(row.started_at) > START_TIMEOUT_MS[row.kind]) error = `nothing is listening on port ${row.port} after ${Math.round(START_TIMEOUT_MS[row.kind] / 60_000)} min`;
        }
        if (!error) return { ...row, running: false, state: "starting" };
        this.db.prepare(`UPDATE services SET failed_at = ?, error = ? WHERE id = ? AND failed_at IS NULL`).run(now(), error, row.id);
        const fresh = this.db.prepare(`SELECT * FROM services WHERE id = ?`).get(row.id) as ServiceRow;
        return { ...fresh, running: false, state: "failed" };
    }

    // The last lines the current start wrote (for the failure notice and the agent's fix prompt).
    logTail(row: ServiceRow, lines = 60): string {
        return currentRunLog(row).filter((l) => l.trim() !== "").slice(-lines).join("\n");
    }

    // Polls until the service is listening (ok) or has failed (with the reason); the start budget in `probe` is what
    // ends the wait, so a caller never blocks longer than that budget plus one poll.
    async waitUntilUp(row: ServiceRow): Promise<{ ok: true } | { ok: false; error: string }> {
        for (;;) {
            const s = await this.probe(row);
            if (s.state === "running") return { ok: true };
            if (s.state === "failed") return { ok: false, error: s.error ?? "failed to start" };
            await new Promise((r) => setTimeout(r, 2000));
        }
    }

    // Records failures even when nobody is looking at the task page (the UI polls only while it is open).
    startWatch(intervalMs = 15_000): void {
        setInterval(() => {
            const rows = this.db.prepare(`SELECT * FROM services WHERE stopped_at IS NULL AND failed_at IS NULL`).all() as ServiceRow[];
            for (const r of rows) void this.probe(r).catch(() => undefined);
        }, intervalMs).unref();
    }

    private async pickPort(kind: ServiceKind, fixed: number | null, task: TaskRow): Promise<number> {
        if (fixed) {
            // Apps whose port is pinned (Auth0 callback, hard-coded bundle URL) can only run for one task at a time.
            const holder = this.db
                .prepare(`SELECT s.task_id, t.ticket_id FROM services s JOIN tasks t ON t.id = s.task_id WHERE s.port = ? AND s.stopped_at IS NULL AND s.task_id != ?`)
                .get(fixed, task.id) as { task_id: string; ticket_id: string } | undefined;
            if (holder) throw new Error(`port ${fixed} is held by task ${holder.ticket_id}'s ${kind.toUpperCase()} — stop it first`);
            if (!(await portFree(fixed))) throw new Error(`port ${fixed} is in use by a process outside Stagehand — free it first`);
            return fixed;
        }
        const [lo, hi] = PORT_RANGE[kind];
        const taken = new Set((this.db.prepare(`SELECT port FROM services WHERE stopped_at IS NULL`).all() as Array<{ port: number }>).map((r) => r.port));
        for (let p = lo; p <= hi; p++) {
            if (taken.has(p)) continue;
            if (await portFree(p)) return p;
        }
        throw new Error(`no free port in ${lo}-${hi} for ${kind}`);
    }

    async start(task: TaskRow, env: EnvRow, kind: ServiceKind): Promise<ServiceRow> {
        const template = kind === "be" ? env.be_command : env.fe_command;
        if (!template) throw new Error(`env "${env.name}" has no ${kind.toUpperCase()} command configured`);
        const existing = this.get(task.id, kind);
        if (existing) {
            // A live, healthy (or still starting) row is reused; a failed one is torn down and started over.
            const probed = await this.probe(existing);
            if (probed.state !== "failed" && (await sessionExists(existing.tmux))) return existing;
            await killSession(existing.tmux);
            this.db.prepare(`UPDATE services SET stopped_at = ? WHERE id = ?`).run(now(), existing.id);
        }

        const be = kind === "fe" ? this.get(task.id, "be") : undefined;
        if (kind === "fe" && (!be || be.failed_at)) throw new Error(be ? "the BE failed to start — fix or restart it first; the FE command is linked to its URL" : "start the BE first — the FE command is linked to its URL");

        const port = await this.pickPort(kind, kind === "be" ? env.be_port : env.fe_port, task);
        const urlTemplate = (kind === "be" ? env.be_url_template : env.fe_url_template) ?? "http://localhost:{{port}}";
        const url = render(urlTemplate, { port: String(port) });
        const vars: Record<string, string> = {
            port: String(port),
            url,
            bePort: be ? String(be.port) : "",
            beUrl: be ? be.url : "",
            worktree: task.worktree_path ?? env.path,
            taskDir: join(this.cfg.dataDir, "tasks", task.id),
        };
        const command = render(template, vars);
        const logDir = join(this.cfg.dataDir, "tasks", task.id, "logs");
        mkdirSync(logDir, { recursive: true });
        const logPath = join(logDir, `${kind}.log`);
        const tmux = serviceSessionName(task.ticket_id, kind);
        const cwd = task.worktree_path ?? env.path;
        // The command may be an && chain; run it in a subshell so its whole stdout+stderr reaches the log. The pane
        // runs in tmux's default shell (the user's — zsh here, where the pipe statuses are `pipestatus[1]`; bash's
        // is `PIPESTATUS[0]`), so both spellings are tried before falling back to tee's own status.
        const wrapped = `cd ${JSON.stringify(cwd)}; echo "[stagehand] ${kind.toUpperCase()} on ${url} · $(date)" | tee -a ${JSON.stringify(logPath)}; ( ${command} ) 2>&1 | tee -a ${JSON.stringify(logPath)}; echo "[stagehand] ${kind.toUpperCase()} exited (\${pipestatus[1]:-\${PIPESTATUS[0]:-$?}})" | tee -a ${JSON.stringify(logPath)}; sleep 86400`;
        await ensureSession(tmux, cwd, wrapped, {
            ...parseEnvVars(env.env_vars),
            PORT: String(port),
            STAGEHAND_PORT: String(port),
            STAGEHAND_BE_URL: be?.url ?? "",
            STAGEHAND_BE_PORT: be ? String(be.port) : "",
        });

        const id = randomUUID();
        this.db
            .prepare(`INSERT INTO services (id, task_id, kind, port, url, tmux, command, log_path, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, task.id, kind, port, url, tmux, command, logPath, now());
        return this.db.prepare(`SELECT * FROM services WHERE id = ?`).get(id) as ServiceRow;
    }

    // Ports outside the ranges Stagehand allocates from were pinned by the env (and may be shared with the user's own servers).
    private isFixedPort(port: number): boolean {
        return !Object.values(PORT_RANGE).some(([lo, hi]) => port >= lo && port <= hi);
    }

    async stop(taskId: string, kind: ServiceKind): Promise<void> {
        const row = this.get(taskId, kind);
        if (!row) return;
        const hadSession = await sessionExists(row.tmux);
        await killSession(row.tmux);
        // Only sweep leftover listeners when this service actually owned the port: a process we started, on a port
        // Stagehand chose. On a fixed port (3000/8000-style pins) the listener may be the user's own dev server.
        if (hadSession && !this.isFixedPort(row.port)) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
                const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${row.port}`, "-sTCP:LISTEN", "-t"]);
                for (const pid of stdout.trim().split("\n").filter(Boolean)) process.kill(Number(pid), "SIGTERM");
            } catch {
                /* nothing listening */
            }
        }
        this.db.prepare(`UPDATE services SET stopped_at = ? WHERE id = ?`).run(now(), row.id);
    }

    async stopAll(taskId: string): Promise<void> {
        await this.stop(taskId, "fe");
        await this.stop(taskId, "be");
    }

    // Plain port wait, used for the shared dependency service (which has no row of its own to record failure on).
    async waitForPort(port: number, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await portListening(port)) return true;
            await new Promise((r) => setTimeout(r, 2000));
        }
        return false;
    }

    // ---------- dependency services: one shared instance per env, reused by every task that needs it ----------

    // A free-port search that avoids the per-task BE/FE ranges above, so a dependency service can never collide with
    // an ordinary task's own BE/FE.
    private static readonly DEP_PORT_RANGE: [number, number] = [19000, 19999];
    private async pickFreePort([lo, hi]: [number, number]): Promise<number> {
        for (let p = lo; p <= hi; p++) if (await portFree(p)) return p;
        throw new Error(`no free port in ${lo}-${hi}`);
    }

    envServiceRow(envId: string): EnvServiceRow | undefined {
        return this.db.prepare(`SELECT * FROM env_services WHERE env_id = ?`).get(envId) as EnvServiceRow | undefined;
    }

    // Ensures `env`'s configured dependency (another env's BE, e.g. Deal needing Core for auth) is up, starting it
    // once and reusing it for every task afterward — it isn't itself under test, so it never gets its own worktree
    // or a fresh instance per task. Prefers the dependency's own configured port (its app most likely assumes it);
    // falls back to a free one only when that port is unavailable (occupied by something else, or the dependency has
    // no fixed port configured), remembering the last port it actually used so a restart tends to land on the same
    // one. Returns null when `env` has no dependency configured.
    async ensureDependency(env: EnvRow): Promise<{ url: string } | null> {
        if (!env.depends_on_env_id) return null;
        const dep = this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(env.depends_on_env_id) as EnvRow | undefined;
        if (!dep) throw new Error(`dependency env ${env.depends_on_env_id} no longer exists`);
        if (!dep.be_command) throw new Error(`dependency env "${dep.name}" has no BE command configured`);
        const existing = this.envServiceRow(dep.id);
        if (existing && (await sessionExists(existing.tmux)) && (await portListening(existing.port))) return { url: existing.url };
        if (existing) this.db.prepare(`DELETE FROM env_services WHERE env_id = ?`).run(dep.id);
        let port: number;
        if (dep.be_port && (await portFree(dep.be_port))) port = dep.be_port;
        else if (existing && (await portFree(existing.port))) port = existing.port;
        else port = await this.pickFreePort(Services.DEP_PORT_RANGE);
        const urlTemplate = dep.be_url_template ?? "http://localhost:{{port}}";
        const url = render(urlTemplate, { port: String(port) });
        const command = render(dep.be_command, { port: String(port), url, bePort: "", beUrl: "", worktree: dep.path, taskDir: "" });
        const logDir = join(this.cfg.dataDir, "envs", dep.id);
        mkdirSync(logDir, { recursive: true });
        const logPath = join(logDir, "dependency-be.log");
        const tmux = `sh-dep-${dep.id.slice(0, 8)}`;
        const wrapped = `cd ${JSON.stringify(dep.path)}; echo "[stagehand] dependency BE (${dep.name}, for ${env.name}) on ${url} · $(date)" | tee -a ${JSON.stringify(logPath)}; ( ${command} ) 2>&1 | tee -a ${JSON.stringify(logPath)}; echo "[stagehand] dependency BE (${dep.name}) exited" | tee -a ${JSON.stringify(logPath)}; sleep 86400`;
        await ensureSession(tmux, dep.path, wrapped, { ...parseEnvVars(dep.env_vars), PORT: String(port), STAGEHAND_PORT: String(port) });
        this.db
            .prepare(`INSERT INTO env_services (env_id, port, url, tmux, command, log_path, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(dep.id, port, url, tmux, command, logPath, now());
        if (!(await this.waitForPort(port, 180_000))) throw new Error(`dependency "${dep.name}" did not come up on port ${port} within 3 min — check ${logPath}`);
        return { url };
    }
}
