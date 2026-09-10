import { describe, expect, it } from "vitest";
import { designMdProblems } from "./engine.js";

// A proposal in the current template (nine sections, bug variant with Root cause, prose sections in product words).
const ROOT_CAUSE = `## 4. Root cause
- **Returns calculation** — treats every source that is not a loan as money the equity investor put in.
- **Missing bucket** — grants, "other" sources and builder deposits fund part of the construction spend, but the backend has no bucket for them: only loan draws are added back against the project cost.
- **Effect** — the full project cost is charged to equity while only the loan part is credited back, and the grant-funded spend looks like an equity outflow.
- **Land development** — the builder deposit is additionally credited at the sale, so the same money is charged during construction and credited once at exit — a double count.
- **Why** — the code was written when every non-loan source was an equity source; the newer source categories were added without a matching funding bucket.
- **Why the fix works** — adding one bucket for those sources and crediting it back in both cash flows removes the cause: equity is no longer charged for money it never funded.

`;

const PROPOSED = `## 5. Proposed changes
- Track the funding that comes from grants, other sources and builder deposits as its own bucket in the backend.
- Credit that bucket back in both returns calculations so equity is only charged for what it funded.

`;

const TECHNICAL = `## 6. Technical changes
Summary: Add \`SourcesSummary.non_equity_non_debt_by_periods\`; mirror \`non_equity_non_debt_draws\` into both cash-flow classes.

Flow: \`ProFormaSources.source_type_id\` → \`SourcesSummary.non_equity_non_debt_by_periods\` → \`ReturnsCashFlow.non_equity_non_debt_draws\` → \`Returns.net_levered_irr\`.

- \`common/development.py:301\` \`get_debt_sources_periods\` — sums per-period \`amount_to_fund\` for \`is_debt_source\` sources only.
- \`common/returns.py:153\` \`net_levered_cash_flow\` — adds \`construction_loan_draws\` back; \`net_unlevered_cash_flow\` (146) adds nothing back.

| Layer | File | Symbol | Before | After |
|---|---|---|---|---|
| ast | common/development.py | \`SourcesSummary.non_equity_non_debt_by_periods\` | — | \`get_non_equity_non_debt_periods(sources)\` |

Not changed:
- \`SourcesSummary.construction_debt_by_periods\` — debt-only filter stays, LTC unaffected.

`;

const good = `## 1. Classification
bug — returns cash flow only adds back loan draws, understating equity IRR, multiple, profit and ROI.

## 2. How it works today
- **Pro forma** — lists funding sources of several kinds: loans, equity, grants, other, builder deposits.
- **Returns tab** — subtracts the whole project cost from the equity cash flow and adds loan draws back.
- **Land development** — additionally credits the builder deposit at the sale.

## 3. Problem
- Grant, other and builder-deposit funding is invisible to the returns calculation, so equity IRR and multiple come out too low.

${ROOT_CAUSE}${PROPOSED}${TECHNICAL}## 7. Risks and edge cases
- No such sources → array is \`None\` → \`case()\` default 0 → action: assert unchanged cash flow → covered by \`test_zero_when_absent\`.

## 8. Tests
| File | Test | Asserts |
|---|---|---|
| backend/tests/utils/pro_forma/test_returns.py | test_zero_when_absent | cash flow identical when no such sources |

Run:

\`\`\`bash
uv run pytest backend/tests/utils/pro_forma/test_returns.py -v
\`\`\`

## 9. QA
\`S1\` — Returns tab reflects a Grant source as a non-equity inflow — \`/deals\`
`;

describe("designMdProblems", () => {
    it("accepts the template", () => {
        expect(designMdProblems(good)).toBeNull();
    });
    it("wants a Proposed changes section in plain words", () => {
        expect(designMdProblems(good.replace(PROPOSED, ""))).toMatch(/Proposed changes/);
        expect(designMdProblems(good.replace(PROPOSED, "## 5. Proposed changes\n\n"))).toMatch(/empty/);
        expect(designMdProblems(good.replace(PROPOSED, "## 5. Proposed changes\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"))).toMatch(/table/);
        expect(designMdProblems(good.replace(PROPOSED, `## 5. Proposed changes\n${"word ".repeat(130)}\n\n`))).toMatch(/under 120/);
    });
    it("wants the Root cause / Approach explanation, matching the classification", () => {
        expect(designMdProblems(good.replace(ROOT_CAUSE, ""))).toMatch(/Root cause" or "## Approach/);
        expect(designMdProblems(good.replace("## 4. Root cause", "## 4. Approach"))).toMatch(/a bug needs the section `## 4. Root cause`/);
        expect(designMdProblems(good.replace(/^bug — /m, "feature — "))).toMatch(/a feature needs the section `## 4. Approach`/);
        expect(designMdProblems(good.replace(ROOT_CAUSE, "## 4. Root cause\n- the backend gets it wrong.\n\n"))).toMatch(/Root cause section is \d+ words/);
    });
    it("wants markdown structure in long prose sections", () => {
        const plain = good.replace(ROOT_CAUSE, `## 4. Root cause\n${"The returns calculation treats every source that is not a loan as equity, so grant money looks like an equity outflow. ".repeat(5)}\n\n`);
        expect(designMdProblems(plain)).toMatch(/Root cause section has no bold/);
    });
    it("allows plain product terms in backticks", () => {
        expect(designMdProblems(good.replace("- **Land development** — additionally credits", "- **Land development** — for `archived` deals additionally credits"))).toBeNull();
    });
    it("keeps code out of the prose sections", () => {
        const codey = good.replace("- **Returns tab** — subtracts the whole project cost", "- **Returns tab** — `common/returns.py:153` `net_levered_cash_flow` subtracts the whole project cost");
        expect(designMdProblems(codey)).toMatch(/How it works today section contains code or a file reference/);
        const pathy = good.replace("- Grant, other and builder-deposit funding is invisible", "- FormFields.tsx:23 FROM_LOCATION_FILTERS carry no company_id, so funding is invisible");
        expect(designMdProblems(pathy)).toMatch(/Problem section contains code/);
        const snakey = good.replace(ROOT_CAUSE, `## 4. Root cause\n${"**Backend** — charges equity for money it never funded because net_levered_cash_flow only adds back loan draws. ".repeat(6)}\n\n`);
        expect(designMdProblems(snakey)).toMatch(/Root cause section contains code/);
    });
    it("wants Summary, Flow and the table in Technical changes", () => {
        expect(designMdProblems(good.replace(/^Summary:.*\n/m, ""))).toMatch(/Summary:/);
        expect(designMdProblems(good.replace(/^Flow:.*\n/m, ""))).toMatch(/Flow:/);
        expect(designMdProblems(good.replace(/^\| Layer[\s\S]*?\n\n/m, "\n"))).toMatch(/needs the \| Layer/);
        expect(designMdProblems(good.replace("## 6. Technical changes", "## 6. Edits"))).toMatch(/Technical changes" or "## Change/);
    });
    it("wants a Repos line in a multi-repository workspace", () => {
        const repos = ["backend", "frontend"];
        expect(designMdProblems(good, { repos })).toMatch(/Repos: <dir>, <dir>/);
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: backend, frontend"), { repos })).toBeNull();
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: `backend/`"), { repos })).toBeNull();
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: mobile"), { repos })).toMatch(/not repositories of this workspace/);
    });
    it("wants actions on risks and a fenced Run block", () => {
        expect(designMdProblems(good.replace(/→ action: [^→]+→ /, "→ "))).toMatch(/1 bullet\(s\) in Risks/);
        const inlineRun = good.replace(/Run:\n\n```bash\n([\s\S]*?)```/, (_m, cmd: string) => `Run: \`${cmd.trim()}\``);
        expect(designMdProblems(inlineRun)).toMatch(/fenced/);
    });
});
