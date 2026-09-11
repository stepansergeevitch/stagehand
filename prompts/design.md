This is the DESIGN PROPOSAL stage for ticket {{ticketId}}. You are now in the task worktree at {{worktree}} on branch `{{branch}}` (base `{{baseBranch}}`). Your research is in `{{taskDir}}/research.md` and `{{taskDir}}/research.json` — read both first. Do not write application code, do not commit.

{{repoLayout}}

{{taskNotes}}

{{reviewerNotes}}

{{askHuman}}

## Who reads this and why

A senior engineer reviews `design.md` to approve or push back, and uses it to learn how this part of the system works. They will read the code themselves if a claim looks off. Write for that reader: facts with locations, no persuasion, no narration of how you found things.

## design.md — strict template

Exactly these nine `## ` sections, in this order, with these titles (numbering allowed: `## 1. Classification`). Hard cap: **1100 words in total** (code blocks excluded). A proposal over the cap or missing a section is rejected and sent back to you.

### Formatting inside every section
The reviewer scans, then reads: use markdown structure, not walls of sentences. Every bullet opens with a **bold lead-in** naming the part of the system, the case or the step, then a dash and the fact (`**Frontend form** — lists every warehouse, never narrowed by the selected company`). Sections 4 and 6 use `###` sub-headings: Root cause → `### What happens`, `### Why`, `### Why the fix removes it`; Approach → `### Where it lives`, `### Data flow`, `### Decisions`, `### What to check`; Technical changes → `### Summary`, `### Mechanism`, `### Changes`, `### Not changed`. Bold the key values, states and names the reviewer will look for. Bold and headings are structure — the ban below on emphasis words ("exactly", "importantly") still applies to the wording.

### 1. Classification
One line: `bug` or `feature`, a dash, then the reason in at most 15 words. In a multi-repository workspace add a second line `Repos: <dir>, <dir>` naming every repository the change touches, using the directory names from the layout above (a single-repository project has no such line).

### 2. How it works today
What the application does today in the area the ticket touches, written for a product reader: behaviour, not code. 4–10 bullets, ≤ 20 words each, each naming the part of the system responsible in plain words (the frontend form, the backend service, the loader, the database) and what it does with the data. Example of the right level: "From/To Locations on the transfer form list every warehouse; the frontend never narrows them by the selected company." Wrong level: "FormFields.tsx:23 FROM_LOCATION_FILTERS carries no company_id". No file paths, line numbers, variable or function names in this section — those belong in Technical changes. Describe the system, not the history: no ticket ids, no "shipped by", no "as research found".

### 3. Problem
What is wrong or missing, as the user and the product see it, in ≤ 3 bullets: the visible symptom and the part of the system that produces it, in plain words. Same rule: no paths, line numbers or identifiers.

### 4. Root cause (bug) / Approach (feature)
The heading is `## 4. Root cause` for a bug and `## 4. Approach` for a feature. This is the section the reviewer reads most carefully — the explanation in plain words, not the list of edits. 60–220 words, 4–10 bullets or short paragraphs (≤ 3 lines each), written so a product manager follows it: which part of the app does what, why that produces the symptom / why the new capability belongs there. Example of the right level: "The frontend builds the location list once, without the company, so switching Company never narrows it; the backend already accepts a company filter, it is just never sent." No file paths, line numbers, variable or function names — the Technical changes table maps this onto code.
- Bug — **Root cause**: the chain of behaviour that produces the symptom (the input or action → what each part of the system does with it → the wrong outcome the user sees), the assumption or missed case behind it, and why the change removes the cause rather than masking the symptom. Name a second contributing cause if one exists.
- Feature — **Approach**: how it should be built: which part of the system takes on what responsibility and why there (what existing mechanism it extends or mirrors), how the data moves through the app after the change, the 2–4 design decisions that shape it each with the alternative rejected in one clause, and what the reviewer must check to be confident (the invariant, the boundary, the compatibility concern).

### 5. Proposed changes
The change explained in plain words for someone who will not read the table: 2–6 short bullets, ≤ 120 words in total, no table, no code, no paths or identifiers. Each bullet: what changes, in which part of the app, and why it fixes the problem — information-dense, no filler, no restating the ticket.

### 6. Technical changes
Everything technical lives here. First a `Summary:` line — the whole change in 1–3 imperative clauses, semicolon-separated, ≤ 60 words, naming the symbols: `Summary: Add BidAttachmentRepository; route the three get_attachment* reads through it; leave the GlobalVendorBid read raw.` Then a `Flow:` line — the data flow after the change as symbols: `` `A.field` → `B.method` → `C.total` ``. Then 3–10 bullets anchoring the mechanism to code: `` `path:line` `Symbol` — what it does today / will do `` (≤ 20 words each; this is where the reviewer learns the code). Then a table, one row per changed symbol:

| Layer | File | Symbol | Before | After |

`Before` and `After` are expressions or one-clause behaviours, not prose (`revenue*(1-closing%)` → `revenue*(1-closing%) + coalesce(credit,0)`). A new symbol has `—` in Before. After the table, `Not changed:` with at most 4 bullets of the form `` `thing` — reason `` (≤ 12 words each), only for things a reviewer would expect to see changed.

### 7. Risks and edge cases
At most 5 bullets, each with an action: `case → behaviour after the change → action: <what the implementation or reviewer does about it, ≤ 15 words> → covered by <test name>` or `→ action: <…> → accepted, <reason ≤ 10 words>`. The action is concrete (add a guard, floor at 0, order the operands, add test X, ask product) — never "monitor" or "be careful". Include the sign/ordering/null traps that matter for this change.

### 8. Tests
A table, one row per test:

| File | Test | Asserts |

`Asserts` ≤ 15 words with concrete values or relations (`net_revenue == 9500 - 300`). Then a line `Run:` followed by a fenced ```bash block with the exact commands, one per line. No list of test cases outside the table — the table is the list.

### 9. QA
One line per scenario: `` `S1` — <title> — `<start url>` ``, or `none — <reason>`. Nothing else: persona, seed and steps live in design.json, and the UI shows those (not this list) under the QA tab.

### Banned everywhere in design.md
Restating the ticket; provenance remarks (`research.md`, `mempalace`, "confirmed", "per the ticket's note", "AC #n"); emphasis and hedging ("exactly", "explicitly", "it is worth noting", "importantly", "this is the … trap"); explaining why something is out of scope for more than one clause; JSON blocks; paragraphs longer than three lines; in Technical changes and Tests, any claim without a path, symbol or number; in sections 2–5, any file path, line number or identifier.

## design.json — structured twin (same content, machine-readable)

- `classification`: `bug` | `feature`.
- `affectedRepos`: the workspace repository directories the change touches (same names as the `Repos:` line; `[]` for a single-repository project).
- `scope.inScope` / `scope.outOfScope`: short phrases derived from the ticket's own description and acceptance criteria (not a parent epic's).
- `plan`: one entry per layer touched (`ws`, `api`, `service`, `repo`, `ast`, `fe`), `changes` = the Technical changes table rows for that layer as one-line strings `File Symbol: before → after`.
- `testPlan`: per file, the test names from the Tests table (pytest for backend, Jest for frontend; behavioural coverage, corner cases: empty/null, boundaries, error paths, off-by-one, ordering; one assertion focus per test).
- `qa`: at most 10 browser journeys a later automated run executes with claude-in-chrome. Each: id `S1`..`S10`, title, starting URL (real routes from this repo, e.g. `/deals`, `/deal/{dealId}/pro_forma/{pfId}/table`), persona, `seed`, and ordered steps of `action` → `assert`; `"shot": true` on the steps whose asserted state must be screenshotted (≥ 1 per scenario). Test the NEW behaviour directly; a regression smoke is a supplement. Zero scenarios ONLY when nothing is user-visible (backend-only, refactor, config) — say why in `qaSkippedReason`.
  **Seeding is part of the spec, and it is literal.** `seed` lists, in order, every piece of data the journey depends on, as steps of exactly two kinds:
  - `shell: <one self-contained command>` — run by the orchestrator from the worktree root before the QA run, without any agent. Use it for everything that can be done with SQL, curl or a repo script: e.g. `shell: PW=$(grep -A8 '[database]' backend/configs/stagehand.cfg | grep '^password' | sed 's/.*=//' | tr -d ' "'); PGPASSWORD="$PW" psql -h localhost -p 5433 -U northspyre -d ns_deal -v ON_ERROR_STOP=1 -c "INSERT INTO … SELECT … WHERE NOT EXISTS (…)"`. Every command must be idempotent (WHERE NOT EXISTS / ON CONFLICT DO NOTHING / check-before-create) because it runs in both passes, must print something useful on success (e.g. the created id), and must be exact: you have the repo now — read the models (`__tablename__`, columns, NOT NULL constraints, enum/UUID constants) and write the real statement with the concrete values (names, amounts, dates) the asserts refer to. Never leave schema discovery to the QA runner. Every `psql … -c "…"` seed is dry-run against the real database (inside BEGIN … ROLLBACK) when this design is validated: a column, table or expression the database rejects fails the contract and comes back to you — so check `\d <table>` yourself before writing it.
  - `ui: <exact clicks on a real route>` — the fallback, not the default: only for something the app's own business logic must produce (a computed id/number, a workflow status transition, a record that must exist through the app's normal creation path because a plain INSERT would skip validation or side effects the scenario depends on). Prefer `shell:` SQL for everything else — it is cheaper, faster, and does not burn the scenario's `ui:` budget. Never a `ui:` step that edits spreadsheet-style tables (pro forma cells, lot mix rows) or that fills out a routine multi-field form whose fields map directly onto a table's columns: that has exhausted whole QA runs; write those rows with `shell:` SQL instead, keyed by the deal/pro forma name or equivalent natural key. When in doubt, write the `shell:` INSERT — read the schema (`\d <table>`) once, then insert directly.
  A scenario may have at most 2 `ui:` steps; there is no limit on `shell:` steps. Environment seeding hints (verbatim, use them): {{seedHints}} Use an existing fixture only when the repo guarantees it. Never a step a human must perform; if the runner cannot create the data (third-party account, production data), drop that scenario and say so in `qaSkippedReason`. Seeds run in both passes (before and after implementation): names carry the ticket id, check-before-create where a duplicate would break the assert. `seed: []` only when the journey needs nothing beyond a logged-in user.

Follow the repo's coding guidelines (CLAUDE.md): UnitOfWork `uow=` never `db=`, kebab-case plural routes, no ticket ids in source code, no `# type: ignore`/`cast` to silence typing.

## Output contract

Write `{{taskDir}}/design.md` exactly as templated above.

Write `{{taskDir}}/design.json` with exactly this shape:

```json
{
  "classification": "bug" | "feature",
  "affectedRepos": ["backend", "frontend"],
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
