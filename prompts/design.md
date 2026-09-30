This is the DESIGN PROPOSAL stage for ticket {{ticketId}}. You are now in the task worktree at {{worktree}} on branch `{{branch}}` (base `{{baseBranch}}`). Your research is in `{{taskDir}}/research.md` and `{{taskDir}}/research.json` — read both first. Do not write application code, do not commit.

{{repoLayout}}

{{taskNotes}}

{{components}}

{{reviewerNotes}}

{{askHuman}}

## Who reads this and why

A senior engineer reads `design.md` to understand the change and to decide. They read fast. They read the code when a claim looks wrong. Give them facts, not persuasion. Every sentence carries a fact the reviewer needs. A sentence that repeats the ticket, narrates your search, or hedges has no place here.

After you finish, Stagehand runs the QA baseline on your `design.json` scenarios against the unchanged app. You then get the baseline result and correct every scenario that is wrong. The reviewer sees the proposal and the baseline result together.

## Writing rules — ASD-STE100 Simplified Technical English

These rules apply to every sentence in `design.md`. A proposal that breaks them comes back to you.
- **Short sentences.** A sentence has 20 words or fewer. Never more than 25.
- **One fact per sentence.** Use the active voice and the present tense.
- **Simple words.** Use the same word for the same thing every time. No synonyms for variety. No idioms, no figurative language, no phrasal verbs.
- **Requirements.** Use "must" for a requirement and "can" for a possibility. Never "should", "might", "could".
- **No filler.** No "it is worth noting", "importantly", "note that", "in order to", "basically", "essentially", "robust", "seamless", "leverage", "comprehensive", "ensure that".
- **No backstory.** No history of how the code got here, no ticket ids, no "as research found", no references to where you learned a fact.
- **Bold for attention.** Every bullet opens with a **bold lead-in** that names the part of the system or the case, then a dash and the fact: `**Transfer form** — lists every warehouse; it never filters by company.` Bold the key values, states and names too.
- **One running example.** Use one named record with concrete values in Problem statement, Root cause and Suggested approach.

## design.md — template

Exactly these `## ` sections, in this order, with these titles. **Root cause** exists only for a bug. Hard cap: **700 words** in total, code blocks and table rows excluded.

### Classification
One line: `bug` or `feature`, a dash, then the reason in 15 words or fewer. In a multi-repository workspace add a second line `Repos: <dir>, <dir>` with every repository the change touches, by the directory names from the layout above.

### Problem statement
2–4 bullets, 80 words or fewer. The situation, what happens today, what the user loses. Product words: no file paths, line numbers or identifiers.

### Root cause
Bug only. 2–6 bullets, 40–160 words. The chain from the trigger to the wrong result: which part of the system does what, and which assumption fails. Trace the running example. Product words: no file paths, line numbers or identifiers.

### Suggested approach
3–8 bullets, 60–250 words. The change and why it removes the problem. Say how the app works today where the change touches it — inside the bullet that changes it, not as a separate part. Name the part of the system that takes the new responsibility. Close with one line `**Invariant:**` — what must stay true after the change. Product words: no file paths, line numbers or identifiers.

### Technical changes
Everything technical lives here.
- First a `**Summary:**` line: the whole change in 1–3 imperative clauses, 50 words or fewer, with the symbols: `**Summary:** Add BidAttachmentRepository; route the three get_attachment* reads through it.`
- Then a table, one row per changed symbol:

| Layer | File | Symbol | Before | After |

`Before` and `After` are expressions or one-clause behaviours (`revenue*(1-closing%)` → `revenue*(1-closing%) + coalesce(credit,0)`). A new symbol has `—` in Before.
- Then `### Tests`: a table `| File | Test | Asserts |`, one row per test, `Asserts` 15 words or fewer with concrete values (`net_revenue == 9500 - 300`). Then a line `**Run:**` followed by a fenced ```bash block with the exact commands, one per line.
- At most 3 bullets `**Not changed** — `thing` — reason`, only for things the reviewer expects to see changed.

No other sections. No QA list: the reviewer reads the QA scenarios and the baseline result in the QA tab, from `design.json`. No JSON blocks in `design.md`.

## design.json — structured twin (same content, machine-readable)

- `classification`: `bug` | `feature`.
- `affectedRepos`: the workspace repository directories the change touches (same names as the `Repos:` line; `[]` for a single-repository project).
- `scope.inScope` / `scope.outOfScope`: short phrases derived from the ticket's own description and acceptance criteria (not a parent epic's).
- `plan`: one entry per layer touched (`ws`, `api`, `service`, `repo`, `ast`, `fe`), `changes` = the Technical changes table rows for that layer as one-line strings `File Symbol: before → after`.
- `testPlan`: per file, the test names from the `### Tests` table (pytest for backend, Jest for frontend; behavioural coverage, corner cases: empty/null, boundaries, error paths, off-by-one, ordering; one assertion focus per test).
- `qa`: at most 10 scenarios. The baseline runs them right after this stage, before the reviewer sees the proposal; Manual QA runs them again after the implementation. Each: id `S1`..`S10`, `kind` (`browser` or `api`), title, url, persona, `seed`, and ordered steps of `action` → `assert`. Test the NEW behaviour directly; a regression smoke is a supplement.
  - `kind: "browser"` (the default): a claude-in-chrome journey. `url` = starting route (real routes from this repo, e.g. `/projects`, `/projects/{id}/edit`); `"shot": true` on the steps whose asserted state must be screenshotted (≥ 1 per scenario).
  - `kind: "api"`: for a change with no user-visible surface but an observable HTTP behaviour — a new or changed endpoint, validation, permissions, a computed field, a serializer. `url` = the endpoint path (`POST /api/items/`), `persona` = the caller (role/org), and each step's `action` is ONE exact, self-contained shell command the runner executes with Bash — normally `curl -sS -i …` against `{{beUrl}}` (write that placeholder literally; Stagehand fills the task's port): headers, JSON body and query string all spelled out, e.g. `curl -sS -i -X POST {{beUrl}}/api/items/ -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"name":"QA-{{ticketIdUpper}} widget"}'`. Authentication is part of the spec: obtain it the way the repository's own tests or scripts do (a token/API-key row inserted with a `shell:` psql seed, a dev login endpoint called in step 1 and its token reused, basic auth for local) — look it up in the repo and write the exact command; if the API cannot be called without a browser session, say so and write browser scenarios instead. `assert` names the expected status code AND the body fields/values (`201; body.serialized == true; body.serialized_costing_behavior == "actual_cost_by_serial"`). Steps may depend on earlier ones (an id from a create); say so in the assert. No `shot`. **Verify every path, method and required field against the app's own API description before writing the command** — generate or read the OpenAPI document the repository provides (e.g. a `generate_openapi_json` management command, `/api/openapi.json`, the router/versioning module) and copy the exact mount path (`/public/v3-alpha/…`, not a version that is not mounted) and the schema's required top-level fields; a step that 404s or 400s on its own shape costs a whole QA round and a human answer. A step whose curl hard-codes a host or uses a bare path fails the design contract.
  Zero scenarios ONLY when nothing is observable at all (pure refactor, config, docs) — a backend-only change gets API scenarios, never `qaSkippedReason`.
  **A scenario whose journey cannot exist before the change** — a new page, a new endpoint, a control that the implementation adds — carries `"baseline": false`. The baseline still runs it: the seeds, the teardown, the login and every step before the new surface must work, and the step that needs the new surface is expected to fail. Keep `true` (the default) whenever the before-state is observable (an existing page that will change, an endpoint whose response changes).
  **The scenarios of one pass run at the same time, in separate runners** (API scenarios in one run without a browser, browser scenarios each in their own Chrome window when the account allows it). So every scenario owns its data: its teardown, seeds, steps and asserts touch only records that carry its own id (`QA-{{ticketIdUpper}}-S2-…` names, skus, memos, serials — the ticket id AND the scenario id), never a count or a list that another scenario's fixtures would change, never a global setting, never a restart of a component. A scenario that cannot keep to that (it changes a setting every user sees, asserts on a total across the whole org, restarts a worker) carries `"exclusive": true`: it runs alone after the parallel ones. Keep `false` (the default) whenever the scenario can be made self-contained — and make it so.
  **Seeding is part of the spec, and it is literal — and it resets before it creates.** Every scenario whose seed creates records declares `teardown` first: `shell:`/`sql:` commands, run by the orchestrator before the seeds of EVERY pass, that delete this scenario's whole fixture set by natural key (its records carry the ticket id: `QA-{{ticketIdUpper}}…` names, skus, memos, serials) — documents first (fulfillments, receipts, movements, serials), then master data — and succeed when there is nothing to delete. A seed then creates exactly what the asserts need with `create`/`INSERT` (not `get_or_create` with defaults, which silently keeps a stale record's old attributes); the only `get_or_create` is for shared roots like an org or company. Records the app refuses to delete (posted documents, used serial numbers) get a per-pass suffix: write `{{qaPass}}` literally inside such values (`"serial_numbers": ["QA-X001-{{qaPass}}"]`, memo `QA-{{ticketIdUpper}} {{qaPass}}`) — Stagehand replaces it with a short id unique to each QA pass, in seeds, steps and asserts alike, so nothing collides with an earlier pass. A design without a teardown for a creating seed fails the contract. `seed` lists, in order, every piece of data the journey depends on, as steps of exactly two kinds:
  - `shell: <one self-contained command>` — run by the orchestrator from the worktree root before the QA run, without any agent. Use it for everything that can be done with SQL, curl or a repo script: e.g. `shell: PW=$(grep -A8 '[database]' backend/configs/stagehand.cfg | grep '^password' | sed 's/.*=//' | tr -d ' "'); PGPASSWORD="$PW" psql -h localhost -p 5433 -U northspyre -d ns_deal -v ON_ERROR_STOP=1 -c "INSERT INTO … SELECT … WHERE NOT EXISTS (…)"`. Every command must be idempotent (WHERE NOT EXISTS / ON CONFLICT DO NOTHING / check-before-create) because it runs in both passes, must print something useful on success (e.g. the created id), and must be exact: you have the repo now — read the models (`__tablename__`, columns, NOT NULL constraints, enum/UUID constants) and write the real statement with the concrete values (names, amounts, dates) the asserts refer to. Never leave schema discovery to the QA runner. Every `psql … -c "…"` seed is dry-run against the real database (inside BEGIN … ROLLBACK) when this design is validated: a column, table or expression the database rejects fails the contract and comes back to you — so check `\d <table>` yourself before writing it.
    A seed that needs the application's own code (a Django/Flask shell, a repo script) calls the interpreter the way the repository's own commands do — `poetry run python <path/to/manage.py> …`, `uv run python …`, `npx …` — never a bare `python`/`node`: the orchestrator's shell has no such command, and the seed fails in QA, not here. Use the manage.py path the repository actually has.
  - `ui: <exact clicks on a real route>` — the fallback, not the default: only for something the app's own business logic must produce (a computed id/number, a workflow status transition, a record that must exist through the app's normal creation path because a plain INSERT would skip validation or side effects the scenario depends on). Prefer `shell:` SQL for everything else — it is cheaper, faster, and does not burn the scenario's `ui:` budget. Never a `ui:` step that edits spreadsheet-style tables (pro forma cells, lot mix rows) or that fills out a routine multi-field form whose fields map directly onto a table's columns: that has exhausted whole QA runs; write those rows with `shell:` SQL instead, keyed by the deal/pro forma name or equivalent natural key. When in doubt, write the `shell:` INSERT — read the schema (`\d <table>`) once, then insert directly.
  A scenario may have at most 2 `ui:` steps; there is no limit on `shell:` steps. Environment seeding hints (verbatim, use them): {{seedHints}} Use an existing fixture only when the repo guarantees it. Never a step a human must perform; if the runner cannot create the data (third-party account, production data), drop that scenario and say so in `qaSkippedReason`. Seeds run in both passes (before and after implementation): names carry the ticket id, check-before-create where a duplicate would break the assert. `seed: []` only when the journey needs nothing beyond a logged-in user.

## When you get the baseline result

The notes above can carry the result of the QA baseline on your scenarios. Then do this, and nothing else:
- **Read every scenario's outcome and observation.** The baseline runs the app before the change.
- **A correct scenario** — the seeds ran, every step was possible, and the observation shows today's behaviour. An assert on the new behaviour fails in the baseline; that is correct. Keep the scenario unchanged.
- **A wrong scenario** — a seed or teardown failed, a route, control or endpoint does not exist, a step used the wrong shape, the scenario was blocked, or the observation shows that the scenario does not test the ticket. Correct it in `design.json`: the seed, the steps, the asserts, or the whole scenario. Remove a scenario that cannot work, and add a better one if the ticket needs it.
- **An environment problem** (a service down, a migration not applied) — you cannot correct it. Keep the scenario, and say so in one bullet of Problem statement only when it changes the proposal.
- **Change `design.md` only** when the baseline shows that a fact in the proposal is wrong.
- Leave `design.json` `qa` byte-for-byte unchanged when every scenario is correct: an unchanged `qa` ends the loop and sends the proposal to the reviewer. A changed `qa` runs the baseline again.

Follow the repo's coding guidelines (CLAUDE.md) — naming, layering and typing rules included; never put ticket ids in source code.

## Output contract

Never end your turn while a command you started in the background is still running: this is a headless run, no completion notification ever arrives, and the process exit kills the command. Run long commands in the foreground (raise the timeout) or block on their output before you go on.

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
      "teardown": [ "shell: PW=$(…); PGPASSWORD=\"$PW\" psql -h localhost -p 5432 -U app -d app_db -v ON_ERROR_STOP=1 -c \"DELETE FROM … WHERE name LIKE 'QA-{{ticketIdUpper}}%'\"" ],
      "seed": [ "ui: open /projects, click New project, name it QA-{{ticketIdUpper}}, save", "shell: PW=$(…); PGPASSWORD=\"$PW\" psql -h localhost -p 5432 -U app -d app_db -v ON_ERROR_STOP=1 -c \"INSERT INTO … VALUES ('QA-{{ticketIdUpper}} widget {{qaPass}}', …)\"" ],
      "steps": [ { "action": "...", "assert": "...", "shot": true } ]
    }
  ],
  "qaSkippedReason": null
}
```

Then reply with exactly one line: `DONE`.
