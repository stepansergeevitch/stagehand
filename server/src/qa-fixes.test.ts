import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyApprovedStepFixes, parseStepFixAnswer } from "./qa-fixes.js";

describe("parseStepFixAnswer", () => {
    it("reads the scenario/step reference and strips the option prefix", () => {
        expect(parseStepFixAnswer("S1 step 2 (POST inventory-receipts) 404s. Apply the corrected command below?", "apply corrected command: curl -sS http://localhost:18000/x")).toEqual({
            scenario: "S1",
            kind: "step",
            index: 1,
            command: "curl -sS http://localhost:18000/x",
        });
    });
    it("strips any apply/use/run label up to the first colon and keeps a shell: prefix after it", () => {
        expect(parseStepFixAnswer("S1 teardown 1 — no teardown clears the fixture", "apply corrected teardown: cd backend && poetry run python manage.py shell -c \"x\"")?.command).toBe('cd backend && poetry run python manage.py shell -c "x"');
        expect(parseStepFixAnswer("S2 teardown 1", "Apply this teardown before seeding S2 (run once, org id 6248): PGPASSWORD=p psql -c \"DELETE FROM t\"")?.command).toBe('PGPASSWORD=p psql -c "DELETE FROM t"');
        expect(parseStepFixAnswer("S1 teardown 1", "apply corrected command: shell: cd backend && ./x")?.command).toBe("shell: cd backend && ./x");
        expect(parseStepFixAnswer("S1 seed 1", "psql -c 'a:b'")?.command).toBe("psql -c 'a:b'");
    });
    it("ignores an option that only refers to a command shown elsewhere", () => {
        expect(parseStepFixAnswer("S4 step 2 is wrong", "apply the corrected 2 command above")).toBeNull();
        expect(parseStepFixAnswer("S4 step 2 is wrong", "Apply corrected command (see context)")).toBeNull();
    });
    it("skips a 'keep as written' answer and questions without a step reference", () => {
        expect(parseStepFixAnswer("S2 seed 1 is wrong", "keep the seed as written")).toBeNull();
        // The runner's wording for a seed that does not exist yet: the "add seed N as:" part is not the command.
        expect(parseStepFixAnswer("S1 seed 2", "apply the corrected command: add seed 2 as: shell: cd backend && echo key")?.command).toBe("shell: cd backend && echo key");
        expect(parseStepFixAnswer("Is a list UI in scope?", "yes")).toBeNull();
    });
});

describe("applyApprovedStepFixes", () => {
    it("rewrites the approved step action and seed, keeps a backup, ignores unknown targets", () => {
        const dir = mkdtempSync(join(tmpdir(), "qa-fixes-"));
        const p = join(dir, "design.json");
        writeFileSync(p, JSON.stringify({ qa: [{ id: "S1", seed: ["shell: psql -c 'old'"], steps: [{ action: "curl /public/v3/a", assert: "201" }, { action: "curl /public/v3/b", assert: "201" }] }] }));
        const applied = applyApprovedStepFixes(
            p,
            [
                { id: "q1", text: "S1 step 2 404s. Apply corrected command?" },
                { id: "q2", text: "S1 seed 1 names a missing column. Apply corrected command?" },
                { id: "q3", text: "S9 step 1 does not exist" },
                { id: "q4", text: "S1 step 1 is fine?" },
            ],
            { q1: "apply corrected command: curl http://localhost:18000/public/v3-alpha/b", q2: "psql -c 'new'", q3: "curl x", q4: "keep the step as written" },
        );
        expect(applied).toHaveLength(2);
        const design = JSON.parse(readFileSync(p, "utf8")) as { qa: Array<{ seed: string[]; steps: Array<{ action: string }> }> };
        expect(design.qa[0]!.steps[1]!.action).toBe("curl http://localhost:18000/public/v3-alpha/b");
        expect(design.qa[0]!.steps[0]!.action).toBe("curl /public/v3/a");
        expect(design.qa[0]!.seed[0]).toBe("shell: psql -c 'new'");
    });
});

describe("cutTrailingCommentary", () => {
    it("drops commentary after the closing quote of -c and keeps shell continuations", async () => {
        const { cutTrailingCommentary } = await import("./qa-fixes.js");
        const cmd = `cd backend && poetry run python dualentry/manage.py shell -c "x=1; print(f'a={x}')"`;
        expect(cutTrailingCommentary(`${cmd} (and add the same line to S1 teardown 1, before its Item delete)`)).toBe(cmd);
        expect(cutTrailingCommentary(`${cmd} && echo done`)).toBe(`${cmd} && echo done`);
        expect(cutTrailingCommentary(cmd)).toBe(cmd);
        expect(cutTrailingCommentary("echo hi (no -c here)")).toBe("echo hi (no -c here)");
    });
});

describe("assert and scenario corrections", () => {
    const scenario = () => ({
        id: "S1",
        title: "t",
        kind: "browser",
        url: "/x",
        persona: "default user",
        teardown: [],
        services: [],
        baseline: true,
        exclusive: false,
        seed: ["shell: echo seed"],
        steps: [
            { action: "open the page", assert: "total shows $9,200", shot: false },
            { action: "click save", assert: "toast 'Saved'", shot: true },
        ],
    });

    it("parses an assert correction and applies it to the step's assert only", async () => {
        const { parseStepFixAnswer, applyFixToScenario } = await import("./qa-fixes.js");
        const fix = parseStepFixAnswer("S1 assert 1 is wrong", "apply corrected assert: total shows $9,200 after the discount");
        expect(fix).toEqual({ scenario: "S1", kind: "assert", index: 0, command: "total shows $9,200 after the discount" });
        const r = applyFixToScenario(scenario(), fix!);
        expect(r?.after.steps?.[0]?.assert).toBe("total shows $9,200 after the discount");
        expect(r?.after.steps?.[0]?.action).toBe("open the page");
    });

    it("parses a whole-scenario rewrite as JSON, keeps the id, and rejects non-JSON", async () => {
        const { parseStepFixAnswer, applyFixToScenario } = await import("./qa-fixes.js");
        const next = { ...scenario(), id: "S9", steps: [...scenario().steps, { action: "reload", assert: "total still $9,200", shot: false }] };
        const fix = parseStepFixAnswer("S1 scenario", "apply corrected scenario: ```json\n" + JSON.stringify(next) + "\n```");
        expect(fix?.kind).toBe("scenario");
        const r = applyFixToScenario(scenario(), fix!);
        expect(r?.after.id).toBe("S1");
        expect(r?.after.steps?.length).toBe(3);
        expect(parseStepFixAnswer("S1 scenario", "apply corrected scenario: not json")).toBeNull();
    });

    it("guards: no step removal, seeds must not touch steps, step fixes keep asserts, asserts keep their values", async () => {
        const { guardQaFix } = await import("./qa-fixes.js");
        const s = scenario();
        expect(guardQaFix(s, { ...s, steps: s.steps.slice(0, 1) }, "scenario")).toEqual({ ok: false, reason: "removes 1 step(s)" });
        expect(guardQaFix(s, { ...s, seed: ["shell: echo other"], steps: [{ ...s.steps[0]!, assert: "anything" }, s.steps[1]!] }, "seed").ok).toBe(false);
        expect(guardQaFix(s, { ...s, seed: ["shell: echo other"] }, "seed").ok).toBe(true);
        expect(guardQaFix(s, { ...s, steps: [{ ...s.steps[0]!, action: "open /y" }, s.steps[1]!] }, "step").ok).toBe(true);
        expect(guardQaFix(s, { ...s, steps: [{ ...s.steps[0]!, assert: "page loads" }, s.steps[1]!] }, "step").ok).toBe(false);
        expect(guardQaFix(s, { ...s, steps: [{ ...s.steps[0]!, assert: "the total is visible" }, s.steps[1]!] }, "assert")).toEqual({ ok: false, reason: "step 1: the new assert drops the values the old one checked ($9,200)" });
        expect(guardQaFix(s, { ...s, steps: [{ ...s.steps[0]!, assert: "total shows $9,200.00" }, s.steps[1]!] }, "assert").ok).toBe(true);
        expect(guardQaFix(s, { ...s, steps: [{ ...s.steps[0]!, assert: "ok" }, s.steps[1]!] }, "assert").ok).toBe(false);
    });

    it("picks the proposed option, never the keep option, and reverts a change by scenario id", async () => {
        const { proposedOption, applyQaFixes, revertQaChange } = await import("./qa-fixes.js");
        expect(proposedOption({ options: ["keep the step as written", "apply corrected command: echo 1"] })).toBe("apply corrected command: echo 1");
        expect(proposedOption({ options: ["keep the step as written"] })).toBeUndefined();
        const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = mkdtempSync(join(tmpdir(), "qa-fix-"));
        const path = join(dir, "design.json");
        writeFileSync(path, JSON.stringify({ qa: [scenario()] }));
        const applied = applyQaFixes(path, [{ fix: { scenario: "S1", kind: "seed", index: 0, command: "echo fixed" }, by: "jev", question: "S1 seed 1", jev: { legit: 0.9, weakens: 0.05, kind: "seed_fix" } }]);
        expect(applied.lines).toEqual(["S1 seed 1: replaced with the approved command"]);
        expect(applied.changes[0]?.by).toBe("jev");
        expect((JSON.parse(readFileSync(path, "utf8")) as { qa: Array<{ seed: string[] }> }).qa[0]?.seed).toEqual(["shell: echo fixed"]);
        expect(revertQaChange(path, applied.changes[0]!)).toBe(true);
        expect((JSON.parse(readFileSync(path, "utf8")) as { qa: Array<{ seed: string[] }> }).qa[0]?.seed).toEqual(["shell: echo seed"]);
    });
});

describe("applyFixToScenario — a seed past the end", () => {
    it("appends it, keeping its runner prefix", async () => {
        const { applyFixToScenario } = await import("./qa-fixes.js");
        const s = { id: "S1", title: "t", url: "/", persona: "p", seed: ["shell: echo one"], steps: [{ action: "a", assert: "b", shot: false }] };
        const r = applyFixToScenario(s as never, { scenario: "S1", kind: "seed", index: 1, command: "shell: echo two" });
        expect((r?.after as { seed: string[] }).seed).toEqual(["shell: echo one", "shell: echo two"]);
        expect(r?.line).toBe("S1 seed 2: added the approved command");
    });
});
