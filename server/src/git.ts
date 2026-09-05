import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 });
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

export const worktreePathFor = (envPath: string, branch: string): string => join(envPath, ".claude", "worktrees", branch);

export const createWorktree = async (envPath: string, baseBranch: string, branch: string): Promise<string> => {
    const path = worktreePathFor(envPath, branch);
    if (existsSync(path)) return path;
    await git(envPath, ["fetch", "origin", baseBranch]);
    await git(envPath, ["worktree", "add", path, "-b", branch, `origin/${baseBranch}`]);
    return path;
};

export const removeWorktree = async (envPath: string, path: string): Promise<void> => {
    await git(envPath, ["worktree", "remove", "--force", path]);
};

export const removeWorktreeAndBranch = async (envPath: string, path: string, branch: string): Promise<void> => {
    if (existsSync(path)) await removeWorktree(envPath, path);
    await git(envPath, ["branch", "-D", branch]);
};

export const diffStat = (worktree: string, baseBranch: string): Promise<string> =>
    git(worktree, ["diff", "--stat", `origin/${baseBranch}...HEAD`]);

export const changedFiles = async (worktree: string, baseBranch: string): Promise<string[]> => {
    const out = await git(worktree, ["diff", "--name-only", `origin/${baseBranch}...HEAD`]);
    return out ? out.split("\n") : [];
};

export const commitLog = (worktree: string, baseBranch: string): Promise<string> =>
    git(worktree, ["log", "--oneline", `origin/${baseBranch}..HEAD`]);
