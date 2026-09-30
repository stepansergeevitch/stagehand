import { describe, expect, it } from "vitest";
import { designMdProblems } from "./engine.js";

// A proposal in the current template: five sections, bug variant with Root cause, prose in product words and STE
// sentences, a bold lead-in on every bullet.
const CLASSIFICATION = `## Classification
bug — grant money is charged to equity in the returns.

`;
const PROBLEM = `## Problem statement
- **Deal Maple** — a $2M grant funds part of the project cost.
- **Returns tab** — shows an equity IRR of **9 %** instead of **14 %**.
- **Sponsor** — misjudges the deal and can reject it.

`;
const ROOT_CAUSE = `## Root cause
- **Returns calculation** — adds back only loan draws against the project cost.
- **Other sources** — grants, deposits and other funding count as equity outflow.
- **Deal Maple** — the $2M grant becomes a $2M equity outflow in month 6.
- **Failed assumption** — every non-loan source is equity, which is false since grants exist.

`;
const APPROACH = `## Suggested approach
- **Funding sources** — today every non-loan source counts as equity; after the change grants, deposits and other funding form their own bucket.
- **Returns calculation** — credits that bucket back in both the levered and the unlevered cash flow.
- **Deal Maple** — the month-6 equity outflow drops from $2M to $0, and the IRR shows **14 %**.
- **Loan draws** — keep their current treatment.
**Invariant:** total project cost stays equal to the sum of all funding sources.

`;
const TECHNICAL = `## Technical changes
**Summary:** Add \`other_funding_credit\`; credit it in \`net_levered_cash_flow\` and \`net_unlevered_cash_flow\`.

| Layer | File | Symbol | Before | After |
|---|---|---|---|---|
| service | \`common/returns.py\` | \`net_levered_cash_flow\` | \`-cost + loan\` | \`-cost + loan + other\` |

### Tests
| File | Test | Asserts |
|---|---|---|
| \`tests/test_returns.py\` | \`test_grant_credited\` | \`flow[6] == 0\` |

**Run:**

\`\`\`bash
poetry run pytest tests/test_returns.py
\`\`\`
`;

const good = `${CLASSIFICATION}${PROBLEM}${ROOT_CAUSE}${APPROACH}${TECHNICAL}`;

describe("designMdProblems", () => {
    it("accepts the template", () => {
        expect(designMdProblems(good)).toBeNull();
    });
    it("accepts a feature without Root cause and refuses one with it", () => {
        const feature = good.replace("bug — grant money is charged to equity in the returns.", "feature — returns credit grant funding.");
        expect(designMdProblems(feature.replace(ROOT_CAUSE, ""))).toBeNull();
        expect(designMdProblems(feature)).toMatch(/a feature has no Root cause/);
    });
    it("wants every section, and only these", () => {
        expect(designMdProblems(good.replace(PROBLEM, ""))).toMatch(/missing the section "## Problem statement"/);
        expect(designMdProblems(good.replace(ROOT_CAUSE, ""))).toMatch(/missing the section "## Root cause"/);
        expect(designMdProblems(`${good}\n## Risks\n- **X** — y.\n`)).toMatch(/section\(s\) the template does not have: "## risks"/);
        expect(designMdProblems(good.replace("bug — grant", "unclear — grant"))).toMatch(/starts with `bug` or `feature`/);
    });
    it("counts prose only — tables and code are free", () => {
        const bigTable = good.replace("### Tests", `${"| service | `a.py` | `f` | `x` | `y` |\n".repeat(400)}\n### Tests`);
        expect(designMdProblems(bigTable)).toBeNull();
        expect(designMdProblems(good.replace("- **Loan draws** — keep their current treatment.", `- **Loan draws** — keep it.\n${"- **Filler** — one two three four five six seven.\n".repeat(120)}`))).toMatch(/words of prose; the cap is 700/);
    });
    it("caps the prose sections", () => {
        expect(designMdProblems(good.replace(PROBLEM, `## Problem statement\n${"- **Deal** — one two three four five six seven eight.\n".repeat(12)}\n`))).toMatch(/Problem statement section is \d+ words; keep it under 80/);
        expect(designMdProblems(good.replace(ROOT_CAUSE, "## Root cause\n- **Returns** — wrong.\n\n"))).toMatch(/Root cause section is \d+ words — it needs at least 40/);
    });
    it("wants a bold lead-in on every prose bullet", () => {
        expect(designMdProblems(good.replace("- **Loan draws** — keep their current treatment.", "- Loan draws keep their current treatment."))).toMatch(/1 bullet\(s\) in Suggested approach have no bold lead-in/);
    });
    it("wants the Invariant line", () => {
        expect(designMdProblems(good.replace(/^\*\*Invariant:\*\*.*\n/m, ""))).toMatch(/Invariant/);
    });
    it("keeps code out of the prose sections", () => {
        expect(designMdProblems(good.replace("- **Returns calculation** — adds back", "- **Returns calculation** — `common/returns.py:153` adds back"))).toMatch(/Root cause section contains code/);
        expect(designMdProblems(good.replace("- **Deal Maple** — a $2M grant", "- **Deal Maple** — `net_levered_cash_flow` with a $2M grant"))).toMatch(/Problem statement section contains code/);
    });
    it("allows plain product terms in backticks", () => {
        expect(designMdProblems(good.replace("- **Loan draws** — keep their current treatment.", "- **Loan draws** — keep their treatment for `archived` deals."))).toBeNull();
    });
    it("wants Summary, the table and the Tests sub-section in Technical changes", () => {
        expect(designMdProblems(good.replace(/^\*\*Summary:\*\*.*\n/m, ""))).toMatch(/Summary:/);
        expect(designMdProblems(good.replace(/^\| Layer[\s\S]*?\n\n/m, "\n"))).toMatch(/needs the \| Layer/);
        expect(designMdProblems(good.replace(/### Tests[\s\S]*$/, ""))).toMatch(/### Tests/);
        expect(designMdProblems(good.replace(/\*\*Run:\*\*\n\n```bash\n([\s\S]*?)```/, (_m, cmd: string) => `**Run:** \`${cmd.trim()}\``))).toMatch(/fenced/);
    });
    it("enforces STE sentence length and bans filler and hedging", () => {
        const long = "- **Loan draws** — keep the treatment they have today in both of the cash flows that the returns calculation builds for every single deal of the whole organization each month.";
        expect(designMdProblems(good.replace("- **Loan draws** — keep their current treatment.", long))).toMatch(/sentence\(s\) are over 25 words/);
        expect(designMdProblems(good.replace("keep their current treatment", "should keep their current treatment"))).toMatch(/uses "should"/);
        expect(designMdProblems(good.replace("keep their current treatment", "keep a robust treatment"))).toMatch(/uses "robust"/);
    });
    it("refuses provenance remarks and JSON blocks", () => {
        expect(designMdProblems(good.replace("keep their current treatment.", "keep their current treatment, as research found."))).toMatch(/where facts came from/);
        expect(designMdProblems(`${good}\n\`\`\`json\n{}\n\`\`\`\n`)).toMatch(/JSON block/);
    });
    it("wants a Repos line in a multi-repository workspace", () => {
        const repos = ["backend", "frontend"];
        expect(designMdProblems(good, { repos })).toMatch(/Repos: <dir>, <dir>/);
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: backend, frontend"), { repos })).toBeNull();
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: `backend/`"), { repos })).toBeNull();
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: mobile"), { repos })).toMatch(/not repositories of this workspace/);
    });
});
