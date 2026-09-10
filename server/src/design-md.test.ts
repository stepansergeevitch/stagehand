import { describe, expect, it } from "vitest";
import { designMdProblems } from "./engine.js";

// A proposal in the current template (nine sections, bug variant with Root cause).
const ROOT_CAUSE = `## 4. Root cause
- A grant source is stored with \`source_type_id\` whose category is \`GRANT\` (\`source_type_utils.py:55\` \`is_debt_source\` → false, \`is_equity_source\` → false).
- \`common/development.py:301\` \`get_debt_sources_periods\` therefore skips it, so \`SourcesSummary.construction_debt_by_periods\` holds only debt draws and no array exists for the grant at all.
- \`common/returns.py:153\` \`net_levered_cash_flow\` subtracts the full \`project_cost\` and adds back \`construction_loan_draws\` only: the grant-funded spend is left in the outflow, so the equity investor appears to have paid it.
- The same shape repeats in \`land_development/returns.py:272\`; there \`builder_deposit_credit\` (\`:323\`) additionally nets the deposit at exit, so a deposit is charged during construction and credited once at exit — a net double count.
- The code assumed every non-debt source is equity; the \`GRANT\`/\`OTHER\`/\`BUILDER_DEPOSIT\` categories were added to \`SourceTypeCategory\` without a matching period array.
- Adding \`non_equity_non_debt_by_periods\` and adding it back in both cash-flow formulas removes the cause: the outflow the equity holder never funded stops being subtracted from equity.

`;

const PROPOSED = `## 5. Proposed changes
- Add one shared period array for sources that are neither debt nor equity and add it back in both cash-flow formulas.
- Leave the debt-only sizing untouched so LTC does not move.

`;

const good = `## 1. Classification
bug — returns cash flow only adds back Debt draws, understating equity IRR/multiple/profit/ROI.

## 2. How it works today
- \`common/development.py:301\` \`get_debt_sources_periods\` — sums per-period \`amount_to_fund\` for \`is_debt_source\` sources only.
- \`common/returns.py:153\` \`net_levered_cash_flow\` — adds \`construction_loan_draws\` back; \`net_unlevered_cash_flow\` (146) adds nothing back.

\`ProFormaSources.source_type_id\` → \`SourcesSummary.construction_debt_by_periods\` → \`ReturnsCashFlow.construction_loan_draws\` → \`Returns.net_levered_irr\`.

## 3. Problem
- \`SourcesSummary\` has no period array for sources that are neither debt nor equity, so their funding is invisible to both returns engines.

${ROOT_CAUSE}${PROPOSED}## 6. Change
Summary: Add \`SourcesSummary.non_equity_non_debt_by_periods\`; mirror \`non_equity_non_debt_draws\` into both cash-flow classes.

| Layer | File | Symbol | Before | After |
|---|---|---|---|---|
| ast | common/development.py | \`SourcesSummary.non_equity_non_debt_by_periods\` | — | \`get_non_equity_non_debt_periods(sources)\` |

Not changed:
- \`SourcesSummary.construction_debt_by_periods\` — debt-only filter stays, LTC unaffected.

## 7. Risks and edge cases
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
        expect(designMdProblems(good.replace(ROOT_CAUSE, "## 4. Root cause\n- `foo.py:1` `bar` is wrong.\n\n"))).toMatch(/Root cause section is \d+ words/);
        const noAnchor = good.replace(ROOT_CAUSE, `## 4. Root cause\n${"the code does the wrong thing because ".repeat(12)}\n\n`);
        expect(designMdProblems(noAnchor)).toMatch(/names no file or symbol/);
    });
    it("wants a Repos line in a multi-repository workspace", () => {
        const repos = ["backend", "frontend"];
        expect(designMdProblems(good)).toBeNull();
        expect(designMdProblems(good, { repos })).toMatch(/Repos: <dir>, <dir>/);
        const withRepos = good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: backend, frontend");
        expect(designMdProblems(withRepos, { repos })).toBeNull();
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: `backend/`"), { repos })).toBeNull();
        expect(designMdProblems(good.replace(/^(bug — [^\n]+)$/m, "$1\nRepos: mobile"), { repos })).toMatch(/not repositories of this workspace/);
    });
    it("wants a Summary line, actions on risks and a fenced Run block", () => {
        expect(designMdProblems(good.replace(/^Summary:.*\n/m, ""))).toMatch(/Summary:/);
        expect(designMdProblems(good.replace(/→ action: [^→]+→ /, "→ "))).toMatch(/1 bullet\(s\) in Risks/);
        const inlineRun = good.replace(/Run:\n\n```bash\n([\s\S]*?)```/, (_m, cmd: string) => `Run: \`${cmd.trim()}\``);
        expect(designMdProblems(inlineRun)).toMatch(/fenced/);
    });
});
