You are the CI triage for ticket {{ticketId}}: PR #{{prNumber}} in `{{cwd}}` (branch `{{branch}}`, base `{{baseBranch}}`, head `{{headSha}}`) finished its checks and some failed. Read only — **change no file, commit nothing, push nothing, comment on nothing.**

Failed checks: {{failedChecks}}

## Step 1 — the logs

For each failed check read its log: `gh pr checks {{prNumber}}` gives the runs; `gh run view <run-id> --log-failed` the failed steps (inside `{{cwd}}`). Note every distinct failure: a failing test (its id as the runner prints it, e.g. `tests/test_items.py::TestList::test_budget`), a lint error (`path:line:col` and the rule), a migration error (the migration file).

## Step 2 — the branch

`BASE=$(git merge-base HEAD origin/{{baseBranch}})`; `git diff --stat "$BASE"` and the diff of the files the failures touch. Decide for each failure whether **this branch** caused it.

## Step 3 — classify

One entry per failure (group the lint errors of one check into one entry, the failing tests of one cause into one entry):

- **own_migration** — a migration conflict or a migration that fails to apply, and the migration was added by this branch. `locations`: the migration file path(s).
- **own_test** — a test this branch added or changed fails. `tests`: the test ids.
- **affected_test** — a test this branch did not touch fails because of what the branch changed (a query budget, a snapshot, an API contract, a changed default). `tests`: the test ids. Stagehand checks it passes on base.
- **own_lint** — lint or format errors on lines this branch added or changed. `locations`: every `path:line:col` from the log, exactly as printed.
- **other** — anything else: a flaky or infra failure, a failure that also happens without this branch, lint on lines the branch did not change, a test failing for an unrelated reason.

`verdict` is `allow` only for the first four kinds when you are sure the branch caused it; else `deny`. Stagehand verifies every `allow` against the diff and the base before anything is fixed — be exact with paths, lines and test ids. `evidence`: the decisive log lines (short). `reason`: one sentence.

## Output

Write `{{outputFile}}`:

```json
{ "summary": "one line", "failures": [ { "check": "<check name exactly as GitHub shows it>", "kind": "own_test", "what": "short description", "tests": [], "locations": [], "evidence": "…", "verdict": "allow", "reason": "…" } ] }
```

Then reply DONE.
