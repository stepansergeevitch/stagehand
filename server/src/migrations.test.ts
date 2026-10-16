import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BaseCheckout, renderMigration } from "./migrations.js";

const g = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();

const repo = (): { root: string; data: string; base: string } => {
    const root = mkdtempSync(join(tmpdir(), "base-co-"));
    g(root, "init", "-q", "-b", "main");
    g(root, "config", "user.email", "t@t");
    g(root, "config", "user.name", "t");
    writeFileSync(join(root, "app.txt"), "base\n");
    g(root, "add", ".");
    g(root, "commit", "-qm", "base");
    const base = g(root, "rev-parse", "HEAD");
    g(root, "checkout", "-qb", "task");
    writeFileSync(join(root, "app.txt"), "branch\n");
    g(root, "commit", "-qam", "change");
    writeFileSync(join(root, "app.txt"), "branch + uncommitted\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    const data = mkdtempSync(join(tmpdir(), "base-co-data-"));
    mkdirSync(join(data, "tasks", "t1"), { recursive: true });
    return { root, data, base };
};

describe("QA baseline on base code", () => {
    it("renders the base refs", () => {
        expect(renderMigration("down {{baseRef}} {{baseRef:backend}} {{worktree}}", { worktree: "/w", envPath: "/e", baseRefs: { backend: "abc" } })).toBe("down abc abc /w");
    });
    it("switches a changed worktree to its merge-base and restores branch, stash and migrations", async () => {
        const { root, data, base } = repo();
        const bc = new BaseCheckout(data);
        const layout = { path: root, base_branch: "main", repos: null };
        const repos = await bc.changedRepos(layout, root, {});
        expect(repos).toHaveLength(1);
        expect(repos[0]!.base).toBe(base);
        const log = join(data, "migrate.log");
        await bc.enter("t1", repos, { downCommand: "echo down $VORTEX_BASE_REF > down.out", worktree: root, envPath: root, vars: {}, logPath: log });
        expect(bc.isOn("t1")).toBe(true);
        expect(g(root, "rev-parse", "HEAD")).toBe(base);
        expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("base\n");
        expect(existsSync(join(root, "new.txt"))).toBe(false);
        // The down command ran on the branch's code, before the switch — its output file went into the stash.
        writeFileSync(join(root, "app.txt"), "a server wrote this on the base\n");
        await bc.exit("t1", { upCommand: "echo up >> up.out", worktree: root, envPath: root, vars: {}, logPath: log });
        expect(bc.isOn("t1")).toBe(false);
        expect(g(root, "branch", "--show-current")).toBe("task");
        expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("branch + uncommitted\n");
        expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("untracked\n");
        expect(readFileSync(join(root, "down.out"), "utf8")).toBe(`down ${base}\n`);
        expect(readFileSync(join(root, "up.out"), "utf8")).toBe("up\n");
        expect(g(root, "stash", "list")).toBe("");
    });
    it("switches nothing when the rollback fails", async () => {
        const { root, data } = repo();
        const bc = new BaseCheckout(data);
        const repos = await bc.changedRepos({ path: root, base_branch: "main", repos: null }, root, {});
        await expect(bc.enter("t1", repos, { downCommand: "echo irreversible >&2; exit 3", worktree: root, envPath: root, vars: {}, logPath: join(data, "m.log") })).rejects.toThrow(/irreversible/);
        expect(bc.isOn("t1")).toBe(false);
        expect(g(root, "branch", "--show-current")).toBe("task");
        expect(readFileSync(join(root, "app.txt"), "utf8")).toBe("branch + uncommitted\n");
    });
    it("needs no switch when the branch equals the base", async () => {
        const { root, data } = repo();
        g(root, "stash", "-u");
        g(root, "checkout", "-q", "main");
        expect(await new BaseCheckout(data).changedRepos({ path: root, base_branch: "main", repos: null }, root, {})).toEqual([]);
    });
});
