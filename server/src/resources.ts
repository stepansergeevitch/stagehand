// Every resource Stagehand starts on the host — a task's BE/FE/component panes, an env's shared dependency, the
// claude runs, task terminals, free-form sessions, login helpers, headless QA browsers, cloned Chrome profiles,
// worktrees — joined with what the OS shows (processes, memory, ports, tmux), judged by a policy, and reaped when the
// policy says so. The Resources page shows the same snapshot. The host has 52 GB; a Next dev server left on a task
// parked at User Review grows past 5 GB, and a tmux-server death used to revive every pane of every old task.
import { killSessionTree } from "./services.js";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { now, type DB, type EnvRow, type EnvServiceRow, type ServiceRow, type SessionRow, type TaskRow } from "./db.js";
import { dirSizeMb, hostMemory, killPid, listeners, processTable, subtree, tmuxSessions, type HostMemory, type Proc, type TmuxSession } from "./host.js";
import { PORT_RANGE } from "./services.js";
import { killSession } from "./tmux.js";

export type ResourceKind = "service" | "dependency" | "run" | "terminal" | "session" | "login" | "browser" | "clone" | "worktree" | "orphan";

export interface ResourceOwner {
    type: "task" | "env" | "session" | "account" | "none";
    id: string | null;
    // Ticket id, env name, session name, account name.
    name: string | null;
    stage?: string | undefined;
    status?: string | undefined;
}

export interface ResourcePolicy {
    verdict: "keep" | "stop";
    reason: string;
    // When the reaper acts (verdict "stop" with a grace period), ISO; null = at once / never.
    dueAt: string | null;
}

export interface Resource {
    // Stable across snapshots: `<kind>:<identity>` (service:<row id>, run:<run id>, tmux:<name>, browser:<state file>, port:<n> …).
    id: string;
    kind: ResourceKind;
    label: string;
    owner: ResourceOwner;
    tmux: string | null;
    pid: number | null;
    port: number | null;
    path: string | null;
    // Sum over the process tree.
    rssMb: number;
    cpuPct: number;
    procs: number;
    // The heaviest process of the tree (what a human recognises: next-server, python, claude).
    top: string | null;
    startedAt: string | null;
    ageMs: number;
    // Since the last sign of use: tmux activity, the task's last update — null when unknown.
    idleMs: number | null;
    diskMb: number | null;
    pinned: boolean;
    policy: ResourcePolicy;
}

export interface ResourceEvent {
    id: number;
    at: string;
    resource_id: string;
    kind: string;
    label: string;
    task_id: string | null;
    action: string;
    reason: string;
    rss_mb: number | null;
}

export interface ResourceSnapshot {
    at: string;
    host: HostMemory & { pressure: "ok" | "warn" | "critical"; pressureReason: string };
    stagehand: { rssMb: number; procs: number; devServerTasks: number; runs: number; browsers: number; terminals: number };
    policies: ResourcePolicies;
    resources: Resource[];
    events: ResourceEvent[];
}

export interface ResourcePolicies {
    enabled: boolean;
    // A parked task (waiting for the human, blocked, idle) keeps its BE/FE this long after its last update.
    idleServiceMinutes: number;
    // A task past Manual QA (PR stages, done, stopped, failed) keeps them this long.
    doneServiceMinutes: number;
    terminalIdleHours: number;
    sessionIdleHours: number;
    loginMinutes: number;
    // A tmux session or a listener in Stagehand's port ranges that no row explains.
    orphanMinutes: number;
    // A service younger than this is never stopped by policy (not even under memory pressure): the human or a stage
    // just started it and a Next dev server needs minutes to come up. Starts by the human are pinned on top of this.
    settleMinutes: number;
    // Task session transcript size that triggers a rotation before the next resumed run (0 = never).
    maxSessionMb: number;
    // How many tasks may hold a BE/FE at once; the longest-parked ones beyond it are stopped.
    maxDevServerTasks: number;
    // Below this much available RAM, or above this much swap, grace periods shrink to PRESSURE_GRACE_MS after the last
    // sign of use and idle terminals go too.
    minAvailableMb: number;
    maxSwapMb: number;
}

// What the engine lends the registry (no import cycle: engine imports nothing from here).
export interface ResourceHooks {
    clones(): Array<{ key: string; taskId: string; slot: string; dir: string; pid: number | null; cdpPort: number }>;
    stopService(taskId: string, kind: string): Promise<void>;
    stopDependency(env: EnvRow): Promise<void>;
    stopBrowser(stateFile: string): Promise<void>;
    releaseClone(key: string): Promise<void>;
    notice(taskId: string, text: string): void;
}

const BROWSER_STAGES = new Set(["qa_baseline", "manual_qa"]);
const AFTER_QA_STAGES = new Set(["pr_creation_review", "pr_waiting", "pr_fix", "pr_green", "pr_approved", "done"]);
const BUSY = new Set(["running", "queued"]);
const CLONES_ROOT = join(process.env["HOME"] ?? "", ".stagehand", "chrome-clones");
const MIN = 60_000;
const HOUR = 3_600_000;
const WORKTREE_SAMPLE_MS = 10 * MIN;
// Under memory pressure a grace period is cut to this, counted from the last sign of use — never to zero: a BE the
// human had just started from the App widget used to be stopped 20 s later, every time (INV-136, 2026-09-24).
const PRESSURE_GRACE_MS = 10 * MIN;
const EVENTS_KEPT = 500;

const inRange = (port: number): boolean => Object.values(PORT_RANGE).some(([lo, hi]) => port >= lo && port <= hi) || (port >= 19000 && port <= 19999) || (port >= 9333 && port <= 9399);

export class Resources {
    private snapshot: ResourceSnapshot | null = null;
    private observing: Promise<ResourceSnapshot> | null = null;
    private timer: NodeJS.Timeout | null = null;
    private readonly worktreeSizes = new Map<string, { mb: number; at: number }>();
    private sizing = false;

    constructor(
        private readonly db: DB,
        private readonly cfg: Config,
        private readonly hooks: ResourceHooks,
    ) {}

    // ---------- lifecycle ----------

    start(intervalMs = 20_000): void {
        void this.observe().then((s) => this.reap(s)).catch((e: unknown) => console.warn(`[resources] ${String((e as Error).message ?? e)}`));
        this.timer = setInterval(() => {
            void this.observe()
                .then((s) => this.reap(s))
                .catch((e: unknown) => console.warn(`[resources] ${String((e as Error).message ?? e)}`));
        }, intervalMs);
        this.timer.unref();
    }

    current(): ResourceSnapshot | null {
        return this.snapshot;
    }

    async refresh(): Promise<ResourceSnapshot> {
        return this.observe();
    }

    // ---------- pins ----------

    pin(resourceId: string, pinned: boolean): void {
        if (pinned) this.db.prepare(`INSERT OR REPLACE INTO resource_pins (resource_id, pinned_at) VALUES (?, ?)`).run(resourceId, now());
        else this.db.prepare(`DELETE FROM resource_pins WHERE resource_id = ?`).run(resourceId);
        if (this.snapshot) for (const r of this.snapshot.resources) if (r.id === resourceId) r.pinned = pinned;
    }

    private pins(): Set<string> {
        // A pin on a service row that has since stopped is spent: drop it so the table does not grow forever.
        this.db.prepare(`DELETE FROM resource_pins WHERE resource_id LIKE 'service:%' AND substr(resource_id, 9) IN (SELECT id FROM services WHERE stopped_at IS NOT NULL)`).run();
        return new Set((this.db.prepare(`SELECT resource_id FROM resource_pins`).all() as Array<{ resource_id: string }>).map((r) => r.resource_id));
    }

    // ---------- events ----------

    private record(r: Pick<Resource, "id" | "kind" | "label" | "owner" | "rssMb">, action: string, reason: string): void {
        this.db.prepare(`INSERT INTO resource_events (at, resource_id, kind, label, task_id, action, reason, rss_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(now(), r.id, r.kind, r.label, r.owner.type === "task" ? r.owner.id : null, action, reason, r.rssMb);
        this.db.prepare(`DELETE FROM resource_events WHERE id NOT IN (SELECT id FROM resource_events ORDER BY id DESC LIMIT ?)`).run(EVENTS_KEPT);
        console.log(`[resources] ${action} ${r.label}${r.owner.name ? ` (${r.owner.name})` : ""}: ${reason}`);
    }

    events(limit = 100): ResourceEvent[] {
        return this.db.prepare(`SELECT * FROM resource_events ORDER BY id DESC LIMIT ?`).all(limit) as ResourceEvent[];
    }

    // ---------- observation ----------

    private async observe(): Promise<ResourceSnapshot> {
        if (this.observing) return this.observing;
        this.observing = this.build().finally(() => (this.observing = null));
        const s = await this.observing;
        this.snapshot = s;
        return s;
    }

    private async build(): Promise<ResourceSnapshot> {
        const [mem, procs, ports, tmux] = await Promise.all([hostMemory(), processTable(), listeners(), tmuxSessions()]);
        const policies = this.cfg.resources;
        const pressure = this.pressureOf(mem, policies);
        const pins = this.pins();
        const tasks = new Map((this.db.prepare(`SELECT * FROM tasks`).all() as TaskRow[]).map((t) => [t.id, t]));
        const envs = new Map((this.db.prepare(`SELECT * FROM envs`).all() as EnvRow[]).map((e) => [e.id, e]));
        const tmuxByName = new Map(tmux.map((s) => [s.name, s]));
        const t0 = Date.now();
        const out: Resource[] = [];
        // Pids already attributed to a resource: the leftovers are candidates for "orphan".
        const claimed = new Set<number>();
        const claimTmux = new Set<string>();

        const tree = (root: number | null | undefined): { rssMb: number; cpuPct: number; procs: number; top: string | null; pids: number[] } => {
            if (!root) return { rssMb: 0, cpuPct: 0, procs: 0, top: null, pids: [] };
            const list = subtree(root, procs);
            const heaviest = [...list].sort((a, b) => b.rssMb - a.rssMb)[0];
            return { rssMb: list.reduce((s, p) => s + p.rssMb, 0), cpuPct: Math.round(list.reduce((s, p) => s + p.cpu, 0) * 10) / 10, procs: list.length, top: heaviest ? heaviest.args.slice(0, 80) : null, pids: list.map((p) => p.pid) };
        };
        const treeOfTmux = (name: string): ReturnType<typeof tree> & { session: TmuxSession | undefined } => {
            const s = tmuxByName.get(name);
            const t = tree(s?.panePids[0]);
            for (const pid of s?.panePids ?? []) if (pid !== s?.panePids[0]) { const extra = tree(pid); t.rssMb += extra.rssMb; t.cpuPct += extra.cpuPct; t.procs += extra.procs; t.pids.push(...extra.pids); }
            return { ...t, session: s };
        };
        const ownerOfTask = (t: TaskRow | undefined, id: string): ResourceOwner => (t ? { type: "task", id: t.id, name: t.ticket_id, stage: t.stage, status: t.status } : { type: "task", id, name: null, status: "deleted" });
        const push = (r: Omit<Resource, "pinned" | "policy" | "ageMs"> & { ageMs?: number }, pids: number[]): Resource => {
            for (const p of pids) claimed.add(p);
            if (r.tmux) claimTmux.add(r.tmux);
            const res: Resource = { ...r, ageMs: r.ageMs ?? (r.startedAt ? Math.max(0, t0 - Date.parse(r.startedAt)) : 0), pinned: pins.has(r.id), policy: { verdict: "keep", reason: "", dueAt: null } };
            res.policy = this.judge(res, tasks, envs, pressure, policies);
            out.push(res);
            return res;
        };

        // 1. Per-task services (BE/FE/components) — rows still open.
        const services = this.db.prepare(`SELECT * FROM services WHERE stopped_at IS NULL`).all() as ServiceRow[];
        for (const row of services) {
            const task = tasks.get(row.task_id);
            const t = treeOfTmux(row.tmux);
            const listening = row.port > 0 ? ports.find((l) => l.port === row.port) : undefined;
            if (listening && !t.pids.includes(listening.pid)) { const extra = tree(listening.pid); t.rssMb += extra.rssMb; t.cpuPct += extra.cpuPct; t.procs += extra.procs; t.pids.push(...extra.pids); if (!t.top) t.top = extra.top; }
            push(
                {
                    id: `service:${row.id}`,
                    kind: "service",
                    label: `${row.kind.toUpperCase()}${row.port > 0 ? ` :${row.port}` : ""}`,
                    owner: ownerOfTask(task, row.task_id),
                    tmux: row.tmux,
                    pid: t.pids[0] ?? null,
                    port: row.port > 0 ? row.port : null,
                    path: row.log_path,
                    rssMb: t.rssMb,
                    cpuPct: t.cpuPct,
                    procs: t.procs,
                    top: t.top,
                    startedAt: row.started_at,
                    // The pane's last output counts as use: a dev server logs every request the human makes in the app.
                    idleMs: task ? Math.max(0, t0 - Math.max(Date.parse(task.updated_at), Date.parse(row.started_at), t.session?.activityAt ?? 0)) : null,
                    diskMb: null,
                },
                t.pids,
            );
        }

        // 2. Env dependency services (one per env, shared).
        for (const dep of this.db.prepare(`SELECT * FROM env_services`).all() as EnvServiceRow[]) {
            const env = envs.get(dep.env_id);
            const t = treeOfTmux(dep.tmux);
            const listening = ports.find((l) => l.port === dep.port);
            if (!t.session && !listening) continue; // a remembered port, nothing running
            if (listening && !t.pids.includes(listening.pid)) { const extra = tree(listening.pid); t.rssMb += extra.rssMb; t.procs += extra.procs; t.pids.push(...extra.pids); if (!t.top) t.top = extra.top; }
            const busy = [...tasks.values()].filter((x) => x.env_id !== dep.env_id && envs.get(x.env_id)?.depends_on_env_id === dep.env_id && BUSY.has(x.status));
            push(
                {
                    id: `dependency:${dep.env_id}`,
                    kind: "dependency",
                    label: `${env?.name ?? "env"} dependency :${dep.port}`,
                    owner: { type: "env", id: dep.env_id, name: env?.name ?? null, status: busy.length ? `used by ${busy.map((x) => x.ticket_id).join(", ")}` : "idle" },
                    tmux: dep.tmux,
                    pid: t.pids[0] ?? null,
                    port: dep.port,
                    path: dep.log_path,
                    rssMb: t.rssMb,
                    cpuPct: t.cpuPct,
                    procs: t.procs,
                    top: t.top,
                    startedAt: dep.started_at,
                    idleMs: busy.length ? 0 : Math.max(0, t0 - Math.max(Date.parse(dep.started_at), ...busy.map((x) => Date.parse(x.updated_at)), ...[...tasks.values()].filter((x) => envs.get(x.env_id)?.depends_on_env_id === dep.env_id).map((x) => Date.parse(x.updated_at)))),
                    diskMb: null,
                },
                t.pids,
            );
        }

        // 3. Claude runs in flight (runs.pid; a pid that is gone shows the run as a ghost until the engine closes it).
        const runs = this.db.prepare(`SELECT r.*, t.ticket_id FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.status = 'running'`).all() as Array<{ id: string; task_id: string; stage: string; kind: string; pid: number | null; started_at: string | null; ticket_id: string | null }>;
        for (const run of runs) {
            const t = tree(run.pid);
            const task = tasks.get(run.task_id);
            push(
                {
                    id: `run:${run.id}`,
                    kind: "run",
                    label: `claude · ${run.stage.replace(/_/g, " ")}${run.kind && run.kind !== "stage" ? ` (${run.kind})` : ""}${t.procs ? "" : " — process gone"}`,
                    owner: ownerOfTask(task, run.task_id),
                    tmux: null,
                    pid: run.pid,
                    port: null,
                    path: null,
                    rssMb: t.rssMb,
                    cpuPct: t.cpuPct,
                    procs: t.procs,
                    top: t.top,
                    startedAt: run.started_at,
                    idleMs: 0,
                    diskMb: null,
                },
                t.pids,
            );
        }

        // 4. Task terminals (sh-<ticket>) and login helpers (sh-login-<account>), by tmux name.
        for (const s of tmux) {
            if (claimTmux.has(s.name)) continue;
            const login = /^sh-login-(.+)$/.exec(s.name);
            if (login) {
                const t = treeOfTmux(s.name);
                push({ id: `tmux:${s.name}`, kind: "login", label: `login helper ${login[1]}`, owner: { type: "account", id: null, name: login[1]! }, tmux: s.name, pid: s.panePids[0] ?? null, port: null, path: null, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: new Date(s.createdAt).toISOString(), idleMs: Math.max(0, t0 - s.activityAt), diskMb: null }, t.pids);
                continue;
            }
            const task = [...tasks.values()].find((x) => `sh-${x.ticket_id.toLowerCase()}` === s.name);
            if (task) {
                const t = treeOfTmux(s.name);
                push({ id: `tmux:${s.name}`, kind: "terminal", label: "task terminal", owner: ownerOfTask(task, task.id), tmux: s.name, pid: s.panePids[0] ?? null, port: null, path: null, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: new Date(s.createdAt).toISOString(), idleMs: Math.max(0, t0 - s.activityAt), diskMb: null }, t.pids);
            }
        }

        // 5. Free-form sessions (sessions table).
        for (const row of this.db.prepare(`SELECT * FROM sessions`).all() as SessionRow[]) {
            const s = tmuxByName.get(row.tmux);
            if (!s || claimTmux.has(row.tmux)) continue;
            const t = treeOfTmux(row.tmux);
            push({ id: `session:${row.id}`, kind: "session", label: `session ${row.name}`, owner: { type: "session", id: row.id, name: row.name, status: envs.get(row.env_id)?.name }, tmux: row.tmux, pid: s.panePids[0] ?? null, port: null, path: row.worktree_path, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: new Date(s.createdAt).toISOString(), idleMs: Math.max(0, t0 - s.activityAt), diskMb: null }, t.pids);
        }

        // 6. gstack headless browsers: one state file per run/shard.
        const tasksDir = join(this.cfg.dataDir, "tasks");
        if (existsSync(tasksDir)) {
            for (const id of readdirSync(tasksDir)) {
                const dir = join(tasksDir, id, "qa", "browser");
                if (!existsSync(dir)) continue;
                for (const slot of readdirSync(dir)) {
                    const f = join(dir, slot, "browse.json");
                    if (!existsSync(f)) continue;
                    let state: { pid?: number; port?: number; startedAt?: string } = {};
                    try {
                        state = JSON.parse(readFileSync(f, "utf8")) as typeof state;
                    } catch {
                        /* unreadable: still a leftover file */
                    }
                    const t = tree(state.pid);
                    const task = tasks.get(id);
                    const running = runs.some((r) => r.task_id === id);
                    push({ id: `browser:${f}`, kind: "browser", label: `gstack browser ${slot}${state.port ? ` :${state.port}` : ""}${t.procs ? "" : " — daemon gone"}`, owner: { ...ownerOfTask(task, id), status: running ? task?.status : `no run · ${task?.status ?? "deleted"}` }, tmux: null, pid: state.pid ?? null, port: state.port ?? null, path: f, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: state.startedAt ?? null, idleMs: null, diskMb: null }, t.pids);
                }
            }
        }

        // 7. Cloned Chrome profiles: the engine's live map, plus leftover directories.
        const liveClones = this.hooks.clones();
        for (const c of liveClones) {
            const t = tree(c.pid);
            const task = tasks.get(c.taskId);
            push({ id: `clone:${c.slot}`, kind: "clone", label: `Chrome copy ${c.slot} (CDP ${c.cdpPort})`, owner: ownerOfTask(task, c.taskId), tmux: null, pid: c.pid, port: c.cdpPort, path: c.dir, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: null, ageMs: 0, idleMs: null, diskMb: null }, t.pids);
        }
        if (existsSync(CLONES_ROOT)) {
            for (const slot of readdirSync(CLONES_ROOT)) {
                if (liveClones.some((c) => c.slot === slot)) continue;
                const dir = join(CLONES_ROOT, slot);
                const chrome = procs.find((p) => p.args.includes(`--user-data-dir=${dir}`));
                const t = tree(chrome?.pid);
                push({ id: `clone:${slot}`, kind: "orphan", label: `leftover Chrome copy ${slot}${t.procs ? " (still running)" : " (directory)"}`, owner: { type: "none", id: null, name: null }, tmux: null, pid: chrome?.pid ?? null, port: null, path: dir, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: null, ageMs: chrome ? chrome.ageS * 1000 : HOUR * 24, idleMs: null, diskMb: null }, t.pids);
            }
        }

        // 8. Worktrees on disk (size sampled slowly; display + the disk tile, never reaped here).
        for (const task of tasks.values()) {
            if (!task.worktree_path || !existsSync(task.worktree_path)) continue;
            const size = this.worktreeSizes.get(task.worktree_path);
            push({ id: `worktree:${task.id}`, kind: "worktree", label: "worktree", owner: ownerOfTask(task, task.id), tmux: null, pid: null, port: null, path: task.worktree_path, rssMb: 0, cpuPct: 0, procs: 0, top: null, startedAt: task.created_at, idleMs: Math.max(0, t0 - Date.parse(task.updated_at)), diskMb: size?.mb ?? null }, []);
        }
        void this.sampleWorktreeSizes([...tasks.values()].map((t) => t.worktree_path).filter((p): p is string => !!p && existsSync(p)));

        // 9. Orphans: Stagehand-named tmux sessions and listeners in Stagehand's port ranges that no row explains.
        for (const s of tmux) {
            if (claimTmux.has(s.name) || !s.name.startsWith("sh-") || s.name.startsWith("sh-dep-")) continue;
            const t = treeOfTmux(s.name);
            push({ id: `tmux:${s.name}`, kind: "orphan", label: `tmux ${s.name} (no task or service row)`, owner: { type: "none", id: null, name: null }, tmux: s.name, pid: s.panePids[0] ?? null, port: null, path: null, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: new Date(s.createdAt).toISOString(), idleMs: Math.max(0, t0 - s.activityAt), diskMb: null }, t.pids);
        }
        for (const l of ports) {
            if (claimed.has(l.pid) || !inRange(l.port)) continue;
            const t = tree(l.pid);
            const root = procs.find((p) => p.pid === l.pid);
            push({ id: `port:${l.port}`, kind: "orphan", label: `listener :${l.port} (no service row)`, owner: { type: "none", id: null, name: null }, tmux: null, pid: l.pid, port: l.port, path: null, rssMb: t.rssMb, cpuPct: t.cpuPct, procs: t.procs, top: t.top, startedAt: null, ageMs: root ? root.ageS * 1000 : 0, idleMs: null, diskMb: null }, t.pids);
        }

        const stagehandPids = new Set(out.flatMap((r) => (r.pid ? [r.pid] : [])));
        const allTree = [...claimed].map((pid) => procs.find((p) => p.pid === pid)).filter((p): p is Proc => !!p);
        const devServerTasks = new Set(out.filter((r) => r.kind === "service" && r.owner.type === "task").map((r) => r.owner.id)).size;
        return {
            at: new Date(t0).toISOString(),
            host: { ...mem, ...pressure },
            stagehand: {
                rssMb: allTree.reduce((s, p) => s + p.rssMb, 0),
                procs: allTree.length,
                devServerTasks,
                runs: out.filter((r) => r.kind === "run" && r.procs > 0).length,
                browsers: out.filter((r) => (r.kind === "browser" || r.kind === "clone") && r.procs > 0).length,
                terminals: out.filter((r) => r.kind === "terminal" || r.kind === "session").length + (stagehandPids.size ? 0 : 0),
            },
            policies,
            resources: out.sort((a, b) => b.rssMb - a.rssMb),
            events: this.events(60),
        };
    }

    private pressureOf(mem: HostMemory, p: ResourcePolicies): { pressure: "ok" | "warn" | "critical"; pressureReason: string } {
        if (mem.swapUsedMb > p.maxSwapMb) return { pressure: "critical", pressureReason: `swap ${Math.round(mem.swapUsedMb / 1024)} GB in use (limit ${Math.round(p.maxSwapMb / 1024)} GB)` };
        if (mem.availableMb < p.minAvailableMb) return { pressure: "critical", pressureReason: `${Math.round(mem.availableMb / 1024)} GB available (floor ${Math.round(p.minAvailableMb / 1024)} GB)` };
        if (mem.swapUsedMb > p.maxSwapMb / 2 || mem.availableMb < p.minAvailableMb * 2) return { pressure: "warn", pressureReason: `swap ${Math.round(mem.swapUsedMb / 1024)} GB, ${Math.round(mem.availableMb / 1024)} GB available` };
        return { pressure: "ok", pressureReason: "" };
    }

    private async sampleWorktreeSizes(paths: string[]): Promise<void> {
        if (this.sizing) return;
        this.sizing = true;
        try {
            for (const p of paths) {
                const cur = this.worktreeSizes.get(p);
                if (cur && Date.now() - cur.at < WORKTREE_SAMPLE_MS) continue;
                this.worktreeSizes.set(p, { mb: await dirSizeMb(p), at: Date.now() });
                if (this.snapshot) for (const r of this.snapshot.resources) if (r.kind === "worktree" && r.path === p) r.diskMb = this.worktreeSizes.get(p)!.mb;
            }
        } finally {
            this.sizing = false;
        }
    }

    // ---------- policy ----------

    // What the reaper does with a resource and why; the same text the page shows. Pinned resources are always kept.
    judge(r: Resource, tasks: Map<string, TaskRow>, envs: Map<string, EnvRow>, pressure: { pressure: "ok" | "warn" | "critical" }, p: ResourcePolicies): ResourcePolicy {
        const keep = (reason: string): ResourcePolicy => ({ verdict: "keep", reason, dueAt: null });
        const stopAfter = (reason: string, sinceMs: number, graceMs: number): ResourcePolicy => {
            const grace = pressure.pressure === "critical" ? Math.min(graceMs, PRESSURE_GRACE_MS) : graceMs;
            const due = sinceMs + grace;
            return { verdict: "stop", reason: grace < graceMs ? `${reason} — memory pressure, grace cut to ${Math.round(grace / MIN)} min` : reason, dueAt: new Date(due).toISOString() };
        };
        if (r.pinned) return keep(r.kind === "service" ? "started by you — stays until you stop it or the task is cleaned up" : "pinned by you");
        if (!p.enabled) return keep("automatic cleanup is off");
        // A fresh start settles first, whatever the pressure: the reaper used to stop a BE the human had started 8 s
        // earlier ("idle 0 min — memory pressure, no grace", 2026-09-24) because the host was swapping on Docker's account.
        if ((r.kind === "service" || r.kind === "dependency") && r.ageMs < p.settleMinutes * MIN) return keep(`started ${Math.max(1, Math.round(r.ageMs / MIN))} min ago — settling in (${p.settleMinutes} min)`);
        const task = r.owner.type === "task" && r.owner.id ? tasks.get(r.owner.id) : undefined;
        const lastTouch = r.startedAt ? Math.max(Date.parse(r.startedAt), task ? Date.parse(task.updated_at) : 0) : Date.now() - r.ageMs;
        switch (r.kind) {
            case "run":
                return keep(r.procs ? "agent run in progress" : "run row still open — the engine closes it");
            case "service": {
                if (!task) return stopAfter("its task no longer exists", Date.now(), 0);
                if (BUSY.has(task.status)) return keep(BROWSER_STAGES.has(task.stage) ? "task runs a browser stage" : "task is running");
                // Counted from the last use (task update, start, or the pane's last output), not only from the start.
                const lastUse = r.idleMs === null ? lastTouch : Math.max(lastTouch, Date.now() - r.idleMs);
                if (["done", "stopped", "failed"].includes(task.status) || AFTER_QA_STAGES.has(task.stage)) return stopAfter(`task is ${task.status === "done" ? "done" : `${task.status} at ${task.stage.replace(/_/g, " ")}`} — no QA left`, lastUse, p.doneServiceMinutes * MIN);
                return stopAfter(`task parked (${task.status.replace(/_/g, " ")} at ${task.stage.replace(/_/g, " ")}), idle ${Math.round((r.idleMs ?? 0) / MIN)} min`, lastUse, p.idleServiceMinutes * MIN);
            }
            case "dependency": {
                const envId = r.owner.id ?? "";
                const users = [...tasks.values()].filter((x) => envs.get(x.env_id)?.depends_on_env_id === envId);
                if (users.some((x) => BUSY.has(x.status))) return keep("a dependent task is running");
                const last = Math.max(Date.parse(r.startedAt ?? "0") || 0, ...users.map((x) => Date.parse(x.updated_at)));
                return stopAfter("no dependent task is running", last, p.idleServiceMinutes * MIN);
            }
            case "terminal": {
                if (!task) return stopAfter("its task no longer exists", Date.now(), 0);
                if (BUSY.has(task.status)) return keep("task is running");
                const idleH = pressure.pressure === "critical" ? 0.5 : p.terminalIdleHours;
                return stopAfter(`idle ${Math.round((r.idleMs ?? 0) / MIN)} min (limit ${idleH} h)`, Date.now() - (r.idleMs ?? 0), idleH * HOUR);
            }
            case "session":
                return stopAfter(`idle ${Math.round((r.idleMs ?? 0) / MIN)} min (limit ${p.sessionIdleHours} h; the session reopens on click)`, Date.now() - (r.idleMs ?? 0), p.sessionIdleHours * HOUR);
            case "login":
                return stopAfter(`login helper older than ${p.loginMinutes} min`, Date.now() - r.ageMs, p.loginMinutes * MIN);
            case "browser": {
                if (task && BUSY.has(task.status) && r.owner.status && !r.owner.status.startsWith("no run")) return keep("its QA run is in progress");
                return stopAfter(r.procs ? "no run drives this daemon" : "state file without a daemon", r.startedAt ? Date.parse(r.startedAt) : Date.now() - r.ageMs, 2 * MIN);
            }
            case "clone":
                return task && BUSY.has(task.status) ? keep("its QA run is in progress") : stopAfter("its task is not running", Date.now(), 0);
            case "worktree":
                return keep("removed by Clean up / Delete");
            case "orphan":
                return stopAfter("nothing in Stagehand owns it", Date.now() - r.ageMs, p.orphanMinutes * MIN);
        }
    }

    // ---------- reaping ----------

    private reaping = false;

    private async reap(s: ResourceSnapshot): Promise<void> {
        if (this.reaping || !s.policies.enabled) return;
        this.reaping = true;
        try {
            const nowMs = Date.now();
            const due = s.resources.filter((r) => r.policy.verdict === "stop" && (!r.policy.dueAt || Date.parse(r.policy.dueAt) <= nowMs));
            for (const r of due) await this.stop(r, r.policy.reason).catch((e: unknown) => console.warn(`[resources] stop ${r.label}: ${String((e as Error).message ?? e)}`));
            // The dev-server cap: beyond it, the longest-parked tasks lose their BE/FE now.
            const byTask = new Map<string, Resource[]>();
            for (const r of s.resources) if (r.kind === "service" && r.owner.type === "task" && r.owner.id && r.policy.verdict !== "keep" && !due.includes(r)) byTask.set(r.owner.id, [...(byTask.get(r.owner.id) ?? []), r]);
            const holders = new Set(s.resources.filter((r) => r.kind === "service" && r.owner.type === "task").map((r) => r.owner.id as string));
            const over = holders.size - s.policies.maxDevServerTasks;
            if (over > 0) {
                const parked = [...byTask.entries()].sort((a, b) => Math.max(...b[1].map((r) => r.idleMs ?? 0)) - Math.max(...a[1].map((r) => r.idleMs ?? 0))).slice(0, over);
                for (const [, rows] of parked) for (const r of rows) await this.stop(r, `${holders.size} tasks hold dev servers, cap ${s.policies.maxDevServerTasks}`).catch(() => undefined);
            }
        } finally {
            this.reaping = false;
        }
    }

    // Stops one resource the way its kind is stopped (the same calls the UI buttons make), and records it.
    async stop(r: Resource, reason: string, by: "policy" | "human" = "policy"): Promise<void> {
        switch (r.kind) {
            case "service": {
                const kind = r.label.split(" ")[0]!.toLowerCase();
                if (r.owner.id) await this.hooks.stopService(r.owner.id, kind);
                if (r.owner.id && by === "policy") this.hooks.notice(r.owner.id, `🧹 Stopped the ${kind.toUpperCase()}${r.port ? ` on :${r.port}` : ""} (${Math.round(r.rssMb)} MB): ${reason}. The next stage that needs the app starts it again; Start in the App widget does too.`);
                break;
            }
            case "dependency": {
                const env = r.owner.id ? (this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(r.owner.id) as EnvRow | undefined) : undefined;
                if (env) await this.hooks.stopDependency(env);
                break;
            }
            case "browser":
                if (r.path) await this.hooks.stopBrowser(r.path);
                break;
            case "clone": {
                const key = this.hooks.clones().find((c) => `clone:${c.slot}` === r.id)?.key;
                if (key) await this.hooks.releaseClone(key);
                break;
            }
            case "terminal":
            case "session":
            case "login":
                if (r.tmux) await killSessionTree(r.tmux);
                if (r.owner.type === "task" && r.owner.id && by === "policy") this.hooks.notice(r.owner.id, `🧹 Closed the task terminal (${Math.round(r.rssMb)} MB): ${reason}. Opening the Terminal tab starts a new one.`);
                break;
            case "orphan":
                if (r.tmux) await killSessionTree(r.tmux);
                else if (r.pid && r.path && r.path.startsWith(CLONES_ROOT)) {
                    killPid(r.pid, "SIGTERM");
                    await new Promise((res) => setTimeout(res, 3_000));
                    killPid(r.pid, "SIGKILL");
                }
                else if (r.pid) killPid(r.pid, "SIGTERM");
                if (r.path && r.path.startsWith(CLONES_ROOT)) rmSync(r.path, { recursive: true, force: true });
                break;
            case "run":
            case "worktree":
                throw new Error(`a ${r.kind} is not stopped from here`);
        }
        this.record(r, by === "human" ? "stopped by you" : "stopped", reason);
        if (this.snapshot) this.snapshot.resources = this.snapshot.resources.filter((x) => x.id !== r.id);
    }

    // Every orphan and every due resource, now (the page's "Clean up" button).
    async sweep(): Promise<number> {
        const s = await this.observe();
        const targets = s.resources.filter((r) => r.kind === "orphan" || (r.policy.verdict === "stop" && r.kind !== "run" && r.kind !== "worktree"));
        let n = 0;
        for (const r of targets) {
            await this.stop(r, r.kind === "orphan" ? "clean up: orphan" : `clean up: ${r.policy.reason}`, "human").then(() => n++).catch(() => undefined);
        }
        return n;
    }
}

export const DEFAULT_POLICIES: ResourcePolicies = {
    enabled: true,
    idleServiceMinutes: 30,
    doneServiceMinutes: 5,
    settleMinutes: 20,
    maxSessionMb: 12,
    terminalIdleHours: 6,
    sessionIdleHours: 12,
    loginMinutes: 30,
    orphanMinutes: 10,
    maxDevServerTasks: 3,
    minAvailableMb: 6144,
    maxSwapMb: 8192,
};

