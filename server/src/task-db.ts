// Task databases: every task of an environment gets its own database, copied from a template database the env names
// (CREATE DATABASE … TEMPLATE …) — so one task's migrations, seeds and baseline rollbacks never reach another task
// (INV-149 / INV-155, 2026-10: one task's migration dropped a column the other's code still used). Design:
// docs/db-isolation.md.
//
// Stagehand owns the lifecycle, the names, the variables and the guard; every statement that touches a database is an
// inline command in the env's config (envs.task_db): create, drop, connect (points a worktree's config at a database),
// list (prints the env's task databases and its template, with sizes). Nothing here knows a database engine.
//
// At every task start the template is first brought to the env's base branch: a long-lived template worktree follows
// `origin/<base>`, is connected to the template and migrated forward. Only then is the task's database copied from it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { now, parseEnvVars, type DB, type EnvRow, type TaskRow } from "./db.js";
import { assertDbHosts } from "./db-hosts.js";
import { withPrepare } from "./env-config.js";
import { createWorktree, envRepos, pointBranchAt, runWorktreeSetup, worktreePathFor } from "./git.js";
import { runMigration } from "./migrations.js";

export const TaskDbConfig = z.object({
    enabled: z.boolean().default(false),
    template: z.string().trim().default(""),
    // {{template}} and {{slug}} (the task's ticket id); default `{{template}}_{{slug}}`.
    namePattern: z.string().trim().default(""),
    create: z.string().default(""),
    drop: z.string().default(""),
    connect: z.string().default(""),
    list: z.string().default(""),
    // Databases a worktree may use besides its own (a separate migrations database, …).
    sharedNames: z.array(z.string().trim().min(1)).default([]),
});
export type TaskDbConfig = z.infer<typeof TaskDbConfig>;

export interface TaskDbRow {
    task_id: string;
    env_id: string;
    name: string;
    template: string;
    status: "creating" | "ready" | "failed";
    error: string | null;
    created_at: string;
    updated_at: string;
}

export interface ListedDb {
    name: string;
    sizeMb: number | null;
}

// The branch the template worktree keeps; never pushed, never a task's.
export const TEMPLATE_BRANCH = "stagehand-template";
const LIST_FRESH_MS = 10 * 60_000;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 20_000;

export const taskDbOf = (env: Pick<EnvRow, "task_db">): TaskDbConfig | null => {
    if (!env.task_db) return null;
    try {
        const parsed = TaskDbConfig.safeParse(JSON.parse(env.task_db));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
};

// Complete enough to run: switched on, with a template and the three commands a task needs.
export const taskDbActive = (c: TaskDbConfig | null): c is TaskDbConfig => !!c && c.enabled && !!c.template && !!c.create.trim() && !!c.drop.trim() && !!c.connect.trim();

// A database name from the pattern: lower case, [a-z0-9_] only, at most 63 characters (a 6-character hash keeps a cut
// name unique).
export const taskDbName = (c: Pick<TaskDbConfig, "template" | "namePattern">, slug: string): string => {
    const raw = (c.namePattern || "{{template}}_{{slug}}").replace(/\{\{template\}\}/g, c.template).replace(/\{\{slug\}\}/g, slug);
    const n = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    if (n.length <= 63) return n;
    return `${n.slice(0, 56).replace(/_+$/, "")}_${createHash("sha1").update(raw).digest("hex").slice(0, 6)}`;
};

// `list` output: one database per line, `<name>` or `<name> <size in MB>` (whitespace, tab or `|` between).
export const parseDbList = (out: string): ListedDb[] =>
    out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
            const [name, size] = l.split(/[\s|]+/);
            const mb = size !== undefined ? Number(size) : NaN;
            return { name: name!, sizeMb: Number.isFinite(mb) ? Math.round(mb) : null };
        });

// The databases a task owns among the listed ones: its own, and every one derived from it by a suffix
// (`<name>_<anything>` — test runners' per-worker copies like `<name>_gw0`). A name that is (or derives from) another
// task's database is never this task's, so `app_inv_1` never takes `app_inv_1_2`'s databases.
export const ownedDbNames = (name: string, listed: string[], others: string[]): string[] => {
    const derives = (n: string, base: string): boolean => n.startsWith(`${base}_`);
    const longerOthers = others.filter((o) => o !== name && derives(o, name));
    return [...new Set([name, ...listed.filter((n) => derives(n, name) && !longerOthers.some((o) => n === o || derives(n, o)))])];
};

export const taskDbRow = (db: DB, taskId: string): TaskDbRow | undefined => db.prepare(`SELECT * FROM task_dbs WHERE task_id = ?`).get(taskId) as TaskDbRow | undefined;

// The variables every command of a task gets once its database exists.
export const taskDbEnv = (db: DB, taskId: string): Record<string, string> => {
    const row = taskDbRow(db, taskId);
    return row && row.status === "ready" ? { STAGEHAND_TASK_DB: row.name, STAGEHAND_TASK_DB_TEMPLATE: row.template } : {};
};

// The database names a task's worktree may use (its own plus the shared ones); undefined = the task is not on its own
// database (the env has none, or the task predates them), so only hosts are checked.
export const taskDbExpect = (db: DB, task: Pick<TaskRow, "id">, env: EnvRow): string[] | undefined => {
    const c = taskDbOf(env);
    const row = taskDbRow(db, task.id);
    if (!c || !row || row.status !== "ready") return undefined;
    return [row.name, ...c.sharedNames];
};

// Database names a QA step addresses explicitly (`-d x`, `--dbname=x`, `dbname=x`, `…/x` in a URL): a step naming the
// template would write to it instead of the task's database.
export const namesTemplate = (text: string, template: string): boolean => {
    const t = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:-d\\s*|--dbname[= ]|dbname=|/)["']?${t}["']?(?![\\w])`).test(text);
};

export class TaskDbs {
    private readonly locks = new Map<string, Promise<unknown>>();
    private readonly listed = new Map<string, { at: number; dbs: ListedDb[]; error: string | null }>();
    private readonly listing = new Set<string>();

    constructor(
        private readonly db: DB,
        private readonly dataDir: string,
    ) {}

    // One template refresh / copy / drop at a time per env: the template is migrated and copied by one task at a time,
    // and nothing of Stagehand's is connected to it while it is copied.
    private withLock<T>(envId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(envId) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        this.locks.set(envId, next.catch(() => undefined));
        return next;
    }

    templateWorktree(env: EnvRow): string {
        return worktreePathFor(env.path, TEMPLATE_BRANCH);
    }

    private logPath(env: EnvRow): string {
        const dir = join(this.dataDir, "envs", env.id, "logs");
        mkdirSync(dir, { recursive: true });
        return join(dir, "task-db.log");
    }

    private async run(env: EnvRow, cwd: string, command: string, vars: Record<string, string>): Promise<string> {
        return runWorktreeSetup(cwd, env.path, withPrepare(env, command), { ...parseEnvVars(env.env_vars), ...vars });
    }

    // The template worktree at the env's base branch, connected to the template and migrated forward.
    async refreshTemplate(env: EnvRow, note: (line: string) => void = () => undefined): Promise<void> {
        const c = taskDbOf(env);
        if (!taskDbActive(c)) throw new Error("this environment has no task databases configured");
        const vars = { ...parseEnvVars(env.env_vars), STAGEHAND_TASK_DB: c.template, STAGEHAND_TASK_DB_TEMPLATE: c.template };
        const wt = this.templateWorktree(env);
        if (!existsSync(wt)) {
            note("creating the template worktree");
            await createWorktree({ ...env, base_branches: {} } as EnvRow & { base_branches: Record<string, string> }, TEMPLATE_BRANCH, vars);
            if (env.setup_command) {
                note("running the env's setup in the template worktree");
                await this.run(env, wt, env.setup_command, vars);
            }
        }
        const subs = envRepos(env);
        for (const dir of subs.length ? subs : [""]) await pointBranchAt(dir ? join(wt, dir) : wt, TEMPLATE_BRANCH, env.base_branch, vars);
        await this.run(env, wt, c.connect, vars);
        await assertDbHosts(env, wt, [c.template, ...c.sharedNames]);
        if (env.migrate_command) {
            note(`migrating the template ${c.template} to ${env.base_branch}`);
            await runMigration(withPrepare(env, env.migrate_command), { worktree: wt, envPath: env.path, vars, logPath: this.logPath(env), label: `template ${c.template} migrate to ${env.base_branch}` });
        }
    }

    // The env page's "Refresh template": the same refresh a task start does, under the env's lock.
    refresh(env: EnvRow): Promise<void> {
        return this.withLock(env.id, () => this.refreshTemplate(env));
    }

    // Refreshes the template, then copies it into the task's database (replacing one left by an earlier attempt).
    async create(task: TaskRow, env: EnvRow, note: (line: string) => void = () => undefined): Promise<TaskDbRow> {
        const c = taskDbOf(env);
        if (!taskDbActive(c)) throw new Error("this environment has no task databases configured");
        const name = taskDbName(c, task.ticket_id);
        if (name === c.template) throw new Error(`the name pattern gives the template's own name (${name})`);
        const at = now();
        this.db
            .prepare(`INSERT INTO task_dbs (task_id, env_id, name, template, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, 'creating', NULL, ?, ?) ON CONFLICT(task_id) DO UPDATE SET name = excluded.name, template = excluded.template, status = 'creating', error = NULL, updated_at = excluded.updated_at`)
            .run(task.id, env.id, name, c.template, at, at);
        try {
            await this.withLock(env.id, async () => {
                await this.refreshTemplate(env, note);
                const vars = { STAGEHAND_TASK_DB: name, STAGEHAND_TASK_DB_TEMPLATE: c.template };
                await this.run(env, env.path, c.drop, vars);
                note(`copying ${c.template} into ${name}`);
                for (let attempt = 1; ; attempt++) {
                    try {
                        await this.run(env, env.path, c.create, vars);
                        break;
                    } catch (e) {
                        const msg = String((e as Error).message ?? e);
                        // Postgres: "source database … is being accessed by other users". Someone else holds the template.
                        if (attempt >= BUSY_RETRIES || !/being accessed by other users|is being accessed/i.test(msg)) throw e;
                        note(`the template is in use — retrying in ${BUSY_WAIT_MS / 1000} s (${attempt}/${BUSY_RETRIES - 1})`);
                        await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
                    }
                }
            });
            this.db.prepare(`UPDATE task_dbs SET status = 'ready', error = NULL, created_at = ?, updated_at = ? WHERE task_id = ?`).run(now(), now(), task.id);
            this.listed.delete(env.id);
        } catch (e) {
            const msg = String((e as Error).message ?? e).split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);
            this.db.prepare(`UPDATE task_dbs SET status = 'failed', error = ?, updated_at = ? WHERE task_id = ?`).run(msg, now(), task.id);
            throw new Error(msg);
        }
        return taskDbRow(this.db, task.id)!;
    }

    // Points the task's worktree config at its database.
    async connect(task: TaskRow, env: EnvRow): Promise<void> {
        const c = taskDbOf(env);
        const row = taskDbRow(this.db, task.id);
        if (!c || !row || row.status !== "ready" || !task.worktree_path) return;
        await this.run(env, task.worktree_path, c.connect, { STAGEHAND_TASK_DB: row.name, STAGEHAND_TASK_DB_TEMPLATE: row.template });
    }

    // Drops the task's database and every database derived from it (see ownedDbNames); returns the names dropped.
    async drop(task: Pick<TaskRow, "id">, env: EnvRow): Promise<string[]> {
        const c = taskDbOf(env);
        const row = taskDbRow(this.db, task.id);
        if (!row) return [];
        let names = [row.name];
        if (c?.drop.trim()) {
            const listed = c.list.trim() ? (await this.list(env, true)).dbs.map((d) => d.name) : [];
            const others = this.rows(env.id).filter((r) => r.task_id !== task.id).map((r) => r.name);
            names = ownedDbNames(row.name, listed, others).filter((n) => n !== c.template && n !== row.template);
            await this.withLock(env.id, async () => {
                for (const n of names) await this.run(env, env.path, c.drop, { STAGEHAND_TASK_DB: n, STAGEHAND_TASK_DB_TEMPLATE: row.template });
            });
        }
        this.db.prepare(`DELETE FROM task_dbs WHERE task_id = ?`).run(task.id);
        this.listed.delete(env.id);
        return names;
    }

    // An orphan from the env page: a listed database no task owns. Never the template, never a task's.
    async dropOrphan(env: EnvRow, name: string): Promise<void> {
        const c = taskDbOf(env);
        if (!c?.drop.trim()) throw new Error("this environment has no drop command");
        if (name === c.template) throw new Error("that is the template");
        if (this.rows(env.id).some((r) => r.name === name || name.startsWith(`${r.name}_`))) throw new Error("a task owns that database");
        const listed = (await this.list(env, true)).dbs;
        if (!listed.some((d) => d.name === name)) throw new Error(`${name} is not among the env's listed databases`);
        await this.withLock(env.id, () => this.run(env, env.path, c.drop, { STAGEHAND_TASK_DB: name, STAGEHAND_TASK_DB_TEMPLATE: c.template }));
        this.listed.delete(env.id);
    }

    // The env's `list` output, cached for ten minutes (sizes for the env page and Resources).
    async list(env: EnvRow, force = false): Promise<{ at: number; dbs: ListedDb[]; error: string | null }> {
        const c = taskDbOf(env);
        if (!c?.list.trim()) return { at: Date.now(), dbs: [], error: null };
        const cur = this.listed.get(env.id);
        if (!force && cur && Date.now() - cur.at < LIST_FRESH_MS) return cur;
        let res: { at: number; dbs: ListedDb[]; error: string | null };
        try {
            res = { at: Date.now(), dbs: parseDbList(await this.run(env, env.path, c.list, { STAGEHAND_TASK_DB_TEMPLATE: c.template })), error: null };
        } catch (e) {
            res = { at: Date.now(), dbs: cur?.dbs ?? [], error: String((e as Error).message ?? e).split("\n").slice(-2).join(" ").slice(0, 300) };
        }
        this.listed.set(env.id, res);
        return res;
    }

    // What the last list said, refreshed in the background when stale — for the Resources snapshot, which never waits.
    cachedList(env: EnvRow): { at: number; dbs: ListedDb[]; error: string | null } | null {
        const cur = this.listed.get(env.id) ?? null;
        if ((!cur || Date.now() - cur.at >= LIST_FRESH_MS) && !this.listing.has(env.id)) {
            this.listing.add(env.id);
            void this.list(env, true).finally(() => this.listing.delete(env.id));
        }
        return cur;
    }

    rows(envId?: string): TaskDbRow[] {
        return (envId ? this.db.prepare(`SELECT * FROM task_dbs WHERE env_id = ?`).all(envId) : this.db.prepare(`SELECT * FROM task_dbs`).all()) as TaskDbRow[];
    }
}
