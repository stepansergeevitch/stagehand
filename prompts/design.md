This is the DESIGN PROPOSAL stage for ticket {{ticketId}}. You are now in the task worktree at {{worktree}} on branch `{{branch}}` (base `{{baseBranch}}`). Your research is in `{{taskDir}}/research.md` and `{{taskDir}}/research.json` — read both first. Do not write application code, do not commit.

{{repoLayout}}

{{reviewerNotes}}

## Who reads this and why

A senior engineer reviews `design.md` to approve or push back, and uses it to learn how this part of the system works. They will read the code themselves if a claim looks off. Write for that reader: facts with locations, no persuasion, no narration of how you found things.

## design.md — strict template

Exactly these seven `## ` sections, in this order, with these titles (numbering allowed: `## 1. Classification`). Hard cap: **700 words in total** (code blocks excluded). A proposal over the cap or missing a section is rejected and sent back to you.

### 1. Classification
One line: `bug` or `feature`, a dash, then the reason in at most 15 words.

### 2. How it works today
The mechanism the ticket touches, as it is now — the part the reviewer should learn. 5–12 bullets, each ONE fact anchored to code: `` `path:line` `Symbol` — what it computes or does `` (≤ 20 words per bullet). Finish with one data-flow line using symbol names: `` `A.field` → `B.method` → `C.total` ``. Describe the system, not the history: no ticket ids, no "shipped by", no "as research found".

### 3. Problem
Bug: the root cause in ≤ 3 bullets — what is wrong, where, and why it produces the reported symptom. Feature: the gap in ≤ 3 bullets — what is missing, where it has to hook in.

### 4. Change
A table, one row per changed symbol:

| Layer | File | Symbol | Before | After |

`Before` and `After` are expressions or one-clause behaviours, not prose (`revenue*(1-closing%)` → `revenue*(1-closing%) + coalesce(credit,0)`). A new symbol has `—` in Before. After the table, `Not changed:` with at most 4 bullets of the form `` `thing` — reason `` (≤ 12 words each), only for things a reviewer would expect to see changed.

### 5. Risks and edge cases
At most 5 bullets: `case → behaviour after the change → covered by <test name>` or `→ accepted, <reason ≤ 10 words>`. Include the sign/ordering/null traps that matter for this change.

### 6. Tests
A table, one row per test:

| File | Test | Asserts |

`Asserts` ≤ 15 words with concrete values or relations (`net_revenue == 9500 - 300`). Then one line `Run:` with the exact commands.

### 7. QA
One line per scenario: `` `S1` — <title> — `<start url>` ``, or `none — <reason>`. Nothing else: persona, seed and steps live in design.json, and the UI shows those (not this list) under the QA tab.

### Banned everywhere in design.md
Restating the ticket; provenance remarks (`research.md`, `mempalace`, "confirmed", "per the ticket's note", "AC #n"); emphasis and hedging ("exactly", "explicitly", "it is worth noting", "importantly", "this is the … trap"); explaining why something is out of scope for more than one clause; JSON blocks; paragraphs longer than three lines; any claim without a path, symbol or number.

## design.json — structured twin (same content, machine-readable)

- `classification`: `bug` | `feature`.
- `scope.inScope` / `scope.outOfScope`: short phrases derived from the ticket's own description and acceptance criteria (not a parent epic's).
- `plan`: one entry per layer touched (`ws`, `api`, `service`, `repo`, `ast`, `fe`), `changes` = the Change table rows for that layer as one-line strings `File Symbol: before → after`.
- `testPlan`: per file, the test names from the Tests table (pytest for backend, Jest for frontend; behavioural coverage, corner cases: empty/null, boundaries, error paths, off-by-one, ordering; one assertion focus per test).
- `qa`: at most 3 browser journeys a later automated run executes with claude-in-chrome. Each: id `S1`..`S3`, title, starting URL (real routes from this repo, e.g. `/deals`, `/deal/{dealId}/pro_forma/{pfId}/table`), persona, `seed`, and ordered steps of `action` → `assert`; `"shot": true` on the steps whose asserted state must be screenshotted (≥ 1 per scenario). Test the NEW behaviour directly; a regression smoke is a supplement. Zero scenarios ONLY when nothing is user-visible (backend-only, refactor, config) — say why in `qaSkippedReason`.
  **Seeding is part of the spec.** `seed` lists, in order, every piece of data the journey depends on and exactly how the runner creates it by itself: SQL against the local database or a script that exists in this repo (preferred — one Bash call each), API calls with method, path and payload, or UI actions on real routes for simple forms only ("open `/deals`, click New deal, name it `QA-{{ticketIdUpper}}`, save") — with the concrete values (names, amounts, dates) the asserts refer to, so a fresh database yields the asserted result. Never seed numeric inputs by editing spreadsheet-style tables (pro forma cells, lot mix rows) through the browser: that costs dozens of tool calls per value and has exhausted whole QA runs; write those rows with SQL and give the exact statement. The whole seed of a scenario must be doable in ≤ 12 tool calls. Environment seeding hints (verbatim, use them): {{seedHints}} Use an existing fixture only when the repo guarantees it. Never a step a human must perform; if the runner cannot create the data (third-party account, production data), drop that scenario and say so in `qaSkippedReason`. Seeds run in both passes (before and after implementation): names carry the ticket id, check-before-create where a duplicate would break the assert. `seed: []` only when the journey needs nothing beyond a logged-in user.

Follow the repo's coding guidelines (CLAUDE.md): UnitOfWork `uow=` never `db=`, kebab-case plural routes, no ticket ids in source code, no `# type: ignore`/`cast` to silence typing.

## Output contract

Write `{{taskDir}}/design.md` exactly as templated above.

Write `{{taskDir}}/design.json` with exactly this shape:

```json
{
  "classification": "bug" | "feature",
  "scope": { "inScope": ["..."], "outOfScope": ["..."] },
  "plan": [ { "layer": "service", "changes": ["...", "..."] } ],
  "testPlan": [ { "file": "backend/tests/...py", "cases": ["test_...", "..."] } ],
  "qa": [
    {
      "id": "S1",
      "title": "...",
      "url": "/deals",
      "persona": "org admin",
      "seed": [ "open /deals, click New deal, name it QA-{{ticketIdUpper}}, save", "POST /api/deals/{dealId}/... with {...}" ],
      "steps": [ { "action": "...", "assert": "...", "shot": true } ]
    }
  ],
  "qaSkippedReason": null
}
```

Then reply with exactly one line: `DONE`.
