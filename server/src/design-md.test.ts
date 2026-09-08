import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { designMdProblems } from "./engine.js";

const good = readFileSync(`${process.env.HOME}/.stagehand/tasks/1270c4a4-b2f6-46f0-b36e-824a79dd022f/design.md`, "utf8");

describe("designMdProblems", () => {
    it("accepts the template", () => {
        expect(designMdProblems(good)).toBeNull();
    });
    it("wants a Summary line, actions on risks and a fenced Run block", () => {
        const noSummary = good.replace(/^Summary:.*\n/m, "");
        expect(designMdProblems(noSummary)).toMatch(/Summary:/);
        const noAction = good.replace(/→ action: [^→]+→ /, "→ ");
        expect(designMdProblems(noAction)).toMatch(/1 bullet\(s\) in Risks/);
        const inlineRun = good.replace(/Run:\n\n```bash\n([\s\S]*?)```/, (_m, cmd: string) => `Run: \`${cmd.trim().replace(/\n/g, " ")}\``);
        expect(designMdProblems(inlineRun)).toMatch(/fenced/);
    });
});
