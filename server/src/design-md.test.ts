import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { designMdProblems } from "./engine.js";

const PROPOSED = "## 4. Proposed changes\n- Route the three `get_attachment*` reads through a new `BidAttachmentRepository` so every read goes through one place.\n- Leave the `GlobalVendorBid` read raw: it has no per-org filter to enforce.\n\n";
// A pre-existing proposal from before the Proposed changes section existed, with that section added in front of Change.
const good = readFileSync(`${process.env.HOME}/.stagehand/tasks/1270c4a4-b2f6-46f0-b36e-824a79dd022f/design.md`, "utf8").replace(/^(##\s+(?:\d+[.)]\s*)?Change\b)/m, `${PROPOSED}$1`);

describe("designMdProblems", () => {
    it("accepts the template", () => {
        expect(designMdProblems(good)).toBeNull();
    });
    it("wants a Proposed changes section in plain words", () => {
        expect(designMdProblems(good.replace(PROPOSED, ""))).toMatch(/Proposed changes/);
        expect(designMdProblems(good.replace(PROPOSED, "## 4. Proposed changes\n\n"))).toMatch(/empty/);
        expect(designMdProblems(good.replace(PROPOSED, "## 4. Proposed changes\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"))).toMatch(/table/);
        expect(designMdProblems(good.replace(PROPOSED, `## 4. Proposed changes\n${"word ".repeat(130)}\n\n`))).toMatch(/under 120/);
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
