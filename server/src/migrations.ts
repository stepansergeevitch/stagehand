import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { baseOf, envRepos, loginShellArgs, loginShellEnv, type RepoLayout } from "./git.js";

// Database migrations of an environment, apart from its setup and its BE command: two command templates on the env.
//
//   migrate_command       brings the worktree's database up to its code — before every BE start, after a baseline
//   migrate_down_command  rolls back what the branch added, to the base — on the branch's code, before a baseline
//
// Both run from the worktree, like setup. Templates: {{worktree}}, {{envPath}}, {{baseRef}} (the root repo's base
// commit) and {{baseRef:<dir>}} (a sub-repo's); the same refs as $VORTEX_BASE_REF and $VORTEX_BASE_REF_<DIR>.
//
// The QA baseline runs on base code (BaseCheckout): a task branch with commits or changes is rolled back to the base
// for the pass — migrations down, uncommitted work stashed, each repo checked out at its merge-base — and restored after.
//
// Known gap (docs/shared-databases.md): the tasks of an env share one database, so a task's migrations are visible
// to every other task, and a rollback only touches the migrations this branch added.

const execFileAsync = promisify(execFile);
type Vars = Record<string, string>;

const git = async (cwd: string, args: string[], vars: Vars = {}): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...vars } });
    return stdout.trim();
};

const envKey = (dir: string): string => dir.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export const renderMigration = (template: string, v: { worktree: string; envPath: string; baseRefs: Record<string, string> }): string =>
    template
        .replace(/\{\{worktree\}\}/g, v.worktree)
        .replace(/\{\{envPath\}\}/g, v.envPath)
        .replace(/\{\{baseRef(?::([\w.-]+))?\}\}/g, (_m, dir: string | undefined) => v.baseRefs[dir ?? ""] ?? v.baseRefs[Object.keys(v.baseRefs)[0] ?? ""] ?? "");

const refVars = (baseRefs: Record<string, string>): Vars =>
    Object.fromEntries(Object.entries(baseRefs).map(([dir, sha]) => [dir ? `VORTEX_BASE_REF_${envKey(dir)}` : "VORTEX_BASE_REF", sha]));

// Runs one migration command; the output goes to the log, and a failure throws with its tail.
export const runMigration = async (template: string, opts: { worktree: string; envPath: string; vars: Vars; baseRefs?: Record<string, string>; logPath: string; label: string }): Promise<string> => {
    const baseRefs = opts.baseRefs ?? {};
    const command = renderMigration(template, { worktree: opts.worktree, envPath: opts.envPath, baseRefs });
    mkdirSync(dirname(opts.logPath), { recursive: true });
    appendFileSync(opts.logPath, `\n[vortex] ${opts.label} · ${new Date().toISOString()}\n$ ${command}\n`);
    try {
        const { stdout, stderr } = await execFileAsync("bash", loginShellArgs(command), {
            cwd: opts.worktree,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 15 * 60_000,
            env: loginShellEnv({ ...opts.vars, ...refVars(baseRefs) }),
        });
        const out = `${stdout}${stderr}`;
        appendFileSync(opts.logPath, out);
        return out.trim().slice(-2000);
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        appendFileSync(opts.logPath, `${out}\n[vortex] ${opts.label} FAILED: ${err.message ?? ""}\n`);
        throw new Error(`${opts.label} failed: ${(out.trim() || err.message || "").split("\n").slice(-6).join(" ").slice(-500)}`);
    }
};

// ---------- the QA baseline on base code ----------

export interface BaseRepo {
    dir: string; // "" = the root repo
    path: string;
    branch: string;
    head: string;
    base: string; // the merge-base with the base branch
    stash: string | null; // the label of the stash holding the uncommitted work, if any
}
export interface BaseCheckoutState {
    at: string;
    repos: BaseRepo[];
    migratedDown: boolean;
}

const STASH_LABEL = (taskId: string, dir: string): string => `vortex-baseline-${taskId.slice(0, 8)}${dir ? `-${dir}` : ""}`;

export class BaseCheckout {
    // One switch at a time per task.
    private readonly locks = new Map<string, Promise<unknown>>();

    constructor(private readonly dataDir: string) {}

    private statePath(taskId: string): string {
        return join(this.dataDir, "tasks", taskId, "base-checkout.json");
    }
    state(taskId: string): BaseCheckoutState | null {
        try {
            return JSON.parse(readFileSync(this.statePath(taskId), "utf8")) as BaseCheckoutState;
        } catch {
            return null;
        }
    }
    isOn(taskId: string): boolean {
        return existsSync(this.statePath(taskId));
    }
    private locked<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(taskId) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        this.locks.set(taskId, next.catch(() => undefined));
        return next;
    }

    // The repos of the worktree whose branch differs from the base (commits ahead, or uncommitted changes).
    async changedRepos(layout: RepoLayout, worktree: string, vars: Vars): Promise<BaseRepo[]> {
        const dirs = envRepos(layout).length ? envRepos(layout) : [""];
        const out: BaseRepo[] = [];
        for (const dir of dirs) {
            const path = dir ? join(worktree, dir) : worktree;
            if (!existsSync(path)) continue;
            const baseBranch = baseOf(layout, dir);
            const ref = (await git(path, ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`], vars).catch(() => "")) ? `origin/${baseBranch}` : baseBranch;
            const base = await git(path, ["merge-base", "HEAD", ref], vars);
            const head = await git(path, ["rev-parse", "HEAD"], vars);
            const dirty = (await git(path, ["status", "--porcelain"], vars)).length > 0;
            if (head === base && !dirty) continue;
            out.push({ dir, path, branch: await git(path, ["branch", "--show-current"], vars), head, base, stash: null });
        }
        return out;
    }

    // Switches the worktree to the base: migrations down (on the branch's code), uncommitted work stashed, each changed
    // repo checked out at its merge-base, detached. Nothing is switched when the rollback fails. The caller stops the
    // task's servers first.
    enter(taskId: string, repos: BaseRepo[], m: { downCommand: string | null; worktree: string; envPath: string; vars: Vars; logPath: string }): Promise<BaseCheckoutState> {
        return this.locked(taskId, async () => {
            if (this.isOn(taskId)) return this.state(taskId)!;
            const baseRefs = Object.fromEntries(repos.map((r) => [r.dir, r.base]));
            if (m.downCommand) await runMigration(m.downCommand, { worktree: m.worktree, envPath: m.envPath, vars: m.vars, baseRefs, logPath: m.logPath, label: "migrate down to the base" });
            const state: BaseCheckoutState = { at: new Date().toISOString(), repos: [], migratedDown: !!m.downCommand };
            // Written before the first switch, so a crash half-way is restored at the next start.
            writeFileSync(this.statePath(taskId), JSON.stringify(state, null, 2));
            for (const r of repos) {
                if (!r.branch) throw new Error(`${r.dir || "the worktree"} is not on a branch — cannot switch it to the base and back`);
                const dirty = (await git(r.path, ["status", "--porcelain"], m.vars)).length > 0;
                if (dirty) {
                    const label = STASH_LABEL(taskId, r.dir);
                    await git(r.path, ["stash", "push", "--include-untracked", "-m", label], m.vars);
                    r.stash = label;
                }
                state.repos.push(r);
                writeFileSync(this.statePath(taskId), JSON.stringify(state, null, 2));
                await git(r.path, ["checkout", "--detach", r.base], m.vars);
            }
            return state;
        });
    }

    // Back to the branch: each repo checked out on its branch (what the servers changed on the base is discarded), the
    // stash popped, migrations up. The caller stops the task's servers first. A failure leaves the state file for a retry.
    exit(taskId: string, m: { upCommand: string | null; worktree: string; envPath: string; vars: Vars; logPath: string }): Promise<void> {
        return this.locked(taskId, async () => {
            const state = this.state(taskId);
            if (!state) return;
            for (const r of state.repos) {
                const cur = await git(r.path, ["rev-parse", "HEAD"], m.vars).catch(() => "");
                if (cur !== r.head || (await git(r.path, ["branch", "--show-current"], m.vars).catch(() => "")) !== r.branch) await git(r.path, ["checkout", "--force", r.branch], m.vars);
                if (r.stash) {
                    const list = await git(r.path, ["stash", "list", "--format=%gd %s"], m.vars);
                    const ref = list.split("\n").find((l) => l.endsWith(r.stash!))?.split(" ")[0];
                    if (ref) await git(r.path, ["stash", "pop", ref], m.vars);
                }
            }
            if (m.upCommand) await runMigration(m.upCommand, { worktree: m.worktree, envPath: m.envPath, vars: m.vars, logPath: m.logPath, label: "migrate up after the baseline" });
            rmSync(this.statePath(taskId), { force: true });
        });
    }
}
