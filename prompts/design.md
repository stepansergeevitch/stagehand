This is the DESIGN PROPOSAL stage for ticket {{ticketId}}. You are now in the task worktree at {{worktree}} on branch `{{branch}}` (base `{{baseBranch}}`). Your research is in `{{taskDir}}/research.md` and `{{taskDir}}/research.json` — read both first. Do not write application code, do not commit.

{{repoLayout}}

{{reviewerNotes}}

## What to produce

1. **Classification** — confirm or correct `bug`/`feature` from research.
2. **Scope** — in-scope / out-of-scope, derived from the ticket's own description and acceptance criteria (not a parent epic's).
3. **Implementation plan by layer** — group by `ws`, `api`, `service`, `repo`, `ast`, `fe`; omit layers with no change. For each layer: the concrete changes (files, functions, classes), and the before → after behaviour. For a bug: the root cause first, then the minimal fix.
4. **Test plan** — per file to be touched, the unit test cases (pytest for backend, Jest for frontend) that will be written FIRST: wide behavioural coverage, all corner cases (empty/null, boundaries, error paths, off-by-one, ordering), one assertion focus per test, descriptive names.
5. **QA scenarios** — at most 3 browser journeys that a later automated run will execute with claude-in-chrome against https://localhost:3000. Each scenario is a single sequential session: id `S1`..`S3`, a title, the starting URL (real routes from this repo, e.g. `/deals`, `/deal/{dealId}/pro_forma/{pfId}/table`), the persona, and ordered steps of `action` → `assert`. Mark with `"shot": true` the steps whose asserted state must be screenshotted (at least one per scenario). Test the NEW behaviour directly — a regression smoke is a supplement, never the whole plan. Consolidate related cases into one journey. Return zero scenarios ONLY when the change has no user-visible UI (backend-only, refactor, config) and say why in `qaSkippedReason`.

Follow the repo's coding guidelines (CLAUDE.md): UnitOfWork `uow=` never `db=`, kebab-case plural routes, no ticket ids in source code, no `# type: ignore`/`cast` to silence typing.

## Output contract

Write `{{taskDir}}/design.md` — the human-readable proposal covering all five points, written for the reviewer to approve or push back on.

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
      "steps": [ { "action": "...", "assert": "...", "shot": true } ]
    }
  ],
  "qaSkippedReason": null
}
```

Then reply with exactly one line: `DONE`.
