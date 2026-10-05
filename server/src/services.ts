import { runMigration } from "./migrations.js";
import { withPrepare } from "./env-config.js";
import { taskDbEnv, taskDbExpect } from "./task-db.js";
import { assertDbHosts } from "./db-hosts.js";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { componentsOf, now, parseEnvVars, type CoreServiceKind, type DB, type EnvRow, type EnvServiceRow, type ServiceKind, type ServiceRow, type TaskRow } from "./db.js";
import { ensureSession, killSession, sessionExists, sessionExistsSync } from "./tmux.js";

const execFileAsync = promisify(execFile);

// Every process of the machine as pid → parent pid and command (one `ps` call).
const processTable = async (): Promise<Array<{ pid: number; ppid: number; command: string }>> => {
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 });
    return stdout
        .split("\n")
        .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
};

// The pids under `roots` (the roots included), from one process table.
const descendants = (table: Array<{ pid: number; ppid: number }>, roots: number[]): number[] => {
    const out = new Set(roots);
    let grew = true;
    while (grew) {
        grew = false;
        for (const p of table) if (out.has(p.ppid) && !out.has(p.pid)) { out.add(p.pid); grew = true; }
    }
    return [...out];
};

const signal = (pids: number[], sig: NodeJS.Signals): number[] => {
    const alive: number[] = [];
    for (const pid of pids) {
        try {
            process.kill(pid, sig);
            alive.push(pid);
        } catch {
            /* already gone */
        }
    }
    return alive;
};

// Kills a tmux session and every process that ran under it. `tmux kill-session` only hangs up the pane: a celery
// worker (no port, so no port sweep) survived that, was adopted by launchd and kept its 1.7 GB — 21 of them on
// 2026-09-30, 35 GB with swap full. The tree is read before the session goes, then TERM, then KILL what is left.
export const killSessionTree = async (name: string): Promise<void> => {
    let tree: number[] = [];
    try {
        const { stdout } = await execFileAsync("tmux", ["list-panes", "-s", "-t", `=${name}`, "-F", "#{pane_pid}"]);
        const roots = stdout.split("\n").map(Number).filter((n) => n > 0);
        if (roots.length) tree = descendants(await processTable(), roots);
    } catch {
        /* no such session */
    }
    await killSession(name);
    if (!tree.length) return;
    await new Promise((r) => setTimeout(r, 1500));
    const left = signal(tree, "SIGTERM");
    if (!left.length) return;
    await new Promise((r) => setTimeout(r, 4000));
    signal(left, "SIGKILL");
};

export const PORT_RANGE: Record<CoreServiceKind, [number, number]> = { be: [18000, 18999], fe: [13000, 13999] };

// How long a BE/FE gets to start listening on its port before it counts as failed (a Next/Vite dev server compiles
// first; a Python backend runs migrations). Same budgets the QA bring-up used to wait with.
export const START_TIMEOUT_MS: Record<CoreServiceKind, number> = { be: 180_000, fe: 300_000 };

const isCore = (kind: ServiceKind): kind is CoreServiceKind => kind === "be" || kind === "fe";
// An optional component has no port to probe: it counts as running once its command has stayed alive this long.
const COMPONENT_READY_MS = 5_000;
// The command a service kind runs: the env's BE/FE command, or the optional component with that key.
const commandTemplate = (env: EnvRow, kind: ServiceKind): string | null =>
    kind === "be" ? env.be_command : kind === "fe" ? env.fe_command : (componentsOf(env).find((c) => c.key === kind)?.command ?? null);

// "stopped" is only ever reported for the shared dependency (see dependencyStatus): a BE/FE/component that is not
// running has no row at all.
export type ServiceState = "stopped" | "starting" | "running" | "failed";
// `label`/`shared` are set on the dependency's entry only (the App widget and the agents name it by its env).
export type ServiceStatus = ServiceRow & { running: boolean; state: ServiceState; label?: string; shared?: boolean };

// The env's shared dependency (Deal → Core) shows up as one more optional component under this key — Run / Stop / Log
// in the App widget, start/stop through the same routes for the agents — while staying one instance for every task of
// the env (user, 2026-09-23: "make core like a celery in dualentry — a runnable optional component").
export const DEPENDENCY_KIND = "dependency";
const DEP_START_TIMEOUT_MS = 180_000;

// The wrapper around every BE/FE command prints these markers into the log: one when it starts, one when the command
// exits (the pane then sleeps so the log stays readable). "exited" after the latest start marker = the process is gone.
const startMarker = (kind: ServiceKind): string => `[stagehand] ${kind.toUpperCase()} on `;
const exitMarker = (kind: ServiceKind): RegExp => new RegExp(`^\\[stagehand\\] ${kind.toUpperCase()} exited \\((.*)\\)`);

// The log lines written by the current start (after the latest start marker), oldest first.
const currentRunLog = (row: Pick<ServiceRow, "kind" | "log_path">): string[] => {
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
        if (row.port > 0 && (await portListening(row.port))) return { ...row, running: true, state: "running" };
        const kind = row.kind.toUpperCase();
        let error: string | null = null;
        if (!(await sessionExists(row.tmux))) {
            // Not a defect in the app: the pane itself vanished (tmux/host restart, killed by hand, memory pressure).
            // Start it again ourselves — the user's ask (2026-09-20): "this sometimes happens to BE/FE servers locally …
            // can we handle this automatically?" — within a budget, so a pane that keeps dying still surfaces as failed.
            const recovered = await this.recoverVanished(row);
            if (typeof recovered !== "string") return { ...recovered, running: false, state: "starting" };
            error = recovered;
        } else {
            const exited = currentRunLog(row).map((l) => exitMarker(row.kind).exec(l)).find((m) => m);
            if (exited) error = row.port > 0 ? `the ${kind} command exited (status ${exited[1]}) without leaving anything listening on port ${row.port}` : `the ${kind} command exited (status ${exited[1]})`;
            // A port-less component is "running" once its command has survived the first seconds (a worker prints its
            // banner and blocks); a crash later shows up as the exit marker on the next probe.
            else if (!isCore(row.kind)) return Date.now() - Date.parse(row.started_at) > COMPONENT_READY_MS ? { ...row, running: true, state: "running" } : { ...row, running: false, state: "starting" };
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

    // Records failures (and recovers vanished panes) even when nobody is looking at the task page. BE rows first: a
    // vanished FE is restarted with its BE's URL, which must be the live one.
    // Processes launchd adopted (parent pid 1) whose command names a task's worktree, for a task with no service
    // running: what a lost pane (tmux or host restart, a session killed by hand) leaves behind. Returns what it killed.
    async sweepOrphans(): Promise<Array<{ pid: number; command: string }>> {
        const tasks = this.db.prepare(`SELECT id, worktree_path FROM tasks WHERE worktree_path IS NOT NULL`).all() as Array<{ id: string; worktree_path: string }>;
        if (!tasks.length) return [];
        const live = new Set((this.db.prepare(`SELECT DISTINCT task_id FROM services WHERE stopped_at IS NULL AND failed_at IS NULL`).all() as Array<{ task_id: string }>).map((r) => r.task_id));
        const idle = tasks.filter((t) => !live.has(t.id));
        const table = await processTable().catch(() => []);
        const orphans = table.filter((p) => p.ppid === 1 && p.pid !== process.pid && idle.some((t) => p.command.includes(`${t.worktree_path}/`) || p.command.includes(`${t.worktree_path} `)));
        if (!orphans.length) return [];
        signal(orphans.map((p) => p.pid), "SIGTERM");
        await new Promise((r) => setTimeout(r, 4000));
        signal(orphans.map((p) => p.pid), "SIGKILL");
        for (const o of orphans) console.log(`[services] killed orphaned process ${o.pid}: ${o.command.slice(0, 160)}`);
        return orphans.map((o) => ({ pid: o.pid, command: o.command }));
    }

    startWatch(intervalMs = 15_000): void {
        let ticks = 0;
        setInterval(() => {
            // Every ~5 minutes: reclaim what lost panes left running.
            if (++ticks % 20 === 1) void this.sweepOrphans().catch((e: unknown) => console.warn(`[services] orphan sweep: ${String((e as Error).message ?? e).slice(0, 160)}`));
            const rows = this.db.prepare(`SELECT * FROM services WHERE stopped_at IS NULL AND failed_at IS NULL ORDER BY CASE kind WHEN 'be' THEN 0 ELSE 1 END`).all() as ServiceRow[];
            void (async () => {
                for (const r of rows) await this.probe(r).catch(() => undefined);
            })();
        }, intervalMs).unref();
    }

    // Called with a one-line notice for the task's Chat when a service was restarted (or given up on) on its own.
    onNotice: ((taskId: string, text: string) => void) | null = null;

    private static readonly AUTO_RESTART_MAX = 3;
    private static readonly AUTO_RESTART_WINDOW_MS = 60 * 60_000;

    // The pane of `row` is gone. Within the budget (AUTO_RESTART_MAX starts per task+kind per hour), close the row and
    // start the same service again on the same port; returns the new row — or the error text to record on the old row
    // when the budget is spent or the start itself fails.
    private async recoverVanished(row: ServiceRow): Promise<ServiceRow | string> {
        const gone = `its tmux session ${row.tmux} is gone — the host or tmux server restarted, or it was killed by hand`;
        const since = new Date(Date.now() - Services.AUTO_RESTART_WINDOW_MS).toISOString();
        const recent = (this.db.prepare(`SELECT COUNT(*) AS n FROM services WHERE task_id = ? AND kind = ? AND auto_restart = 1 AND started_at > ?`).get(row.task_id, row.kind, since) as { n: number }).n;
        if (recent >= Services.AUTO_RESTART_MAX) return `${gone}; restarted automatically ${recent} times in the last hour and it keeps vanishing`;
        const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(row.task_id) as TaskRow | undefined;
        const env = task ? (this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(task.env_id) as EnvRow | undefined) : undefined;
        if (!task || !env) return gone;
        // Only a task that is working right now gets its pane back. A parked or finished task's service is closed
        // instead: after a tmux-server death this sweep used to revive every BE/FE of every old task at once (a 4 GB
        // Next dev server for a task waiting on its PR, 2026-09-24), and the next stage that needs the app starts it anyway.
        if (!["running", "queued"].includes(task.status as string)) {
            this.db.prepare(`UPDATE services SET stopped_at = ? WHERE id = ?`).run(now(), row.id);
            this.onNotice?.(row.task_id, `The ${row.kind.toUpperCase()}'s tmux session ${row.tmux} had vanished (host/tmux restart) — not restarted: the task is ${task.status.replace(/_/g, " ")}. The next stage that needs the app starts it again.`);
            return `${gone}; not restarted while the task is ${task.status.replace(/_/g, " ")}`;
        }
        // Close the vanished row first so start() allocates a fresh one (pickPort keeps the port); reopen it if the
        // start fails so the failure is recorded on a visible row.
        this.db.prepare(`UPDATE services SET stopped_at = ? WHERE id = ?`).run(now(), row.id);
        try {
            const fresh = await this.start(task, env, row.kind);
            this.db.prepare(`UPDATE services SET auto_restart = 1 WHERE id = ?`).run(fresh.id);
            this.onNotice?.(row.task_id, `♻️ The ${row.kind.toUpperCase()}'s tmux session ${row.tmux} had vanished (host/tmux restart, or killed by hand) — restarted it${fresh.port ? ` on port ${fresh.port}` : ""} (${recent + 1}/${Services.AUTO_RESTART_MAX} automatic restarts this hour).`);
            return { ...fresh, auto_restart: 1 };
        } catch (e) {
            this.db.prepare(`UPDATE services SET stopped_at = NULL WHERE id = ?`).run(row.id);
            return `${gone}; the automatic restart failed: ${String((e as Error).message ?? e).slice(0, 200)}`;
        }
    }

    // Ports picked by a start() that has not inserted its row yet: two tasks starting within the same tick otherwise
    // both pass the "not taken, free" test for the same port (PRODUCT-10501/10502, 2026-09-21: both BEs on 18005, both
    // FEs on 13005, 10 ms apart). Reserved here by pickPort, released by start() once the row exists (or on failure).
    private readonly reserving = new Set<number>();

    private async pickPort(kind: CoreServiceKind, fixed: number | null, task: TaskRow): Promise<number> {
        const port = await this.choosePort(kind, fixed, task);
        this.reserving.add(port);
        return port;
    }

    private async choosePort(kind: CoreServiceKind, fixed: number | null, task: TaskRow): Promise<number> {
        const taken = new Set((this.db.prepare(`SELECT port FROM services WHERE stopped_at IS NULL`).all() as Array<{ port: number }>).map((r) => r.port));
        for (const p of this.reserving) taken.add(p);
        // A pinned port is a preference, not a requirement: when another task, the user's own dev server or anything
        // else holds it, the service takes a free port from the range like every other one (user, 2026-09-21:
        // "it doesn't matter inside or outside - just pick a free port" — PRODUCT-10501 sat blocked on Core's 7777).
        if (fixed && !taken.has(fixed) && (await portFree(fixed))) return fixed;
        const [lo, hi] = PORT_RANGE[kind];
        // A restart keeps the port the service had: the FE was started with the BE's URL baked in (and a QA run has the
        // app's URL in its prompt), so a BE coming back on another port would orphan both.
        const last = this.db.prepare(`SELECT port FROM services WHERE task_id = ? AND kind = ? AND stopped_at IS NOT NULL ORDER BY stopped_at DESC LIMIT 1`).get(task.id, kind) as { port: number } | undefined;
        if (last && !taken.has(last.port) && last.port >= lo && last.port <= hi && (await portFree(last.port))) return last.port;
        for (let p = lo; p <= hi; p++) {
            if (taken.has(p)) continue;
            if (await portFree(p)) return p;
        }
        throw new Error(`no free port in ${lo}-${hi} for ${kind}`);
    }

    // The last start that failed, per task and service, until the next one succeeds — shown in the task's App widget
    // and posted to its chat, so a start that dies (a migrate refusing a conflicting migration graph, INV-149
    // 2026-10-05) is never silent once its button stops spinning.
    private readonly failures = new Map<string, { kind: string; at: string; error: string }>();

    lastFailures(taskId: string): Array<{ kind: string; at: string; error: string }> {
        return [...this.failures.entries()].filter(([k]) => k.startsWith(`${taskId}:`)).map(([, v]) => v);
    }

    async start(task: TaskRow, env: EnvRow, kind: ServiceKind): Promise<ServiceRow> {
        try {
            const row = await this.startInner(task, env, kind);
            this.failures.delete(`${task.id}:${kind}`);
            return row;
        } catch (e) {
            const error = String((e as Error).message ?? e).replace(/\{"event":[^}]*\}\s*/g, "").trim().slice(0, 1500);
            this.failures.set(`${task.id}:${kind}`, { kind, at: now(), error });
            this.onNotice?.(task.id, `❌ The ${kind.toUpperCase()} did not start: ${error.slice(0, 600)}`);
            throw e;
        }
    }

    private async startInner(task: TaskRow, env: EnvRow, kind: ServiceKind): Promise<ServiceRow> {
        const template = commandTemplate(env, kind);
        if (!template) throw new Error(isCore(kind) ? `env "${env.name}" has no ${kind.toUpperCase()} command configured` : `env "${env.name}" has no optional component "${kind}" — its keys: ${componentsOf(env).map((c) => c.key).join(", ") || "none"}`);
        const existing = this.get(task.id, kind);
        if (existing) {
            // A live, healthy (or still starting) row is reused; a failed one is torn down and started over. The probe
            // may itself have replaced a vanished row with a fresh start — then that fresh row is the one to return.
            const probed = await this.probe(existing);
            const current = this.get(task.id, kind);
            if (current && current.id !== existing.id) return current;
            if (probed.state !== "failed" && (await sessionExists(existing.tmux))) return existing;
            await killSessionTree(existing.tmux);
            this.db.prepare(`UPDATE services SET stopped_at = ? WHERE id = ?`).run(now(), existing.id);
        }

        const be = kind === "fe" ? this.get(task.id, "be") : undefined;
        if (kind === "fe" && (!be || be.failed_at)) throw new Error(be ? "the BE failed to start — fix or restart it first; the FE command is linked to its URL" : "start the BE first — the FE command is linked to its URL");
        // The FE command needs the BE live from its first second (DualEntry's runs `openapi-ts` against the BE's
        // /api/openapi.json before `next dev`): an FE started while the BE still boots dies with "fetch failed"
        // (INV-132, 2026-09-20). Wait for the BE to listen, within its own start budget.
        if (kind === "fe" && be && !(await portListening(be.port))) {
            const r = await this.waitUntilUp(be);
            if (!r.ok) throw new Error(`the BE is not up (${r.error}) — the FE command needs its URL live`);
        }

        // Optional components have no port (0): nothing to allocate, nothing to probe by socket.
        const port = isCore(kind) ? await this.pickPort(kind, kind === "be" ? env.be_port : env.fe_port, task) : 0;
        try {
            return await this.launch(task, env, kind, port, be);
        } finally {
            if (port) this.reserving.delete(port);
        }
    }

    private async launch(task: TaskRow, env: EnvRow, kind: ServiceKind, port: number, be: ServiceRow | undefined): Promise<ServiceRow> {
        const template = commandTemplate(env, kind);
        if (!template) throw new Error(`env "${env.name}" has no command for service "${kind}"`);
        const urlTemplate = (kind === "be" ? env.be_url_template : env.fe_url_template) ?? "http://localhost:{{port}}";
        const url = port ? render(urlTemplate, { port: String(port) }) : "";
        const vars: Record<string, string> = {
            port: String(port),
            url,
            bePort: be ? String(be.port) : "",
            beUrl: be ? be.url : "",
            worktree: task.worktree_path ?? env.path,
            taskDir: join(this.cfg.dataDir, "tasks", task.id),
        };
        const command = withPrepare(env, render(template, vars));
        const logDir = join(this.cfg.dataDir, "tasks", task.id, "logs");
        mkdirSync(logDir, { recursive: true });
        // Migrations are their own step (migrations.ts): the database is brought up to the worktree's code before the
        // BE starts, so the BE command carries no migrate of its own.
        // Never start an app, or migrate, against a database the env does not allow (db-hosts.ts).
        await assertDbHosts(env, vars.worktree!, taskDbExpect(this.db, task, env));
        if (kind === "be" && env.migrate_command) {
            await runMigration(withPrepare(env, env.migrate_command), { worktree: vars.worktree!, envPath: env.path, vars: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, task.id) }, logPath: join(logDir, "migrate.log"), label: "migrate" });
        }
        const logPath = join(logDir, `${kind}.log`);
        const tmux = serviceSessionName(task.ticket_id, kind);
        const cwd = task.worktree_path ?? env.path;
        // The command may be an && chain; run it in a subshell so its whole stdout+stderr reaches the log. The pane
        // runs in tmux's default shell (the user's — zsh here, where the pipe statuses are `pipestatus[1]`; bash's
        // is `PIPESTATUS[0]`), so both spellings are tried before falling back to tee's own status.
        const wrapped = `cd ${JSON.stringify(cwd)}; echo "[stagehand] ${kind.toUpperCase()} on ${url} · $(date)" | tee -a ${JSON.stringify(logPath)}; ( ${command}
 ) 2>&1 | tee -a ${JSON.stringify(logPath)}; echo "[stagehand] ${kind.toUpperCase()} exited (\${pipestatus[1]:-\${PIPESTATUS[0]:-$?}})" | tee -a ${JSON.stringify(logPath)}; sleep 86400`;
        await ensureSession(tmux, cwd, wrapped, {
            ...parseEnvVars(env.env_vars),
            ...taskDbEnv(this.db, task.id),
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
        // Close the row before the pane goes: the watch probes every 15 s and a pane that is gone while its row is
        // still open reads as "vanished" (a stray notice in Chat, and a needless auto-restart for a running task).
        this.db.prepare(`UPDATE services SET stopped_at = ? WHERE id = ?`).run(now(), row.id);
        const hadSession = await sessionExists(row.tmux);
        await killSessionTree(row.tmux);
        // Only sweep leftover listeners when this service actually owned the port: a process we started, on a port
        // Stagehand chose. On a fixed port (3000/8000-style pins) the listener may be the user's own dev server.
        if (hadSession && row.port > 0 && !this.isFixedPort(row.port)) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
                const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${row.port}`, "-sTCP:LISTEN", "-t"]);
                for (const pid of stdout.trim().split("\n").filter(Boolean)) process.kill(Number(pid), "SIGTERM");
            } catch {
                /* nothing listening */
            }
        }
    }

    async stopAll(taskId: string): Promise<void> {
        // Optional components first (a worker may still be talking to the BE), then the FE, then the BE.
        for (const r of this.list(taskId)) if (!isCore(r.kind)) await this.stop(taskId, r.kind);
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

    // The env another env depends on (its BE is the dependency service); null when none is configured.
    dependencyEnv(env: Pick<EnvRow, "depends_on_env_id">): EnvRow | null {
        if (!env.depends_on_env_id) return null;
        const dep = this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(env.depends_on_env_id) as EnvRow | undefined;
        if (!dep) throw new Error(`dependency env ${env.depends_on_env_id} no longer exists`);
        return dep;
    }

    private dependencyTmux(dep: EnvRow): string {
        return `sh-dep-${dep.id.slice(0, 8)}`;
    }

    private dependencyLog(dep: EnvRow): string {
        return join(this.cfg.dataDir, "envs", dep.id, "dependency-be.log");
    }

    dependencyLogPath(env: EnvRow): string | null {
        const dep = this.dependencyEnv(env);
        return dep ? (this.envServiceRow(dep.id)?.log_path ?? this.dependencyLog(dep)) : null;
    }

    // A row of the dependency, alive or not: listening on its port = running; its pane gone = gone (a host/tmux
    // restart — today's BE that "doesn't work"); its command exited (log marker) or the start budget spent = failed.
    private async dependencyState(row: EnvServiceRow): Promise<{ state: "running" | "starting" | "failed" | "gone"; error: string | null }> {
        if (await portListening(row.port)) return { state: "running", error: null };
        if (!(await sessionExists(row.tmux))) return { state: "gone", error: `its tmux session ${row.tmux} is gone — the host or tmux server restarted, or it was killed by hand` };
        const exited = currentRunLog({ kind: DEPENDENCY_KIND, log_path: row.log_path }).map((l) => exitMarker(DEPENDENCY_KIND).exec(l)).find((m) => m);
        if (exited) return { state: "failed", error: `the dependency's command exited (status ${exited[1]}) without leaving anything listening on port ${row.port}` };
        if (Date.now() - Date.parse(row.started_at) > DEP_START_TIMEOUT_MS) return { state: "failed", error: `nothing is listening on port ${row.port} after ${Math.round(DEP_START_TIMEOUT_MS / 60_000)} min` };
        return { state: "starting", error: null };
    }

    // The dependency as one entry of a task's services list (kind "dependency"), present even when it is not running
    // so the widget and the agents can offer to start it. Null when the env has no dependency. A row whose pane is
    // gone reads as stopped; the row itself stays as the memory of the port it ran on (see launchDependencyNow).
    async dependencyStatus(env: EnvRow, taskId: string): Promise<ServiceStatus | null> {
        const dep = this.dependencyEnv(env);
        if (!dep) return null;
        const row = this.envServiceRow(dep.id);
        let state: ServiceState = "stopped";
        let error: string | null = null;
        if (row) {
            const s = await this.dependencyState(row);
            if (s.state !== "gone") {
                state = s.state;
                error = s.error;
            }
        }
        return {
            id: `dependency:${dep.id}`,
            task_id: taskId,
            kind: DEPENDENCY_KIND,
            port: row?.port ?? dep.be_port ?? 0,
            url: row?.url ?? "",
            tmux: row?.tmux ?? this.dependencyTmux(dep),
            command: row?.command ?? dep.be_command ?? "",
            log_path: row?.log_path ?? this.dependencyLog(dep),
            started_at: row?.started_at ?? "",
            stopped_at: null,
            failed_at: state === "failed" ? now() : null,
            error,
            auto_restart: 0,
            running: state === "running",
            state,
            label: `${dep.name} (shared)`,
            shared: true,
        };
    }

    // Sync approximation for prompt text: a row whose pane is alive counts as running (the agent verifies by curl).
    dependencyLooksRunning(env: EnvRow): boolean {
        const dep = this.dependencyEnv(env);
        const row = dep ? this.envServiceRow(dep.id) : undefined;
        return !!row && sessionExistsSync(row.tmux);
    }

    // Run (App widget, POST …/services/dependency/start): starts it unless it is up or still starting, and returns at
    // once — the widget polls the status; ensureDependency below is the blocking form the stages use.
    async startDependency(env: EnvRow, taskId: string): Promise<ServiceStatus> {
        const dep = this.dependencyEnv(env);
        if (!dep) throw new Error(`env "${env.name}" has no dependency configured`);
        await this.launchDependency(env, dep);
        return (await this.dependencyStatus(env, taskId))!;
    }

    // Stop (…/services/dependency/stop): for every task of the env at once — it is one shared instance.
    async stopDependency(env: EnvRow): Promise<void> {
        const dep = this.dependencyEnv(env);
        if (!dep) return;
        const row = this.envServiceRow(dep.id);
        if (!row) return;
        const hadSession = await sessionExists(row.tmux);
        await killSessionTree(row.tmux);
        // The listener is ours only when our pane was alive: ensureDependency starts on a port that was free, so
        // a listener on it with no pane of ours is the user's own instance — left alone.
        if (hadSession) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
                const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${row.port}`, "-sTCP:LISTEN", "-t"]);
                for (const pid of stdout.trim().split("\n").filter(Boolean)) process.kill(Number(pid), "SIGTERM");
            } catch {
                /* nothing listening */
            }
        }
        // The row stays (its pane is dead, so it reads as stopped): the dependents' worktrees were configured with
        // its URL at setup time, and the next start must land on the same port.
    }

    // Ensures `env`'s configured dependency (another env's BE, e.g. Deal needing Core for auth) is up, starting it
    // once and reusing it for every task afterward — it isn't itself under test, so it never gets its own worktree
    // or a fresh instance per task. Blocks until it listens (or the start budget is spent). Returns null when `env`
    // has no dependency configured.
    async ensureDependency(env: EnvRow): Promise<{ url: string } | null> {
        const dep = this.dependencyEnv(env);
        if (!dep) return null;
        const row = await this.launchDependency(env, dep);
        if (await portListening(row.port)) return { url: row.url };
        if (!(await this.waitForPort(row.port, DEP_START_TIMEOUT_MS))) throw new Error(`dependency "${dep.name}" did not come up on port ${row.port} within ${Math.round(DEP_START_TIMEOUT_MS / 60_000)} min — check ${row.log_path}`);
        return { url: row.url };
    }

    // One start at a time per dependency: two tasks of the env brought up in the same second otherwise both pass the
    // "no live row" test and race on the same tmux session and port.
    private readonly depStarting = new Map<string, Promise<EnvServiceRow>>();

    private launchDependency(env: EnvRow, dep: EnvRow): Promise<EnvServiceRow> {
        const inflight = this.depStarting.get(dep.id);
        if (inflight) return inflight;
        const p = this.launchDependencyNow(env, dep).finally(() => this.depStarting.delete(dep.id));
        this.depStarting.set(dep.id, p);
        return p;
    }

    // The live (running or still starting) row, or a fresh start. Prefers the dependency's own configured port (its
    // app most likely assumes it), then the port the previous row ran on — the dependents' worktrees have that URL
    // baked into their config (Deal's stagehand.cfg → https://localhost:7777), so it is kept through stops and host
    // restarts (2026-09-23: a restart on 19000 left the task's BE calling a dead 7777) — and only then a free one.
    private async launchDependencyNow(env: EnvRow, dep: EnvRow): Promise<EnvServiceRow> {
        if (!dep.be_command) throw new Error(`dependency env "${dep.name}" has no BE command configured`);
        const existing = this.envServiceRow(dep.id);
        if (existing) {
            const s = await this.dependencyState(existing);
            if (s.state === "running" || s.state === "starting") return existing;
            // Failed or gone: tear the pane down (a crashed command's pane still sleeps there) and start over.
            await killSessionTree(existing.tmux);
        }
        let port: number;
        if (dep.be_port && (await portFree(dep.be_port))) port = dep.be_port;
        else if (existing && (await portFree(existing.port))) port = existing.port;
        else port = await this.pickFreePort(Services.DEP_PORT_RANGE);
        const urlTemplate = dep.be_url_template ?? "http://localhost:{{port}}";
        const url = render(urlTemplate, { port: String(port) });
        const command = withPrepare(dep, render(dep.be_command, { port: String(port), url, bePort: "", beUrl: "", worktree: dep.path, taskDir: "" }));
        const logPath = this.dependencyLog(dep);
        mkdirSync(join(this.cfg.dataDir, "envs", dep.id), { recursive: true });
        const tmux = this.dependencyTmux(dep);
        // Same start/exit markers as a task's services (kind DEPENDENCY), so dependencyState reads the log the same way.
        const kind = DEPENDENCY_KIND.toUpperCase();
        const wrapped = `cd ${JSON.stringify(dep.path)}; echo "[stagehand] ${kind} on ${url} · ${dep.name}, for ${env.name} · $(date)" | tee -a ${JSON.stringify(logPath)}; ( ${command}
 ) 2>&1 | tee -a ${JSON.stringify(logPath)}; echo "[stagehand] ${kind} exited (\${pipestatus[1]:-\${PIPESTATUS[0]:-$?}})" | tee -a ${JSON.stringify(logPath)}; sleep 86400`;
        await ensureSession(tmux, dep.path, wrapped, { ...parseEnvVars(dep.env_vars), PORT: String(port), STAGEHAND_PORT: String(port) });
        this.db.prepare(`DELETE FROM env_services WHERE env_id = ?`).run(dep.id);
        this.db
            .prepare(`INSERT INTO env_services (env_id, port, url, tmux, command, log_path, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(dep.id, port, url, tmux, command, logPath, now());
        return this.envServiceRow(dep.id)!;
    }
}
