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
