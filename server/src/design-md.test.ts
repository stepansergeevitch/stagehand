import { describe, expect, it } from "vitest";
import { designMdProblems } from "./engine.js";

// A proposal in the current template (thirteen sections, bug variant with Root cause, prose sections in product words,
// evidence citations resolving to the Evidence table).
const DECISION = `## 1. Decision
**Problem:** a deal funded by a $2M grant shows an equity IRR far below the real one, so the sponsor misjudges the deal.
**Recommendation:** track grant, other and builder-deposit funding as its own bucket and credit it back in both returns cash flows.
**Decisive insight:** only loan draws are ever added back against project cost, so every other non-equity source is charged to equity [E1].
**Price:** one more bucket to keep in step across both cash-flow variants; the returns team owns it.
**Decision requested:** accept that grant-funded spend is not an equity outflow, in both the levered and unlevered cash flows.
**Open blocker:** none

`;

const TODAY = `## 2. Classification
bug — returns cash flow only adds back loan draws, understating equity IRR, multiple, profit and ROI.

## 3. How it works today
- **Pro forma** — lists funding sources of several kinds: loans, equity, grants, other, builder deposits.
- **Returns tab** — subtracts the whole project cost from the equity cash flow and adds loan draws back.
- **Land development** — additionally credits the builder deposit at the sale.
**Invariant:** the levered and unlevered cash flows differ only by debt draws and debt service.

`;

const ROOT_CAUSE = `## 4. Root cause
### What happens
- **Returns calculation** — treats every source that is not a loan as money the equity investor put in [E1].
- **Missing bucket** — grants, "other" sources and builder deposits fund part of the construction spend, but the backend has no bucket for them: only loan draws are added back against the project cost [E2].
### Why
- **Effect** — the full project cost is charged to equity while only the loan part is credited back, and the grant-funded spend looks like an equity outflow.
- **Why** — the code was written when every non-loan source was an equity source; the newer source categories were added without a matching funding bucket [A1].
### Worked case
| Step | Actor and action | Today | After the change | Why this step |
|---|---|---|---|---|
| 1 | Sponsor adds a $2M grant to deal Maple | grant stored as a source | same | funding sources are the input |
| 2 | Returns tab computes month 6 equity flow | **-$3M cost, +$1M loan draw = -$2M** | **-$3M cost, +$1M loan, +$2M grant = $0** | the add-back is where the bucket is missing |
| 3 | IRR over the hold | 4% | 11% | the equity outflow drives the IRR |
### Failure variant
- **Grant removed after the run** — the bucket recomputes from the sources on the next load; no cached value survives.
- **Remaining limitation** — a grant dated after the sale is still added back in the period it is dated.
### Why the fix removes it
- **Why the fix works** — adding one bucket for those sources and crediting it back in both cash flows removes the cause: equity is no longer charged for money it never funded.

`;

const OPTIONS = `## 5. Why this option
- **Both cash flows agree** — levered and unlevered must move together.
- **No double count** — the builder deposit credited at the sale must not be credited twice.

| Criterion | Proposed | Strongest alternative | Minimal change / status quo |
|---|---|---|---|
| Both cash flows agree | one bucket credited in both | credit grants in the levered flow only; unlevered stays wrong | unchanged, both wrong |
| No double count | the deposit bucket stops at construction, the sale credit stays | same | n/a |

**Why the alternative loses here:** on deal Maple the unlevered IRR would stay at 4% while the levered one moves to 11%.
**Reverse if:** product decides grants are equity-like contributions that should depress equity returns.

`;

const PROPOSED = `## 6. Proposed changes
- Track the funding that comes from grants, other sources and builder deposits as its own bucket in the backend.
- Credit that bucket back in both returns calculations so equity is only charged for what it funded.

`;

const TECHNICAL = `## 7. Technical changes
Summary: Add \`SourcesSummary.non_equity_non_debt_by_periods\`; mirror \`non_equity_non_debt_draws\` into both cash-flow classes.

Flow: \`ProFormaSources.source_type_id\` → \`SourcesSummary.non_equity_non_debt_by_periods\` → \`ReturnsCashFlow.non_equity_non_debt_draws\` → \`Returns.net_levered_irr\`.

- \`common/development.py:301\` \`get_debt_sources_periods\` — sums per-period \`amount_to_fund\` for \`is_debt_source\` sources only [E2].
- \`common/returns.py:153\` \`net_levered_cash_flow\` — adds \`construction_loan_draws\` back; \`net_unlevered_cash_flow\` (146) adds nothing back [E1].

| Layer | File | Symbol | Before | After |
|---|---|---|---|---|
| ast | common/development.py | \`SourcesSummary.non_equity_non_debt_by_periods\` | — | \`get_non_equity_non_debt_periods(sources)\` |

Not changed:
- \`SourcesSummary.construction_debt_by_periods\` — debt-only filter stays, LTC unaffected.

`;

const EVIDENCE = `## 8. Evidence
| ID | Claim | Status | Source | If wrong |
|---|---|---|---|---|
| E1 | the levered cash flow adds back loan draws only | Observed | \`common/returns.py:153\` \`net_levered_cash_flow\` | the root cause |
| E2 | the sources summary has debt and equity buckets only | Observed | \`common/development.py:301\` \`get_debt_sources_periods\` | the new bucket is unnecessary |
| A1 | the newer source categories were added after the returns code | Inferred | E1, E2 and the source-type list | nothing; the fix stands |

`;

const CONTRACT = `## 9. Contract
**Guaranteed:** grant, other and builder-deposit draws are credited back in both cash flows in the period they fund.
**Target:** none
**Unresolved:** a grant dated after the sale.
**Fixed by approval:** the new bucket is not equity; both cash flows use it.
**Left to implementation:** the bucket's name and where the helper lives.
**Reopen if:** any source type turns out to be credited elsewhere already.

`;

const TAIL = `## 10. Risks and edge cases
- No such sources → array is \`None\` → \`case()\` default 0 → action: assert unchanged cash flow → covered by \`test_zero_when_absent\`.

## 11. Tests
| File | Test | Asserts |
|---|---|---|
| backend/tests/utils/pro_forma/test_returns.py | test_zero_when_absent | cash flow identical when no such sources |

Run:

\`\`\`bash
uv run pytest backend/tests/utils/pro_forma/test_returns.py -v
\`\`\`

## 12. QA
\`S1\` — Returns tab reflects a Grant source as a non-equity inflow — \`/deals\`

## 13. Review questions
- **Behavior** — if the grant on deal Maple is dated in month 8 instead of month 6, which period's equity flow changes and why?
- **Choice** — which product rule about grants would make crediting them only in the levered flow the right call?
`;

const good = `${DECISION}${TODAY}${ROOT_CAUSE}${OPTIONS}${PROPOSED}${TECHNICAL}${EVIDENCE}${CONTRACT}${TAIL}`;

describe("designMdProblems", () => {
    it("accepts the template", () => {
        expect(designMdProblems(good)).toBeNull();
    });
    it("counts prose only — tables and code are free", () => {
        const bigTable = good.replace(EVIDENCE, `${EVIDENCE}${"| E1 | filler row | Observed | x.py:1 | none |\n".repeat(400)}\n`);
        expect(designMdProblems(bigTable)).toBeNull();
        const bigProse = good.replace(PROPOSED, `## 6. Proposed changes\n- **Filler** — ${"word ".repeat(1500)}\n\n`);
        expect(designMdProblems(bigProse)).toMatch(/words of prose; the cap is/);
    });
    it("wants the six Decision lines with a citation", () => {
        expect(designMdProblems(good.replace(DECISION, ""))).toMatch(/missing the section "## Decision"/);
        expect(designMdProblems(good.replace(/^\*\*Price:\*\*.*\n/m, ""))).toMatch(/Decision section is missing the line\(s\) `\*\*Price:\*\*`/);
        expect(designMdProblems(good.replace("[E1].\n**Price", ".\n**Price"))).toMatch(/Decision section cites no evidence/);
        expect(designMdProblems(good.replace("**Open blocker:** none", `**Open blocker:** ${"word ".repeat(150)}`))).toMatch(/Decision section is \d+ words; keep it under 150/);
    });
    it("wants an Invariant line under How it works today", () => {
        expect(designMdProblems(good.replace(/^\*\*Invariant:\*\*.*\n/m, ""))).toMatch(/Invariant/);
    });
    it("wants a Proposed changes section in plain words", () => {
        expect(designMdProblems(good.replace(PROPOSED, ""))).toMatch(/Proposed changes/);
        expect(designMdProblems(good.replace(PROPOSED, "## 6. Proposed changes\n\n"))).toMatch(/empty/);
        expect(designMdProblems(good.replace(PROPOSED, "## 6. Proposed changes\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"))).toMatch(/table/);
        expect(designMdProblems(good.replace(PROPOSED, `## 6. Proposed changes\n${"word ".repeat(130)}\n\n`))).toMatch(/under 120/);
    });
    it("wants the Root cause / Approach explanation, matching the classification", () => {
        expect(designMdProblems(good.replace(ROOT_CAUSE, ""))).toMatch(/Root cause" or "## Approach/);
        expect(designMdProblems(good.replace("## 4. Root cause", "## 4. Approach"))).toMatch(/a bug needs the section `## 4. Root cause`/);
        expect(designMdProblems(good.replace(/^bug — /m, "feature — "))).toMatch(/a feature needs the section `## 4. Approach`/);
        expect(designMdProblems(good.replace(ROOT_CAUSE, "## 4. Root cause\n- the backend gets it wrong [E1] [E2].\n\n"))).toMatch(/Root cause section is \d+ words/);
    });
    it("wants a worked case with a table, a failure variant and citations in the explanation", () => {
        expect(designMdProblems(good.replace("### Worked case\n", "### Example\n"))).toMatch(/needs a `### Worked case`/);
        expect(designMdProblems(good.replace(/\| Step \|[\s\S]*?\n### Failure variant/, "- **Deal Maple** — the grant is charged to equity.\n### Failure variant"))).toMatch(/Worked case has no table/);
        expect(designMdProblems(good.replace("### Failure variant\n", "### Variant\n"))).toMatch(/needs a `### Failure variant`/);
        expect(designMdProblems(good.replace(ROOT_CAUSE, ROOT_CAUSE.replace(" [E2]", "").replace(" [A1]", "")))).toMatch(/Root cause section cites 1 evidence row/);
    });
    it("wants the alternatives table, the loses-here line and the reversal condition", () => {
        expect(designMdProblems(good.replace(/\| Criterion \|[\s\S]*?\n\n/, "\n"))).toMatch(/Why this option section needs the \| Criterion/);
        expect(designMdProblems(good.replace(/^\*\*Reverse if:\*\*.*\n/m, ""))).toMatch(/Reverse if/);
        expect(designMdProblems(good.replace(/^\*\*Why the alternative loses here:\*\*.*\n/m, ""))).toMatch(/Why the alternative loses here/);
        expect(designMdProblems(good.replace("| one bucket credited in both |", "| scalability 9/10 |"))).toMatch(/scores options/);
    });
    it("wants an Evidence table whose rows and citations agree", () => {
        expect(designMdProblems(good.replace(EVIDENCE, "## 8. Evidence\nnone\n\n"))).toMatch(/Evidence section needs the \| ID/);
        expect(designMdProblems(good.replace("| Observed | `common/returns.py:153`", "| Seen | `common/returns.py:153`"))).toMatch(/Status outside/);
        expect(designMdProblems(good.replace("| A1 | the newer", "| E3 | the newer"))).toMatch(/E ids are Observed or Measured/);
        expect(designMdProblems(good.replace("| Observed | `common/returns.py:153` `net_levered_cash_flow` |", "| Observed | the returns module |"))).toMatch(/Observed without a `path:line`/);
        expect(designMdProblems(good.replace("| A1 | the newer source categories were added after the returns code | Inferred | E1, E2 and the source-type list | nothing; the fix stands |\n", ""))).toMatch(/no Assumed, Inferred or Unknown row/);
        expect(designMdProblems(good.replace("| A1 | the newer source categories were added after the returns code | Inferred | E1, E2 and the source-type list | nothing; the fix stands |\n", "\nNo assumptions or unknowns.\n").replace(" [A1]", " [E1]"))).toBeNull();
        expect(designMdProblems(good.replace(EVIDENCE, `${EVIDENCE.trimEnd()}\n| U1 | whether grants can be dated after the sale | Unknown | ask product | the Unresolved line |\n\n`))).toMatch(/Evidence row\(s\) U1 are never cited/);
        expect(designMdProblems(good.replace("[A1]", "[A1] [E9]"))).toMatch(/citation\(s\) \[E9\] have no row/);
    });
    it("wants the six Contract lines", () => {
        expect(designMdProblems(good.replace(/^\*\*Reopen if:\*\*.*\n/m, ""))).toMatch(/Contract section is missing the line\(s\) `\*\*Reopen if:\*\*`/);
    });
    it("wants exactly two review questions", () => {
        expect(designMdProblems(good.replace(/^- \*\*Choice\*\*.*\n/m, ""))).toMatch(/Review questions section has 1 bullet/);
        expect(designMdProblems(good.replace("the right call?", "the right call."))).toMatch(/ends with `\?`/);
    });
    it("wants markdown structure in long prose sections", () => {
        const plain = good.replace(PROPOSED, `## 6. Proposed changes\n${"The returns calculation treats every source that is not a loan as equity, so grant money looks like an equity outflow. ".repeat(3)}\n\n`);
        expect(designMdProblems(plain)).toMatch(/Proposed changes section has no bold/);
    });
    it("allows plain product terms in backticks", () => {
        expect(designMdProblems(good.replace("- **Land development** — additionally credits", "- **Land development** — for `archived` deals additionally credits"))).toBeNull();
    });
    it("keeps code out of the prose sections", () => {
        const codey = good.replace("- **Returns tab** — subtracts the whole project cost", "- **Returns tab** — `common/returns.py:153` `net_levered_cash_flow` subtracts the whole project cost");
        expect(designMdProblems(codey)).toMatch(/How it works today section contains code or a file reference/);
        const pathy = good.replace("**Problem:** a deal funded", "**Problem:** FormFields.tsx:23 FROM_LOCATION_FILTERS carry no company_id, so a deal funded");
        expect(designMdProblems(pathy)).toMatch(/Decision section contains code/);
        const snakey = good.replace("| one bucket credited in both |", "| net_levered_cash_flow credits the bucket |");
        expect(designMdProblems(snakey)).toMatch(/Why this option section contains code/);
    });
    it("wants Summary, Flow and the table in Technical changes", () => {
        expect(designMdProblems(good.replace(/^Summary:.*\n/m, ""))).toMatch(/Summary:/);
        expect(designMdProblems(good.replace(/^Flow:.*\n/m, ""))).toMatch(/Flow:/);
        expect(designMdProblems(good.replace(/^\| Layer[\s\S]*?\n\n/m, "\n"))).toMatch(/needs the \| Layer/);
        expect(designMdProblems(good.replace("## 7. Technical changes", "## 7. Edits"))).toMatch(/Technical changes" or "## Change/);
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
