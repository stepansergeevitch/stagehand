import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { withPrepare } from "./env-config.js";
import { baseRefFor, loginShellArgs, loginShellEnv } from "./git.js";
import type { DB, EnvRow } from "./db.js";

const execFileAsync = promisify(execFile);

// The base check: whether a task's branch still goes onto the LATEST base — every repository of the task, checked in
// the background, so a branch that went stale is visible before anyone rebases or merges it (2026-10-14: a
// migration numbered like one the trunk had just added only showed up when CI failed). Per repository: git merges the
// branch with its base in memory (`merge-tree`, the worktree is never touched); a clean merge then runs the env's base
// check command for that repository (envs.base_check — e.g. "no conflicting migration leaves") on a temporary checkout of
// the merged tree. Generic: what to check is the env's config; Vortex only merges, runs and records.

// envs.base_check: JSON {repoDir: command}, "" for a single-repo env. A repository without an entry is only merged.
export const baseChecksOf = (json: string | null | undefined): Record<string, string> => {
    try {
        const v: unknown = json ? JSON.parse(json) : {};
        if (!v || typeof v !== "object" || Array.isArray(v)) return {};
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0));
    } catch {
        return {};
    }
};

// up_to_date: the base is already in the branch. clean: merges without conflicts and the check (if any) passes.
// conflicts: git cannot merge the branch with the base. check_failed: it merges, but the env's check fails on the result.
export type BaseCheckState = "up_to_date" | "clean" | "conflicts" | "check_failed" | "error";

export interface BaseCheckRow {
    task_id: string;
    repo: string;
    base: string;
    base_sha: string;
    head_sha: string;
    command: string;
    state: BaseCheckState;
    detail: string;
    checked_at: string;
}

const WORST: BaseCheckState[] = ["error", "conflicts", "check_failed", "clean", "up_to_date"];
export const worstBaseCheck = (rows: BaseCheckRow[]): BaseCheckRow | null => rows.slice().sort((a, b) => WORST.indexOf(a.state) - WORST.indexOf(b.state))[0] ?? null;

const git = async (cwd: string, args: string[], vars: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
        const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, ...vars }, maxBuffer: 16 * 1024 * 1024 });
        return { code: 0, stdout, stderr };
    } catch (e) {
        const x = e as { code?: number; stdout?: string; stderr?: string; message?: string };
        return { code: typeof x.code === "number" ? x.code : 1, stdout: x.stdout ?? "", stderr: x.stderr ?? x.message ?? "" };
    }
};

const tail = (text: string, lines = 40, chars = 3000): string => text.trim().split("\n").slice(-lines).join("\n").slice(-chars);

export class BaseChecks {
    constructor(
        private readonly db: DB,
        private readonly tmpDir: string,
    ) {}

    rows(taskId: string): BaseCheckRow[] {
        return this.db.prepare(`SELECT * FROM base_checks WHERE task_id = ? ORDER BY repo`).all(taskId) as BaseCheckRow[];
    }

    // One repository of a task: `cwd` is the task's checkout of it, `base` its base branch, `repoPath` the env's own
    // checkout of it (what the command reaches ignored files through: an env file, a virtualenv). Skipped when the branch,
    // the base and the command are what the last check saw, unless `force`.
    async check(o: { taskId: string; env: EnvRow; repo: string; cwd: string; repoPath: string; base: string; command: string; vars: Record<string, string>; fetch: boolean; force?: boolean }): Promise<BaseCheckRow> {
        const { taskId, env, repo, cwd, base, command, vars } = o;
        const save = (r: Omit<BaseCheckRow, "task_id" | "repo" | "base" | "command" | "checked_at">): BaseCheckRow => {
            const row: BaseCheckRow = { task_id: taskId, repo, base, command, checked_at: new Date().toISOString(), ...r };
            this.db
                .prepare(`INSERT OR REPLACE INTO base_checks (task_id, repo, base, base_sha, head_sha, command, state, detail, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(row.task_id, row.repo, row.base, row.base_sha, row.head_sha, row.command, row.state, row.detail, row.checked_at);
            return row;
        };
        if (o.fetch) await git(cwd, ["fetch", "origin", base], vars);
        const ref = await baseRefFor(cwd, base, vars);
        const head = (await git(cwd, ["rev-parse", "HEAD"], vars)).stdout.trim();
        const baseSha = (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], vars)).stdout.trim();
        if (!head || !baseSha) return save({ base_sha: baseSha, head_sha: head, state: "error", detail: `cannot resolve ${!head ? "HEAD" : ref}` });
        const last = this.db.prepare(`SELECT * FROM base_checks WHERE task_id = ? AND repo = ?`).get(taskId, repo) as BaseCheckRow | undefined;
        if (!o.force && last && last.head_sha === head && last.base_sha === baseSha && last.command === command && last.base === base && last.state !== "error") return last;
        // The env's check on a checkout of `commitish`: null when it passes (or there is none).
        const runCheck = async (commitish: string): Promise<{ failed: string } | { error: string } | null> => {
            if (!command.trim()) return null;
            mkdirSync(this.tmpDir, { recursive: true });
            const tmp = join(this.tmpDir, `base-check-${taskId.slice(0, 8)}-${repo || "repo"}-${Date.now()}`);
            try {
                const added = await git(cwd, ["worktree", "add", "--detach", tmp, commitish], vars);
                if (added.code !== 0) return { error: `git worktree add failed: ${tail(added.stderr, 10, 600)}` };
                // {{envPath}} the env's checkout of this repository, {{worktree}} the task's: where the command finds what
                // git does not carry (an env file, a virtualenv, installed packages).
                const rendered = command.replace(/\{\{envPath\}\}/g, o.repoPath).replace(/\{\{worktree\}\}/g, cwd);
                try {
                    await execFileAsync("bash", loginShellArgs(withPrepare(env, rendered)), { cwd: tmp, env: loginShellEnv(vars), timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
                    return null;
                } catch (e) {
                    const x = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
                    const out = `${x.stdout ?? ""}\n${x.stderr ?? ""}`.trim() || x.message || "";
                    return { failed: `${x.killed ? "(timed out after 10 min)\n" : ""}${tail(out)}` };
                }
            } finally {
                await git(cwd, ["worktree", "remove", "--force", tmp], vars);
                rmSync(tmp, { recursive: true, force: true });
            }
        };
        // Already on the latest base: nothing to merge, but the branch itself must still pass — a rebase can leave it
        // broken in exactly the way the check is for (2026-10-14: a merge migration left behind a new leaf).
        if ((await git(cwd, ["merge-base", "--is-ancestor", baseSha, head], vars)).code === 0) {
            const r = await runCheck(head);
            if (r && "error" in r) return save({ base_sha: baseSha, head_sha: head, state: "error", detail: r.error });
            if (r) return save({ base_sha: baseSha, head_sha: head, state: "check_failed", detail: `${ref} is already in the branch, but the base check fails on it:\n${r.failed}` });
            return save({ base_sha: baseSha, head_sha: head, state: "up_to_date", detail: `${ref} is already in the branch${command.trim() ? "; the base check passes" : ""}` });
        }
        // No commits of its own in this repository: the merge is the base itself, nothing of the branch to break.
        if ((await git(cwd, ["merge-base", "--is-ancestor", head, baseSha], vars)).code === 0) return save({ base_sha: baseSha, head_sha: head, state: "clean", detail: `no commits of its own here; fast-forwards to ${ref}` });
        // In memory: exit 0 = clean (stdout: the merged tree), 1 = conflicts (tree, then the conflicted paths).
        const merged = await git(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", head, baseSha], vars);
        if (merged.code === 1) {
            const files = merged.stdout.trim().split("\n").slice(1).filter(Boolean);
            return save({ base_sha: baseSha, head_sha: head, state: "conflicts", detail: `conflicts with ${ref} in ${files.length} file(s):\n${files.join("\n")}` });
        }
        if (merged.code !== 0) return save({ base_sha: baseSha, head_sha: head, state: "error", detail: `git merge-tree failed: ${tail(merged.stderr, 10, 600)}` });
        if (!command.trim()) return save({ base_sha: baseSha, head_sha: head, state: "clean", detail: `merges cleanly with ${ref}` });
        const tree = merged.stdout.trim().split("\n")[0]!;
        const commit = (await git(cwd, ["commit-tree", tree, "-p", head, "-p", baseSha, "-m", "vortex base check"], { GIT_AUTHOR_NAME: "vortex", GIT_AUTHOR_EMAIL: "vortex@localhost", GIT_COMMITTER_NAME: "vortex", GIT_COMMITTER_EMAIL: "vortex@localhost", ...vars })).stdout.trim();
        if (!commit) return save({ base_sha: baseSha, head_sha: head, state: "error", detail: "could not write the merged commit" });
        const r = await runCheck(commit);
        if (r && "error" in r) return save({ base_sha: baseSha, head_sha: head, state: "error", detail: r.error });
        if (r) return save({ base_sha: baseSha, head_sha: head, state: "check_failed", detail: `merges cleanly with ${ref}, but the base check fails:\n${r.failed}` });
        return save({ base_sha: baseSha, head_sha: head, state: "clean", detail: `merges cleanly with ${ref}; the base check passes` });
    }
}
