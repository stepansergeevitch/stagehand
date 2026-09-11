import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

// Branch names may contain "/" (e.g. yourname/inv-1-x); the worktree directory flattens that.
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
    // The root directory is ours, not git's; drop it once it holds nothing but leftovers.
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
};

// ---------- review diff ----------

export interface DiffLine {
    type: "context" | "add" | "del";
    oldNo: number | null;
    newNo: number | null;
    text: string;
}
export interface DiffHunk {
    header: string;
    lines: DiffLine[];
}
export interface DiffFile {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    additions: number;
    deletions: number;
    hunks: DiffHunk[];
    binary: boolean;
}

// Parses `git diff` unified output into files/hunks/lines with both line numbers, for the review UI.
export const parseUnifiedDiff = (raw: string, prefix = ""): DiffFile[] => {
    const files: DiffFile[] = [];
    let file: DiffFile | null = null;
    let hunk: DiffHunk | null = null;
    let oldNo = 0;
    let newNo = 0;
    for (const line of raw.split("\n")) {
        if (line.startsWith("diff --git ")) {
            const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            file = { path: prefix + (m?.[2] ?? line.slice(11)), status: "modified", additions: 0, deletions: 0, hunks: [], binary: false };
            files.push(file);
            hunk = null;
            continue;
        }
        if (!file) continue;
        if (line.startsWith("new file mode")) file.status = "added";
        else if (line.startsWith("deleted file mode")) file.status = "deleted";
        else if (line.startsWith("rename to ")) {
            file.status = "renamed";
            file.path = prefix + line.slice(10);
        } else if (line.startsWith("Binary files")) file.binary = true;
        else if (line.startsWith("@@")) {
            const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            oldNo = Number(m?.[1] ?? 1);
            newNo = Number(m?.[2] ?? 1);
            hunk = { header: line, lines: [] };
            file.hunks.push(hunk);
        } else if (hunk) {
            if (line.startsWith("+")) {
                hunk.lines.push({ type: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
                file.additions++;
            } else if (line.startsWith("-")) {
                hunk.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
                file.deletions++;
            } else if (line.startsWith(" ") || line === "") {
                hunk.lines.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
            }
            // "\ No newline at end of file" and anything else is dropped
        }
    }
    return files;
};

// Everything the task changed versus the base branch, committed or not, including untracked files, per checkout.
const diffOne = async (checkout: string, baseBranch: string, prefix: string, vars: Vars): Promise<DiffFile[]> => {
    // Diff against the commit the branch actually forked from, not the base branch's current tip: once a fetch moves
    // origin/<base> past the fork point, a tip diff shows every upstream commit since then as if the task had changed
    // those files. Two-dot against the merge-base keeps uncommitted work in the diff (three-dot would drop it).
    const base = (await git(checkout, ["merge-base", `origin/${baseBranch}`, "HEAD"], vars).catch(() => "")).trim() || `origin/${baseBranch}`;
    const tracked = await git(checkout, ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--find-renames", base, "--"], vars);
    const files = parseUnifiedDiff(tracked, prefix);
    const untracked = await git(checkout, ["ls-files", "--others", "--exclude-standard"], vars);
    for (const rel of untracked.split("\n").filter(Boolean).slice(0, 50)) {
        // `git diff --no-index` exits 1 when files differ; read the output regardless.
        const raw = await execFileAsync("git", ["-C", checkout, "diff", "--no-color", "--no-index", "--", "/dev/null", rel], {
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, ...vars },
        })
            .then((r) => r.stdout)
            .catch((e: { stdout?: string }) => e.stdout ?? "");
        for (const f of parseUnifiedDiff(raw, prefix)) files.push({ ...f, path: prefix + rel, status: "added" });
    }
    return files;
};

export const worktreeDiff = async (env: RepoLayout, worktree: string, vars: Vars = {}): Promise<DiffFile[]> => {
    const subs = envRepos(env);
    if (subs.length === 0) return diffOne(worktree, env.base_branch, "", vars);
    const all: DiffFile[] = [];
    for (const dir of subs) {
        if (!existsSync(join(worktree, dir))) continue;
        all.push(...(await diffOne(join(worktree, dir), env.base_branch, `${dir}/`, vars)));
    }
    return all;
};

// ---------- per-commit view of the same changes ----------

export interface BranchCommit {
    sha: string;
    short: string;
    subject: string;
    author: string;
    at: string;
    // Sub-repo directory for a multi-repo worktree ("" for a single repo).
    repo: string;
}

// Every checkout the worktree holds, with its path prefix for file names: [dir, prefix] pairs.
const checkoutsOf = (env: RepoLayout, worktree: string): Array<{ checkout: string; prefix: string; repo: string }> => {
    const subs = envRepos(env);
    if (subs.length === 0) return [{ checkout: worktree, prefix: "", repo: "" }];
    return subs.filter((dir) => existsSync(join(worktree, dir))).map((dir) => ({ checkout: join(worktree, dir), prefix: `${dir}/`, repo: dir }));
};

// Commits on the task branch that are not on the base branch, newest first, plus whether anything is uncommitted.
export const branchCommits = async (env: RepoLayout, worktree: string, vars: Vars = {}): Promise<{ commits: BranchCommit[]; uncommitted: boolean }> => {
    const commits: BranchCommit[] = [];
    let uncommitted = false;
    for (const { checkout, repo } of checkoutsOf(env, worktree)) {
        const raw = await git(checkout, ["log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", `origin/${env.base_branch}..HEAD`], vars).catch(() => "");
        for (const line of raw.split("\n").filter(Boolean)) {
            const [sha = "", short = "", subject = "", author = "", at = ""] = line.split("\x1f");
            commits.push({ sha, short, subject, author, at, repo });
        }
        if (!uncommitted) {
            const status = await git(checkout, ["status", "--porcelain"], vars).catch(() => "");
            uncommitted = status.trim() !== "";
        }
    }
    return { commits: commits.sort((a, b) => b.at.localeCompare(a.at)), uncommitted };
};

export interface DiffGroup {
    // "3 commits abc123..def456", "uncommitted changes", or the whole branch.
    label: string;
    shas: string[];
    files: DiffFile[];
}

// What the working tree changed since the last commit (tracked and untracked), per checkout.
const uncommittedDiff = async (env: RepoLayout, worktree: string, vars: Vars): Promise<DiffFile[]> => {
    const all: DiffFile[] = [];
    for (const { checkout, prefix } of checkoutsOf(env, worktree)) {
        const tracked = await git(checkout, ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--find-renames", "HEAD", "--"], vars).catch(() => "");
        all.push(...parseUnifiedDiff(tracked, prefix));
        const untracked = await git(checkout, ["ls-files", "--others", "--exclude-standard"], vars).catch(() => "");
        for (const rel of untracked.split("\n").filter(Boolean).slice(0, 50)) {
            const raw = await execFileAsync("git", ["-C", checkout, "diff", "--no-color", "--no-index", "--", "/dev/null", rel], { maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...vars } })
                .then((r) => r.stdout)
                .catch((e: { stdout?: string }) => e.stdout ?? "");
            for (const f of parseUnifiedDiff(raw, prefix)) all.push({ ...f, path: prefix + rel, status: "added" });
        }
    }
    return all;
};

// The diff of a chosen set of commits. Consecutive commits (in branch order) become one range diff (first^..last); a
// gap starts a new group, so a non-contiguous pick is shown as several diffs rather than one misleading merge.
export const commitsDiff = async (env: RepoLayout, worktree: string, shas: string[], vars: Vars = {}): Promise<DiffGroup[]> => {
    const wanted = new Set(shas);
    const groups: DiffGroup[] = [];
    for (const { checkout, prefix } of checkoutsOf(env, worktree)) {
        // Oldest first, so runs are in history order.
        const ordered = (await git(checkout, ["log", "--reverse", "--format=%H", `origin/${env.base_branch}..HEAD`], vars).catch(() => "")).split("\n").filter(Boolean);
        let run: string[] = [];
        const flush = async (): Promise<void> => {
            if (run.length === 0) return;
            const first = run[0]!;
            const last = run[run.length - 1]!;
            const raw = await git(checkout, ["diff", "--no-color", "--no-ext-diff", "--unified=3", "--find-renames", `${first}^`, last, "--"], vars).catch(() => "");
            groups.push({ label: run.length === 1 ? first.slice(0, 7) : `${run.length} commits ${first.slice(0, 7)}..${last.slice(0, 7)}`, shas: [...run], files: parseUnifiedDiff(raw, prefix) });
            run = [];
        };
        for (const sha of ordered) {
            if (wanted.has(sha)) run.push(sha);
            else await flush();
        }
        await flush();
    }
    return groups;
};

export const uncommittedGroup = async (env: RepoLayout, worktree: string, vars: Vars = {}): Promise<DiffGroup> => ({ label: "uncommitted changes", shas: [], files: await uncommittedDiff(env, worktree, vars) });

// Per-checkout helpers; for a multi-repo worktree pass the sub-repo checkout (<worktree>/<dir>).
export const diffStat = (checkout: string, baseBranch: string): Promise<string> =>
    git(checkout, ["diff", "--stat", `origin/${baseBranch}...HEAD`]);

export const changedFiles = async (checkout: string, baseBranch: string): Promise<string[]> => {
    const out = await git(checkout, ["diff", "--name-only", `origin/${baseBranch}...HEAD`]);
    return out ? out.split("\n") : [];
};

export const commitLog = (checkout: string, baseBranch: string): Promise<string> =>
    git(checkout, ["log", "--oneline", `origin/${baseBranch}..HEAD`]);
