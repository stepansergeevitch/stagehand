import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree } from "./git.js";

// Plain, unsigned commits regardless of the developer's global git config (commit.gpgsign would need a key here).
const sh = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

// A repo with a pushed `dev`, plus a local-only `feat-a` (another task's unpushed branch) one commit ahead of it.
const setup = (): { repo: string; featSha: string } => {
    const root = mkdtempSync(join(tmpdir(), "sh-wt-"));
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const repo = join(root, "repo");
    execFileSync("git", ["clone", "-q", bare, repo]);
    sh(repo, ["checkout", "-q", "-b", "dev"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, ["add", "a.txt"]);
    sh(repo, ["commit", "-q", "-m", "dev base"]);
    sh(repo, ["push", "-q", "origin", "dev"]);
    sh(repo, ["checkout", "-q", "-b", "feat-a"]);
    writeFileSync(join(repo, "b.txt"), "b\n");
    sh(repo, ["add", "b.txt"]);
    sh(repo, ["commit", "-q", "-m", "feat-a work"]);
    const featSha = sh(repo, ["rev-parse", "HEAD"]);
    sh(repo, ["checkout", "-q", "dev"]);
    return { repo, featSha };
};

describe("createWorktree base branch", () => {
    it("starts from origin/<base> when the base is on the remote", async () => {
        const { repo } = setup();
        const wt = await createWorktree({ path: repo, base_branch: "dev", repos: null }, "task-1");
        expect(sh(wt.path, ["rev-parse", "HEAD"])).toBe(sh(repo, ["rev-parse", "origin/dev"]));
    });
    it("falls back to a local-only base branch (a stacked task on an unpushed branch)", async () => {
        const { repo, featSha } = setup();
        const wt = await createWorktree({ path: repo, base_branch: "feat-a", repos: null }, "task-2");
        expect(sh(wt.path, ["rev-parse", "HEAD"])).toBe(featSha);
        expect(sh(wt.path, ["log", "--oneline", "origin/dev..HEAD"])).toMatch(/feat-a work/);
    });
    it("names a base that exists nowhere", async () => {
        const { repo } = setup();
        await expect(createWorktree({ path: repo, base_branch: "nope", repos: null }, "task-3")).rejects.toThrow(/base branch "nope" exists neither on origin nor locally/);
    });
});
