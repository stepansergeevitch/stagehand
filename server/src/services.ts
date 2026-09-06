import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { now, type DB, type EnvRow, type ServiceKind, type ServiceRow, type TaskRow } from "./db.js";
import { ensureSession, killSession, sessionExists } from "./tmux.js";

const execFileAsync = promisify(execFile);

const PORT_RANGE: Record<ServiceKind, [number, number]> = { be: [18000, 18999], fe: [13000, 13999] };

const portFree = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const srv = createServer();
        srv.once("error", () => resolve(false));
        srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });

const portListening = async (port: number): Promise<boolean> => {
    try {
        const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
        return stdout.trim() !== "";
    } catch {
        return false;
    }
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
        await ensureSession(tmux, cwd, wrapped, { PORT: String(port), STAGEHAND_PORT: String(port), STAGEHAND_BE_URL: be?.url ?? "", STAGEHAND_BE_PORT: be ? String(be.port) : "" });

        const id = randomUUID();
        this.db
            .prepare(`INSERT INTO services (id, task_id, kind, port, url, tmux, command, log_path, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, task.id, kind, port, url, tmux, command, logPath, now());
        return this.db.prepare(`SELECT * FROM services WHERE id = ?`).get(id) as ServiceRow;
    }

    async stop(taskId: string, kind: ServiceKind): Promise<void> {
        const row = this.get(taskId, kind);
        if (!row) return;
        await killSession(row.tmux);
        try {
            const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${row.port}`, "-sTCP:LISTEN", "-t"]);
            for (const pid of stdout.trim().split("\n").filter(Boolean)) process.kill(Number(pid), "SIGTERM");
        } catch {
            /* nothing listening */
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
}
