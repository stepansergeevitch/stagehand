import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BaseChecks, baseChecksOf, worstBaseCheck } from "./base-check.js";
import type { DB, EnvRow } from "./db.js";

const sh = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const commit = (repo: string, file: string, text: string, msg: string): void => {
    writeFileSync(join(repo, file), text);
    sh(repo, ["add", file]);
    sh(repo, ["commit", "-q", "-m", msg]);
};

// origin/dev with a.txt; the task branch `feat` forks from it with its own commit.
const setup = (): { root: string; repo: string } => {
    const root = mkdtempSync(join(tmpdir(), "sh-bc-"));
    const bare = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    const repo = join(root, "repo");
    execFileSync("git", ["clone", "-q", bare, repo]);
    sh(repo, ["checkout", "-q", "-b", "dev"]);
    commit(repo, "a.txt", "a\n", "base");
    sh(repo, ["push", "-q", "origin", "dev"]);
    sh(repo, ["checkout", "-q", "-b", "feat"]);
    commit(repo, "feat.txt", "feat\n", "feat work");
    return { root, repo };
};

// The base moves on origin/dev (a commit made on dev and pushed), the task branch stays where it is.
const advanceBase = (repo: string, file: string, text: string): void => {
    sh(repo, ["checkout", "-q", "dev"]);
    commit(repo, file, text, `base ${file}`);
    sh(repo, ["push", "-q", "origin", "dev"]);
    sh(repo, ["checkout", "-q", "feat"]);
};

const checksIn = (root: string): BaseChecks => {
    const db = new Database(":memory:") as unknown as DB;
    db.exec(`CREATE TABLE base_checks (task_id TEXT NOT NULL, repo TEXT NOT NULL, base TEXT NOT NULL, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY (task_id, repo))`);
    return new BaseChecks(db, join(root, "tmp"));
};
const env = { prepare_command: null } as unknown as EnvRow;
const run = (bc: BaseChecks, repo: string, command = "") => bc.check({ taskId: "t1", env, repo: "", cwd: repo, repoPath: repo, base: "dev", command, vars: {}, fetch: true });

describe("base check", () => {
    it("is up to date when the base is already in the branch", async () => {
        const { root, repo } = setup();
        expect((await run(checksIn(root), repo)).state).toBe("up_to_date");
    });
    it("still runs the check on a branch already on its base, and reports it failing", async () => {
        const { root, repo } = setup();
        const r = await run(checksIn(root), repo, "test ! -f feat.txt");
        expect(r.state).toBe("check_failed");
        expect(r.detail).toContain("already in the branch");
    });
    it("reports the conflicted files when the branch cannot merge with the moved base", async () => {
        const { root, repo } = setup();
        commit(repo, "a.txt", "feat's a\n", "feat edits a");
        advanceBase(repo, "a.txt", "base's a\n");
        const r = await run(checksIn(root), repo);
        expect(r.state).toBe("conflicts");
        expect(r.detail).toContain("a.txt");
    });
    it("runs the check on the merged tree: it sees both sides, and a failure is reported with its output", async () => {
        const { root, repo } = setup();
        advanceBase(repo, "b.txt", "b\n");
        const bc = checksIn(root);
        expect((await run(bc, repo, "test -f feat.txt && test -f b.txt")).state).toBe("clean");
        const failed = await run(bc, repo, "echo leaves conflict; exit 3");
        expect(failed.state).toBe("check_failed");
        expect(failed.detail).toContain("leaves conflict");
    });
    it("keeps the last result while the branch, the base and the command are unchanged", async () => {
        const { root, repo } = setup();
        advanceBase(repo, "b.txt", "b\n");
        const bc = checksIn(root);
        const first = await run(bc, repo, "true");
        expect((await run(bc, repo, "true")).checked_at).toBe(first.checked_at);
        expect(sh(repo, ["worktree", "list"]).split("\n")).toHaveLength(1);
    });
    it("parses the per-repository commands and picks the worst result", () => {
        expect(baseChecksOf(`{"backend":"make check","frontend":"  "}`)).toEqual({ backend: "make check" });
        expect(baseChecksOf("not json")).toEqual({});
        const row = (repo: string, state: "clean" | "conflicts") => ({ task_id: "t", repo, base: "dev", base_sha: "", head_sha: "", command: "", state, detail: "", checked_at: "" });
        expect(worstBaseCheck([row("fe", "clean"), row("be", "conflicts")])?.repo).toBe("be");
    });
});
