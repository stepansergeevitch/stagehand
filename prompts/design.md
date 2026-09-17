This is the DESIGN PROPOSAL stage for ticket {{ticketId}}. You are now in the task worktree at {{worktree}} on branch `{{branch}}` (base `{{baseBranch}}`). Your research is in `{{taskDir}}/research.md` and `{{taskDir}}/research.json` — read both first. Do not write application code, do not commit.

{{repoLayout}}

{{taskNotes}}

{{reviewerNotes}}

{{askHuman}}

## Who reads this and why

A senior engineer reviews `design.md` to understand the change, challenge it and decide — not to be persuaded. They may not know this part of the system; they will read the code themselves if a claim looks off. Optimise for accurate understanding under a short review-time budget: the decision on the first screen, one concrete case they can trace, the strongest real alternative, the evidence next to the claim it supports, and a clear line between what they are approving and what stays yours. Facts with locations, no persuasion, no narration of how you found things. Separate what you observed from what you inferred or assumed — never imply a scenario or test ran when it was only described.

## design.md — strict template

Exactly these thirteen `## ` sections, in this order, with these titles (numbering allowed: `## 1. Decision`). Hard cap: **1400 words in total**, code blocks and table rows excluded. A proposal over the cap, missing a section or failing a rule below is rejected and sent back to you.

### Formatting inside every section
The reviewer scans, then reads: use markdown structure, not walls of sentences. Every bullet opens with a **bold lead-in** naming the part of the system, the case or the step, then a dash and the fact (`**Frontend form** — lists every warehouse, never narrowed by the selected company`). Bold the key values, states and names the reviewer will look for. Bold and headings are structure — the ban below on emphasis words ("exactly", "importantly") still applies to the wording. Use one running example (one named record with concrete values) from the Decision through the Worked case, the Alternatives and the Review questions; do not switch examples between sections.

### Evidence citations
Consequential claims carry a citation to a row of the Evidence section: `[E1]` for something you observed in the code, `[A1]` for an assumption, `[U1]` for an unknown. Cite in Decision (the decisive insight), Root cause / Approach (at least two), Why this option and Technical changes. A cited id must exist in the Evidence table and every Evidence row must be cited at least once.

### 1. Decision
Six labelled lines in this order, each `**Label:**` then ≤ 30 words, ≤ 150 words in total, product words (no paths, identifiers or line numbers):
- `**Problem:**` one concrete situation, what happens today, why it matters.
- `**Recommendation:**` the behaviour or mechanism to adopt, at most two sentences.
- `**Decisive insight:**` the fact or constraint that makes this the choice, and its consequence; cite the row that supports it (`[E1]`).
- `**Price:**` the main disadvantage and who bears it.
- `**Decision requested:**` the specific choice the reviewer is making and its material consequence — never "approve the design".
- `**Open blocker:**` the unanswered question that could reverse the recommendation (cite `[U1]`), or `none`.

### 2. Classification
One line: `bug` or `feature`, a dash, then the reason in at most 15 words. In a multi-repository workspace add a second line `Repos: <dir>, <dir>` naming every repository the change touches, using the directory names from the layout above (a single-repository project has no such line).

### 3. How it works today
What the application does today in the area the ticket touches, written for a product reader: behaviour, not code. 4–10 bullets, ≤ 20 words each, each naming the part of the system responsible in plain words (the frontend form, the backend service, the loader, the database) and what it does with the data. Example of the right level: "From/To Locations on the transfer form list every warehouse; the frontend never narrows them by the selected company." Wrong level: "FormFields.tsx:23 FROM_LOCATION_FILTERS carries no company_id". No file paths, line numbers, variable or function names in this section — those belong in Technical changes. Describe the system, not the history: no ticket ids, no "shipped by", no "as research found". Close with one line `**Invariant:**` — what must stay true across the change, with its precise scope.

### 4. Root cause (bug) / Approach (feature)
The heading is `## 4. Root cause` for a bug and `## 4. Approach` for a feature. This is the section the reviewer reads most carefully — the explanation in plain words, not the list of edits. 60–320 words outside the table, written so a product manager follows it: which part of the app does what, why that produces the symptom / why the new capability belongs there. No file paths, line numbers, variable or function names — the Technical changes table maps this onto code. Use `###` sub-headings, in this order:
- Bug — `### What happens` (the input or action → what each part of the system does with it → the wrong outcome the user sees), `### Why` (the assumption or missed case behind it; a second contributing cause if one exists), `### Worked case`, `### Failure variant`, `### Why the fix removes it` (why the change removes the cause rather than masking the symptom).
- Feature — `### Where it lives` (which part of the system takes on what responsibility and why there — what existing mechanism it extends or mirrors), `### Data flow` (how the data moves through the app after the change), `### Worked case`, `### Failure variant`, `### What to check` (the invariant, the boundary, the compatibility concern the reviewer must be confident about).

`### Worked case` — one concrete input (a named record with real-looking values: quantities, amounts, dates, states), traced through today's behaviour and the proposed behaviour side by side in one table:

| Step | Actor and action | Today | After the change | Why this step |

3–8 rows; one clause per cell; the first row where Today and After differ is the point of the change — bold both cells. The table must show why the mechanism produces the promised result, not only that it does.

`### Failure variant` — change one event on the same input (a crash, timeout, duplicate submission, invalid input, concurrent edit, missing record): 2–4 bullets on what the system does after the change, what recovers it, and the limitation that remains. Pick the variation that matters for this decision, not a generic one.

### 5. Why this option
State the 2–4 decisive criteria first, one line each. Then compare on those criteria, same running example, in one table:

| Criterion | Proposed | Strongest alternative | Minimal change / status quo |

One clause per cell: the mechanism and what it costs on that criterion. The strongest alternative is the one a reasonable engineer would reach for — for a bug, usually the symptom-level patch; for a feature, the other credible placement — never a straw man. After the table, two lines: `**Why the alternative loses here:**` the precise difference, shown on the worked case; `**Reverse if:**` the changed requirement, verified fact or preference that would make the alternative the right call. Product words; no scores ("scalability 9/10"); ≤ 200 words outside the table.

### 6. Proposed changes
The change explained in plain words for someone who will not read the table: 2–6 short bullets, ≤ 120 words in total, no table, no code, no paths or identifiers. Each bullet: what changes, in which part of the app, and why it fixes the problem — information-dense, no filler, no restating the ticket.

### 7. Technical changes
Everything technical lives here. First a `Summary:` line — the whole change in 1–3 imperative clauses, semicolon-separated, ≤ 60 words, naming the symbols: `Summary: Add BidAttachmentRepository; route the three get_attachment* reads through it; leave the GlobalVendorBid read raw.` Then a `Flow:` line — the data flow after the change as symbols: `` `A.field` → `B.method` → `C.total` ``. Then 3–10 bullets anchoring the mechanism to code: `` `path:line` `Symbol` — what it does today / will do `` (≤ 20 words each; this is where the reviewer learns the code; cite `[E…]` rows where the bullet is the evidence for a claim made earlier). Then a table, one row per changed symbol:

| Layer | File | Symbol | Before | After |

`Before` and `After` are expressions or one-clause behaviours, not prose (`revenue*(1-closing%)` → `revenue*(1-closing%) + coalesce(credit,0)`). A new symbol has `—` in Before. After the table, `Not changed:` with at most 4 bullets of the form `` `thing` — reason `` (≤ 12 words each), only for things a reviewer would expect to see changed.

### 8. Evidence
The index the citations resolve to — not the explanation. One table:

| ID | Claim | Status | Source | If wrong |

- `ID`: `E1`, `E2`… for Observed or Measured; `A1`… for Assumed, Inferred or Preference; `U1`… for Unknown.
- `Status`: one of `Observed`, `Measured`, `Inferred`, `Assumed`, `Preference`, `Unknown`.
- `Source`: Observed → `` `path:line` `Symbol` `` in this worktree (the reviewer opens it); Measured → what was run and the number; Inferred → the observations it follows from (`E1, E3`); Assumed → why it is plausible; Preference → whose stated preference; Unknown → how to resolve it and who can.
- `If wrong`: the decision or section that changes.

4–12 rows. At least one Observed row. At least one Assumed, Inferred or Unknown row — if there is truly none, write the line `No assumptions or unknowns.` under the table. An inference is not an observation; a test you plan is not a test that passed; one traced case is not every execution.

### 9. Contract
What approval means, six labelled lines, ≤ 150 words:
- `**Guaranteed:**` the observable behaviour after the change and the assumption it holds under.
- `**Target:**` intended but not guaranteed (ordering, timing, performance), or `none`.
- `**Unresolved:**` behaviour this proposal deliberately does not settle, or `none`.
- `**Fixed by approval:**` the contracts, invariants and tradeoffs the reviewer locks by approving.
- `**Left to implementation:**` the reversible details the implementer decides without coming back.
- `**Reopen if:**` the discoveries during implementation that must bring the design back for review.

### 10. Risks and edge cases
At most 5 bullets, each with an action: `case → behaviour after the change → action: <what the implementation or reviewer does about it, ≤ 15 words> → covered by <test name>` or `→ action: <…> → accepted, <reason ≤ 10 words>`. The action is concrete (add a guard, floor at 0, order the operands, add test X, ask product) — never "monitor" or "be careful". Include the sign/ordering/null traps that matter for this change. The Failure variant's remaining limitation belongs here with its action.

### 11. Tests
A table, one row per test:

| File | Test | Asserts |

`Asserts` ≤ 15 words with concrete values or relations (`net_revenue == 9500 - 300`). Then a line `Run:` followed by a fenced ```bash block with the exact commands, one per line. No list of test cases outside the table — the table is the list.

### 12. QA
One line per scenario: `` `S1` — <title> — `<start url>` `` for a browser scenario, `` `S2` — <title> — API `<METHOD /path>` `` for an API scenario, or `none — <reason>`. Nothing else: persona, seed and steps live in design.json, and the UI shows those (not this list) under the QA tab.

### 13. Review questions
Exactly two bullets, each one question for the reviewer, nothing else:
- `**Behavior** — ` if one condition in the worked case changes (name it), what happens and why?
- `**Choice** — ` which requirement or fact would make the strongest alternative preferable?

These are prompts for the reviewer's own check, not a test; they may skip them.

### Banned everywhere in design.md
Restating the ticket; provenance remarks in prose (`research.md`, `mempalace`, "confirmed", "per the ticket's note", "AC #n" — the Evidence table is the one place for status); emphasis and hedging ("exactly", "explicitly", "it is worth noting", "importantly", "this is the … trap"); explaining why something is out of scope for more than one clause; JSON blocks; numeric scores without units and method; paragraphs longer than three lines; in Technical changes and Tests, any claim without a path, symbol or number; in sections 1, 3–6, any file path, line number or identifier.

## design.json — structured twin (same content, machine-readable)

- `classification`: `bug` | `feature`.
- `affectedRepos`: the workspace repository directories the change touches (same names as the `Repos:` line; `[]` for a single-repository project).
- `scope.inScope` / `scope.outOfScope`: short phrases derived from the ticket's own description and acceptance criteria (not a parent epic's).
- `plan`: one entry per layer touched (`ws`, `api`, `service`, `repo`, `ast`, `fe`), `changes` = the Technical changes table rows for that layer as one-line strings `File Symbol: before → after`.
- `testPlan`: per file, the test names from the Tests table (pytest for backend, Jest for frontend; behavioural coverage, corner cases: empty/null, boundaries, error paths, off-by-one, ordering; one assertion focus per test).
- `qa`: at most 10 scenarios a later automated run executes. Each: id `S1`..`S10`, `kind` (`browser` or `api`), title, url, persona, `seed`, and ordered steps of `action` → `assert`. Test the NEW behaviour directly; a regression smoke is a supplement.
  - `kind: "browser"` (the default): a claude-in-chrome journey. `url` = starting route (real routes from this repo, e.g. `/projects`, `/projects/{id}/edit`); `"shot": true` on the steps whose asserted state must be screenshotted (≥ 1 per scenario).
  - `kind: "api"`: for a change with no user-visible surface but an observable HTTP behaviour — a new or changed endpoint, validation, permissions, a computed field, a serializer. `url` = the endpoint path (`POST /api/items/`), `persona` = the caller (role/org), and each step's `action` is ONE exact, self-contained shell command the runner executes with Bash — normally `curl -sS -i …` against `{{beUrl}}` (write that placeholder literally; Stagehand fills the task's port): headers, JSON body and query string all spelled out, e.g. `curl -sS -i -X POST {{beUrl}}/api/items/ -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"name":"QA-{{ticketIdUpper}} widget"}'`. Authentication is part of the spec: obtain it the way the repository's own tests or scripts do (a token/API-key row inserted with a `shell:` psql seed, a dev login endpoint called in step 1 and its token reused, basic auth for local) — look it up in the repo and write the exact command; if the API cannot be called without a browser session, say so and write browser scenarios instead. `assert` names the expected status code AND the body fields/values (`201; body.serialized == true; body.serialized_costing_behavior == "actual_cost_by_serial"`). Steps may depend on earlier ones (an id from a create); say so in the assert. No `shot`.
  Zero scenarios ONLY when nothing is observable at all (pure refactor, config, docs) — a backend-only change gets API scenarios, never `qaSkippedReason`.
  **Seeding is part of the spec, and it is literal.** `seed` lists, in order, every piece of data the journey depends on, as steps of exactly two kinds:
  - `shell: <one self-contained command>` — run by the orchestrator from the worktree root before the QA run, without any agent. Use it for everything that can be done with SQL, curl or a repo script: e.g. `shell: PW=$(grep -A8 '[database]' backend/configs/stagehand.cfg | grep '^password' | sed 's/.*=//' | tr -d ' "'); PGPASSWORD="$PW" psql -h localhost -p 5433 -U northspyre -d ns_deal -v ON_ERROR_STOP=1 -c "INSERT INTO … SELECT … WHERE NOT EXISTS (…)"`. Every command must be idempotent (WHERE NOT EXISTS / ON CONFLICT DO NOTHING / check-before-create) because it runs in both passes, must print something useful on success (e.g. the created id), and must be exact: you have the repo now — read the models (`__tablename__`, columns, NOT NULL constraints, enum/UUID constants) and write the real statement with the concrete values (names, amounts, dates) the asserts refer to. Never leave schema discovery to the QA runner. Every `psql … -c "…"` seed is dry-run against the real database (inside BEGIN … ROLLBACK) when this design is validated: a column, table or expression the database rejects fails the contract and comes back to you — so check `\d <table>` yourself before writing it.
    A seed that needs the application's own code (a Django/Flask shell, a repo script) calls the interpreter the way the repository's own commands do — `poetry run python <path/to/manage.py> …`, `uv run python …`, `npx …` — never a bare `python`/`node`: the orchestrator's shell has no such command, and the seed fails in QA, not here. Use the manage.py path the repository actually has.
  - `ui: <exact clicks on a real route>` — the fallback, not the default: only for something the app's own business logic must produce (a computed id/number, a workflow status transition, a record that must exist through the app's normal creation path because a plain INSERT would skip validation or side effects the scenario depends on). Prefer `shell:` SQL for everything else — it is cheaper, faster, and does not burn the scenario's `ui:` budget. Never a `ui:` step that edits spreadsheet-style tables (pro forma cells, lot mix rows) or that fills out a routine multi-field form whose fields map directly onto a table's columns: that has exhausted whole QA runs; write those rows with `shell:` SQL instead, keyed by the deal/pro forma name or equivalent natural key. When in doubt, write the `shell:` INSERT — read the schema (`\d <table>`) once, then insert directly.
  A scenario may have at most 2 `ui:` steps; there is no limit on `shell:` steps. Environment seeding hints (verbatim, use them): {{seedHints}} Use an existing fixture only when the repo guarantees it. Never a step a human must perform; if the runner cannot create the data (third-party account, production data), drop that scenario and say so in `qaSkippedReason`. Seeds run in both passes (before and after implementation): names carry the ticket id, check-before-create where a duplicate would break the assert. `seed: []` only when the journey needs nothing beyond a logged-in user.

Follow the repo's coding guidelines (CLAUDE.md) — naming, layering and typing rules included; never put ticket ids in source code.

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
      "kind": "browser" | "api",
      "title": "...",
      "url": "/projects",
      "persona": "org admin",
      "seed": [ "ui: open /projects, click New project, name it QA-{{ticketIdUpper}}, save", "shell: PW=$(…); PGPASSWORD=\"$PW\" psql -h localhost -p 5432 -U app -d app_db -v ON_ERROR_STOP=1 -c \"INSERT INTO … WHERE NOT EXISTS (…)\"" ],
      "steps": [ { "action": "...", "assert": "...", "shot": true } ]
    }
  ],
  "qaSkippedReason": null
}
```

Then reply with exactly one line: `DONE`.
