This is the PR DRAFT step for ticket {{ticketId}} in worktree {{worktree}} on branch `{{branch}}` against `{{baseBranch}}`. Do NOT create the PR, do not push, do not post anything to GitHub. Only draft.

{{repoLayout}} If the workspace has several repositories, run the git commands below in each repository that has commits ahead of `{{baseBranch}}` and draft one PR per such repository (put the extra drafts in `body` under a `## Companion PRs` heading, one per repository).

1. Read `.github/pull_request_template.md` in the repo and `{{taskDir}}/impl.json`, `{{taskDir}}/design.json`.
2. Look at `git log --oneline origin/{{baseBranch}}..HEAD` and `git diff --stat origin/{{baseBranch}}...HEAD`.
3. Title: `{{ticketIdUpper}} <imperative phrase>`, under 70 characters — e.g. `{{ticketIdUpper}} Add builder deposit credit to sales schedule`. No adjectives like comprehensive/robust/seamless, no benefit framing.
4. Body: the template, filled in the house style below. Keep the template's own headings and checkbox lines exactly; add nothing else.

## House style (this is how the author writes PRs — match it)

- **Description = one to three plain sentences.** What the change adds/changes/fixes and where, with the class, function, table or file names in backticks. A companion PR in another repo gets one sentence with its link. That is all. Examples of the real thing:
  - "Fix flaky tests: Isolate test Redis cache; pin BOE loan fields."
  - "Adds monthly-compounding construction cost inflation to Hard/Soft Costs."
  - "Add Builder Deposit source constants, hide from picker. Requires the companion core-repo PR https://github.com/…/pull/13740 that adds the actual `source_type` row this UUID refers to."
  - "Wires up the Builder Deposit source type that PRODUCT-8588 scaffolded. `SalesSchedule` and `LandDevelopmentReturns` now spread the deposit total as a credit across the sales schedule periods and net it against sale proceeds in Returns, and `ProFormaSourceService` locks a Builder Deposit's traunch to 1 and rejects creating one outside Land Development. Frontend changes are in `ProFormaSalesSchedule.tsx` (two new columns) and `ProFormaReturnsTable` (new row, renamed label)."
- **No** sub-headings, tables, "decision" essays, rationale paragraphs, lists of tests, "notes for reviewer", "out of scope" or "follow-up" sections. If the ticket explicitly asks for a decision to be recorded in the PR, record it in ONE sentence inside the description ("`find_stored_duplicate` keeps `.one()`; two same-name/same-size files across rounds still raise `MultipleResultsFound`, as today."). Everything else the reviewer can read in the diff.
- **Checkboxes:** tick exactly one in Type of change, the applicable ones in Development Setup, one Risk Level, "Regular Deploy" unless the diff needs otherwise. Mobile Impact (when present): tick one; a reason line only for "Mobile unaffected — reason below". Leave the Reviewer Checklist unticked except "covered with tests" when it is.
- **QA Instructions:** at most four short numbered steps a reviewer performs in the app, taken from the design's QA scenarios. No shell commands, no test invocations, no grep. If there is nothing to click through (pure refactor), write "1. Covered by tests; no UI change."
- Target length: the whole body without the template boilerplate is well under 1,000 characters. When in doubt, cut.

## Output contract

Write `{{taskDir}}/pr.json`:

```json
{ "title": "...", "body": "...", "base": "{{baseBranch}}" }
```

Then reply with exactly one line: `DONE`.
