import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { now, parseEnvVars, type DB, type EnvRow, type EnvServiceRow, type ServiceKind, type ServiceRow, type TaskRow } from "./db.js";
import { ensureSession, killSession, sessionExists } from "./tmux.js";

const execFileAsync = promisify(execFile);

const PORT_RANGE: Record<ServiceKind, [number, number]> = { be: [18000, 18999], fe: [13000, 13999] };

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

    async status(taskId: string): Promise<Array<ServiceRow & { running: boolean }>> {
        const rows = this.list(taskId);
        const out: Array<ServiceRow & { running: boolean }> = [];
        for (const r of rows) {
            const alive = (await sessionExists(r.tmux)) && (await portListening(r.port));
            out.push({ ...r, running: alive });
        }
        return out;
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
        if (existing && (await sessionExists(existing.tmux))) return existing;
        if (existing) this.db.prepare(`UPDATE services SET stopped_at = ? WHERE id = ?`).run(now(), existing.id);

        const be = kind === "fe" ? this.get(task.id, "be") : undefined;
        if (kind === "fe" && !be) throw new Error("start the BE first — the FE command is linked to its URL");

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
        // The command may be an && chain; run it in a subshell so its whole stdout+stderr reaches the log.
        const wrapped = `cd ${JSON.stringify(cwd)}; echo "[stagehand] ${kind.toUpperCase()} on ${url} · $(date)" | tee -a ${JSON.stringify(logPath)}; ( ${command} ) 2>&1 | tee -a ${JSON.stringify(logPath)}; echo "[stagehand] ${kind.toUpperCase()} exited (\${PIPESTATUS[0]:-$?})" | tee -a ${JSON.stringify(logPath)}; sleep 86400`;
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
