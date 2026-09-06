import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Vars = Record<string, string>;

const git = async (cwd: string, args: string[], vars: Vars = {}): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...vars } });
    return stdout.trim();
};

export const isGitRepo = async (path: string): Promise<boolean> => {
    try {
        await git(path, ["rev-parse", "--show-toplevel"]);
        return true;
    } catch {
        return false;
    }
};

export const currentBranch = (path: string): Promise<string> => git(path, ["branch", "--show-current"]);

// An env is either one git repo at `path`, or a workspace at `path` whose sub-directories `repos` are separate git repos.
export interface RepoLayout {
    path: string;
    base_branch: string;
    repos: string | null;
}

export const envRepos = (env: Pick<RepoLayout, "repos">): string[] => {
    if (!env.repos) return [];
    try {
        const parsed: unknown = JSON.parse(env.repos);
        return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string" && r.length > 0) : [];
    } catch {
        return [];
    }
};

export const isMultiRepo = (env: Pick<RepoLayout, "repos">): boolean => envRepos(env).length > 0;

// Every git checkout that belongs to the env (the env path itself, or each sub-repo) — for validation and repo-path checks.
export const repoPaths = (env: RepoLayout): string[] => {
    const subs = envRepos(env);
    return subs.length ? subs.map((d) => join(env.path, d)) : [env.path];
};

// Branch names may contain "/" (e.g. stepanb/inv-1-x); the worktree directory flattens that.
export const worktreePathFor = (envPath: string, branch: string): string => join(envPath, ".claude", "worktrees", branch.replace(/\//g, "-"));

export interface WorktreeResult {
    path: string;
    reused: boolean;
    existingCommits: number;
}

const createOne = async (repoPath: string, baseBranch: string, branch: string, target: string, vars: Vars): Promise<WorktreeResult> => {
    await git(repoPath, ["fetch", "origin", baseBranch], vars);
    if (existsSync(target)) {
        const log = await git(target, ["log", "--oneline", `origin/${baseBranch}..HEAD`], vars);
        return { path: target, reused: true, existingCommits: log ? log.split("\n").length : 0 };
    }
    const branchExists = (await git(repoPath, ["branch", "--list", branch], vars)) !== "";
    if (branchExists) {
        await git(repoPath, ["worktree", "add", target, branch], vars);
        const log = await git(target, ["log", "--oneline", `origin/${baseBranch}..HEAD`], vars);
        return { path: target, reused: true, existingCommits: log ? log.split("\n").length : 0 };
    }
    await git(repoPath, ["worktree", "add", target, "-b", branch, `origin/${baseBranch}`], vars);
    return { path: target, reused: false, existingCommits: 0 };
};

// Single repo: the worktree is the checkout. Multi-repo: the worktree is a directory holding one checkout per sub-repo
// on the same branch (<root>/backend, <root>/frontend), mirroring the env's layout so commands like `cd backend && …` work unchanged.
export const createWorktree = async (env: RepoLayout, branch: string, vars: Vars = {}): Promise<WorktreeResult> => {
    const root = worktreePathFor(env.path, branch);
    const subs = envRepos(env);
    if (subs.length === 0) return createOne(env.path, env.base_branch, branch, root, vars);
    mkdirSync(root, { recursive: true });
    let reused = false;
    let existingCommits = 0;
    for (const dir of subs) {
        const r = await createOne(join(env.path, dir), env.base_branch, branch, join(root, dir), vars);
        reused = reused || r.reused;
        existingCommits += r.existingCommits;
    }
    return { path: root, reused, existingCommits };
};

// Gitignored runtime files (certs, .env, node_modules) don't come with a worktree; the env's setup command creates them.
export const runWorktreeSetup = async (worktree: string, envPath: string, command: string, vars: Vars = {}): Promise<string> => {
    const rendered = command.replace(/\{\{envPath\}\}/g, envPath).replace(/\{\{worktree\}\}/g, worktree);
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", rendered], {
        cwd: worktree,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 600_000,
        env: { ...process.env, ...vars },
    });
    return (stdout + stderr).trim().slice(-2000);
};

export const removeWorktree = async (repoPath: string, path: string, vars: Vars = {}): Promise<void> => {
    await git(repoPath, ["worktree", "remove", "--force", path], vars);
};

export const removeWorktreeAndBranch = async (env: RepoLayout, path: string, branch: string, vars: Vars = {}): Promise<void> => {
    const subs = envRepos(env);
    if (subs.length === 0) {
        if (existsSync(path)) await removeWorktree(env.path, path, vars);
        await git(env.path, ["branch", "-D", branch], vars);
        return;
    }
    for (const dir of subs) {
        const repoPath = join(env.path, dir);
        const target = join(path, dir);
        if (existsSync(target)) await removeWorktree(repoPath, target, vars).catch(() => undefined);
        await git(repoPath, ["branch", "-D", branch], vars).catch(() => undefined);
    }
};

// Per-checkout helpers; for a multi-repo worktree pass the sub-repo checkout (<worktree>/<dir>).
export const diffStat = (checkout: string, baseBranch: string): Promise<string> =>
    git(checkout, ["diff", "--stat", `origin/${baseBranch}...HEAD`]);

export const changedFiles = async (checkout: string, baseBranch: string): Promise<string[]> => {
    const out = await git(checkout, ["diff", "--name-only", `origin/${baseBranch}...HEAD`]);
    return out ? out.split("\n") : [];
};

export const commitLog = (checkout: string, baseBranch: string): Promise<string> =>
    git(checkout, ["log", "--oneline", `origin/${baseBranch}..HEAD`]);
