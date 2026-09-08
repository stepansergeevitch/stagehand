This is the DESIGN PROPOSAL stage for ticket {{ticketId}}. You are now in the task worktree at {{worktree}} on branch `{{branch}}` (base `{{baseBranch}}`). Your research is in `{{taskDir}}/research.md` and `{{taskDir}}/research.json` — read both first. Do not write application code, do not commit.

{{repoLayout}}

{{reviewerNotes}}

## Who reads this and why

A senior engineer reviews `design.md` to approve or push back, and uses it to learn how this part of the system works. They will read the code themselves if a claim looks off. Write for that reader: facts with locations, no persuasion, no narration of how you found things.

## design.md — strict template

Exactly these seven `## ` sections, in this order, with these titles (numbering allowed: `## 1. Classification`). Hard cap: **800 words in total** (code blocks excluded). A proposal over the cap or missing a section is rejected and sent back to you.

### 1. Classification
One line: `bug` or `feature`, a dash, then the reason in at most 15 words.

### 2. How it works today
The mechanism the ticket touches, as it is now — the part the reviewer should learn. 5–12 bullets, each ONE fact anchored to code: `` `path:line` `Symbol` — what it computes or does `` (≤ 20 words per bullet). Finish with one data-flow line using symbol names: `` `A.field` → `B.method` → `C.total` ``. Describe the system, not the history: no ticket ids, no "shipped by", no "as research found".

### 3. Problem
Bug: the root cause in ≤ 3 bullets — what is wrong, where, and why it produces the reported symptom. Feature: the gap in ≤ 3 bullets — what is missing, where it has to hook in.

### 4. Change
First a `Summary:` line — the whole change in 1–3 imperative clauses, semicolon-separated, ≤ 60 words, naming the symbols: `Summary: Add BidAttachmentRepository; route the three get_attachment* reads through it; leave the GlobalVendorBid read raw.` Then a table, one row per changed symbol:

| Layer | File | Symbol | Before | After |

`Before` and `After` are expressions or one-clause behaviours, not prose (`revenue*(1-closing%)` → `revenue*(1-closing%) + coalesce(credit,0)`). A new symbol has `—` in Before. After the table, `Not changed:` with at most 4 bullets of the form `` `thing` — reason `` (≤ 12 words each), only for things a reviewer would expect to see changed.

### 5. Risks and edge cases
At most 5 bullets, each with an action: `case → behaviour after the change → action: <what the implementation or reviewer does about it, ≤ 15 words> → covered by <test name>` or `→ action: <…> → accepted, <reason ≤ 10 words>`. The action is concrete (add a guard, floor at 0, order the operands, add test X, ask product) — never "monitor" or "be careful". Include the sign/ordering/null traps that matter for this change.

### 6. Tests
A table, one row per test:

| File | Test | Asserts |

`Asserts` ≤ 15 words with concrete values or relations (`net_revenue == 9500 - 300`). Then a line `Run:` followed by a fenced ```bash block with the exact commands, one per line. No list of test cases outside the table — the table is the list.

### 7. QA
One line per scenario: `` `S1` — <title> — `<start url>` ``, or `none — <reason>`. Nothing else: persona, seed and steps live in design.json, and the UI shows those (not this list) under the QA tab.

### Banned everywhere in design.md
Restating the ticket; provenance remarks (`research.md`, `mempalace`, "confirmed", "per the ticket's note", "AC #n"); emphasis and hedging ("exactly", "explicitly", "it is worth noting", "importantly", "this is the … trap"); explaining why something is out of scope for more than one clause; JSON blocks; paragraphs longer than three lines; any claim without a path, symbol or number.

## design.json — structured twin (same content, machine-readable)

- `classification`: `bug` | `feature`.
- `scope.inScope` / `scope.outOfScope`: short phrases derived from the ticket's own description and acceptance criteria (not a parent epic's).
- `plan`: one entry per layer touched (`ws`, `api`, `service`, `repo`, `ast`, `fe`), `changes` = the Change table rows for that layer as one-line strings `File Symbol: before → after`.
- `testPlan`: per file, the test names from the Tests table (pytest for backend, Jest for frontend; behavioural coverage, corner cases: empty/null, boundaries, error paths, off-by-one, ordering; one assertion focus per test).
- `qa`: at most 10 browser journeys a later automated run executes with claude-in-chrome. Each: id `S1`..`S10`, title, starting URL (real routes from this repo, e.g. `/deals`, `/deal/{dealId}/pro_forma/{pfId}/table`), persona, `seed`, and ordered steps of `action` → `assert`; `"shot": true` on the steps whose asserted state must be screenshotted (≥ 1 per scenario). Test the NEW behaviour directly; a regression smoke is a supplement. Zero scenarios ONLY when nothing is user-visible (backend-only, refactor, config) — say why in `qaSkippedReason`.
  **Seeding is part of the spec, and it is literal.** `seed` lists, in order, every piece of data the journey depends on, as steps of exactly two kinds:
  - `shell: <one self-contained command>` — run by the orchestrator from the worktree root before the QA run, without any agent. Use it for everything that can be done with SQL, curl or a repo script: e.g. `shell: PW=$(grep -A8 '[database]' backend/configs/stagehand.cfg | grep '^password' | sed 's/.*=//' | tr -d ' "'); PGPASSWORD="$PW" psql -h localhost -p 5433 -U northspyre -d ns_deal -v ON_ERROR_STOP=1 -c "INSERT INTO … SELECT … WHERE NOT EXISTS (…)"`. Every command must be idempotent (WHERE NOT EXISTS / ON CONFLICT DO NOTHING / check-before-create) because it runs in both passes, must print something useful on success (e.g. the created id), and must be exact: you have the repo now — read the models (`__tablename__`, columns, NOT NULL constraints, enum/UUID constants) and write the real statement with the concrete values (names, amounts, dates) the asserts refer to. Never leave schema discovery to the QA runner.
  - `ui: <exact clicks on a real route>` — only for a simple form the app requires (e.g. `ui: open /deals, click New deal, name it QA-{{ticketIdUpper}}, choose Land Development, save; the deal id is in the URL`). Never a `ui:` step that edits spreadsheet-style tables (pro forma cells, lot mix rows): that has exhausted whole QA runs; write those rows with `shell:` SQL instead, keyed by the deal/pro forma name.
  A scenario may have at most 2 `ui:` steps; there is no limit on `shell:` steps. Environment seeding hints (verbatim, use them): {{seedHints}} Use an existing fixture only when the repo guarantees it. Never a step a human must perform; if the runner cannot create the data (third-party account, production data), drop that scenario and say so in `qaSkippedReason`. Seeds run in both passes (before and after implementation): names carry the ticket id, check-before-create where a duplicate would break the assert. `seed: []` only when the journey needs nothing beyond a logged-in user.

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
      "seed": [ "ui: open /deals, click New deal, name it QA-{{ticketIdUpper}}, choose Land Development, save", "shell: PW=$(…); PGPASSWORD=\"$PW\" psql -h localhost -p 5433 -U northspyre -d ns_deal -v ON_ERROR_STOP=1 -c \"INSERT INTO … WHERE NOT EXISTS (…)\"" ],
      "steps": [ { "action": "...", "assert": "...", "shot": true } ]
    }
  ],
  "qaSkippedReason": null
}
```

Then reply with exactly one line: `DONE`.
