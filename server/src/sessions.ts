import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import { now, parseEnvVars, type AccountRow, type DB, type EnvRow, type SessionRow } from "./db.js";
import type { Engine } from "./engine.js";
import { authEnv } from "./claude/accounts.js";
import { branchCommits, commitsDiff, createWorktree, removeWorktreeAndBranch, repoPaths, uncommittedGroup, worktreeDiff, type BranchCommit, type DiffFile, type DiffGroup } from "./git.js";
import { ensureSession, killSession, sessionExists } from "./tmux.js";

const execFileAsync = promisify(execFile);

export interface SessionStatus extends SessionRow {
    env_name: string;
    account_name: string | null;
    // The tmux session exists (claude may or may not still be running inside it).
    alive: boolean;
}

export interface SessionDiff {
    base: string;
    filtered: boolean;
    groups: DiffGroup[];
    files: DiffFile[];
}

// Free-form interactive claude sessions, opened from the Sessions page rather than by a task's pipeline. Each one
// picks an env (which fixes the config dir, env vars and checkout) and an AI account; optionally a fresh worktree on
// a branch of the human's choosing. The pane is a tmux session like a task terminal, so the browser tab can come and
// go; claude's session id is chosen up-front so Open can resume the same conversation after the pane was closed.
export class Sessions {
    constructor(
        private readonly db: DB,
        private readonly cfg: Config,
        private readonly engine: Engine,
    ) {}

    private row(id: string): SessionRow {
        const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
        if (!r) throw new Error("session not found");
        return r;
    }

    private env(id: string): EnvRow {
        const row = this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(id) as EnvRow | undefined;
        if (!row) throw new Error(`env ${id} not found`);
        return row;
    }

    private account(id: string | null): AccountRow | undefined {
        return id ? (this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined) : undefined;
    }

    async list(): Promise<SessionStatus[]> {
        const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC`).all() as SessionRow[];
        const out: SessionStatus[] = [];
        for (const r of rows) {
            const env = this.db.prepare(`SELECT name FROM envs WHERE id = ?`).get(r.env_id) as { name: string } | undefined;
            out.push({ ...r, env_name: env?.name ?? "(deleted env)", account_name: this.account(r.account_id)?.name ?? null, alive: await sessionExists(r.tmux) });
        }
        return out;
    }

    // The account that will drive the pane: the one asked for if it can run in the env's config dir, else the env's
    // default, else any usable one. Same rule the task terminal uses.
    private pickAccount(env: EnvRow, wanted: string | null): AccountRow {
        const cd = this.engine.configDirOf(env);
        const usable = this.engine.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === wanted) ?? usable.find((a) => a.id === env.default_account_id) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        if (wanted && acc.id !== wanted) {
            const asked = this.account(wanted);
            throw new Error(`account ${asked?.name ?? wanted} cannot run in config dir ${cd.name} (no token, and its login lives elsewhere) — pick another`);
        }
        return acc;
    }

    async create(body: { envId: string; accountId?: string | null | undefined; model?: string | null | undefined; name?: string | undefined; branch?: string | null | undefined }): Promise<SessionStatus> {
        const env = this.env(body.envId);
        const acc = this.pickAccount(env, body.accountId ?? null);
        const branch = body.branch?.trim() || null;
        if (branch && !/^[\w./-]+$/.test(branch)) throw new Error("branch name: letters, digits, . _ / - only");
        let cwd = env.path;
        let worktree: string | null = null;
        if (branch) {
            const taken = this.db.prepare(`SELECT id FROM sessions WHERE env_id = ? AND branch = ?`).get(env.id, branch) as { id: string } | undefined;
            if (taken) throw new Error(`a session already uses branch ${branch} in this env`);
            const r = await createWorktree(env, branch, parseEnvVars(env.env_vars));
            worktree = r.path;
            cwd = r.path;
        }
        const id = randomUUID();
        const name = body.name?.trim() || (branch ? branch : `${env.name} · ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`);
        this.db
            .prepare(
                `INSERT INTO sessions (id, name, env_id, account_id, model, cwd, worktree_path, branch, claude_session_id, tmux, created_at, opened_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            )
            .run(id, name, env.id, acc.id, body.model?.trim() || null, cwd, worktree, branch, randomUUID(), `sh-session-${id.slice(0, 8)}`, now());
        return this.open(id);
    }

    // Starts (or reattaches to) the pane. First launch: `claude --session-id` — the worktree's setup command runs in
    // the pane first when the session has a fresh worktree, so its output is visible and a failure does not hide the
    // prompt. Later launches: `claude --resume`, the same conversation.
    async open(id: string): Promise<SessionStatus> {
        const s = this.row(id);
        const env = this.env(s.env_id);
        const acc = this.pickAccount(env, s.account_id);
        const cd = this.engine.configDirOf(env);
        if (!existsSync(s.cwd)) throw new Error(`${s.cwd} no longer exists — delete this session`);
        if (!(await sessionExists(s.tmux))) {
            const model = s.model ? ` --model ${JSON.stringify(s.model)}` : "";
            const first = !s.opened_at;
            const setup = first && s.worktree_path && env.setup_command ? `echo '[stagehand] running the env setup command in the new worktree…'; ( ${env.setup_command.replace(/\{\{envPath\}\}/g, env.path).replace(/\{\{worktree\}\}/g, s.worktree_path)} ) || echo '[stagehand] setup command failed — see above; claude starts anyway'; ` : "";
            const claude = first ? `claude --session-id ${s.claude_session_id}${model}` : `claude --resume ${s.claude_session_id}${model}`;
            await ensureSession(
                s.tmux,
                s.cwd,
                `${setup}${claude}; echo; echo '[stagehand] claude exited — Open on the Sessions page starts it again (resuming this conversation); press Enter to close this pane'; read -r`,
                { ...parseEnvVars(env.env_vars), ...authEnv(acc), CLAUDE_CONFIG_DIR: cd.path },
            );
            this.db.prepare(`UPDATE sessions SET opened_at = ? WHERE id = ?`).run(now(), id);
        }
        const list = await this.list();
        return list.find((x) => x.id === id)!;
    }

    async close(id: string): Promise<void> {
        const s = this.row(id);
        await killSession(s.tmux);
    }

    rename(id: string, name: string): SessionRow {
        this.db.prepare(`UPDATE sessions SET name = ? WHERE id = ?`).run(name.trim(), id);
        return this.row(id);
    }

    // Unpushed commits / uncommitted changes in the session's worktree are refused unless forced (the same guard the
    // task clean-up has): a worktree is the only place that work exists.
    async remove(id: string, removeWorktree: boolean, force: boolean): Promise<void> {
        const s = this.row(id);
        await killSession(s.tmux);
        if (removeWorktree && s.worktree_path && s.branch && existsSync(s.worktree_path)) {
            const env = this.env(s.env_id);
            const vars = parseEnvVars(env.env_vars);
            if (!force) {
                const { commits, uncommitted } = await branchCommits(env, s.worktree_path, vars);
                const unpushed: string[] = [];
                for (const checkout of repoPaths({ ...env, path: s.worktree_path })) {
                    if (!existsSync(checkout)) continue;
                    const out = await execFileAsync("git", ["-C", checkout, "log", "--oneline", `@{u}..HEAD`], { env: { ...process.env, ...vars } })
                        .then((r) => r.stdout.trim())
                        .catch(() => (commits.length ? "(no upstream)" : ""));
                    if (out) unpushed.push(out);
                }
                if (uncommitted || unpushed.length) throw new Error(`the worktree on ${s.branch} holds ${[uncommitted ? "uncommitted changes" : null, unpushed.length ? "commits that exist nowhere else" : null].filter(Boolean).join(" and ")} — push or discard them first`);
            }
            await removeWorktreeAndBranch(env, s.worktree_path, s.branch, vars);
        }
        this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    }

    async diff(id: string, filter: { shas: string[] } | { uncommitted: true } | null): Promise<SessionDiff> {
        const s = this.row(id);
        const env = this.env(s.env_id);
        const vars = parseEnvVars(env.env_vars);
        if (!s.worktree_path) {
            const g = await uncommittedGroup(env, env.path, vars);
            return { base: "HEAD", filtered: true, groups: [g], files: g.files };
        }
        if (filter) {
            const groups = "uncommitted" in filter ? [await uncommittedGroup(env, s.worktree_path, vars)] : await commitsDiff(env, s.worktree_path, filter.shas, vars);
            return { base: env.base_branch, filtered: true, groups, files: groups.flatMap((g) => g.files) };
        }
        const files = await worktreeDiff(env, s.worktree_path, vars);
        return { base: env.base_branch, filtered: false, groups: [{ label: `all changes vs origin/${env.base_branch}`, shas: [], files }], files };
    }

    async commits(id: string): Promise<{ commits: BranchCommit[]; uncommitted: boolean }> {
        const s = this.row(id);
        const env = this.env(s.env_id);
        if (!s.worktree_path) {
            const g = await uncommittedGroup(env, env.path, parseEnvVars(env.env_vars));
            return { commits: [], uncommitted: g.files.length > 0 };
        }
        return branchCommits(env, s.worktree_path, parseEnvVars(env.env_vars));
    }
}
