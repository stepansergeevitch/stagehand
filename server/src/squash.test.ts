import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recommit } from "./engine.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

describe("recommit (Squash)", () => {
    it("folds consecutive commits into one with the newest tree and keeps later ones intact", () => {
        const cwd = mkdtempSync(join(tmpdir(), "squash-"));
        git(cwd, "init", "-q");
        git(cwd, "config", "user.email", "t@t");
        git(cwd, "config", "user.name", "t");
        const shas: string[] = [];
        for (const n of [1, 2, 3, 4]) {
            writeFileSync(join(cwd, `f${n}.txt`), String(n));
            git(cwd, "add", ".");
            git(cwd, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", `c${n}`);
            shas.push(git(cwd, "rev-parse", "HEAD"));
        }
        const [c1, c2, c3, c4] = shas as [string, string, string, string];
        const env = process.env;
        let parent = recommit(cwd, env, c2, c3, c1, "c2+c3");
        parent = recommit(cwd, env, c4, c4, parent);
        git(cwd, "reset", "-q", "--hard", parent);
        expect(git(cwd, "log", "--format=%s")).toBe("c4\nc2+c3\nc1");
        expect(git(cwd, "rev-parse", "HEAD^{tree}")).toBe(git(cwd, "rev-parse", `${c4}^{tree}`));
        expect(git(cwd, "show", "--name-only", "--format=", "HEAD~1").split("\n").sort()).toEqual(["f2.txt", "f3.txt"]);
    });
});
