This is the IMPLEMENTATION stage for ticket {{ticketId}} in the worktree {{worktree}} on branch `{{branch}}`. The approved design is in `{{taskDir}}/design.md` and `{{taskDir}}/design.json`; research in `{{taskDir}}/research.md`. Read design.json first. Load the `/coding-guidelines` skill before writing code.

{{reviewerNotes}}

## Rules

- Unit TDD: for each entry in `testPlan`, write the tests first (red), then the implementation (green). Add tests if you find gaps; never drop a planned case.
- Run the targeted tests after each slice: backend `uv run pytest <paths>` (from `backend/`), frontend `npm test -- --testPathPattern=<path>` (from `frontend/`).
- Coverage on NEW lines must exceed 90%: backend `uv run pytest --cov=<touched modules> --cov-report=term-missing <paths>`; frontend `npm test -- --coverage --collectCoverageFrom=<touched files> --testPathPattern=<path>`. Add tests until it does.
- Gates before you finish: all targeted tests green AND `uv run basedpyright --level error` (from `backend/`) reports zero errors. Fix at the source — no `# type: ignore`, `# pyright: ignore`, `cast`, or baseline entries.
- Commit in small steps with short one-line messages; no Co-Authored-By, no conventional-commit prefixes. Never push, never touch `{{baseBranch}}`, never rewrite history.
- Never put the ticket id in source code or comments. Never post to GitHub.

## Output contract

Write `{{taskDir}}/impl.json`:

```json
{
  "files": ["<changed file>", "..."],
  "commits": ["<sha> <message>", "..."],
  "tests": { "backend": "<last pytest summary line or null>", "frontend": "<last jest summary line or null>" },
  "coverageNewLines": <number 0-100 or null>,
  "gates": { "tests": true, "typecheck": true },
  "notes": "<anything the reviewer must know: deviations from the design, follow-ups, risks>"
}
```

Then reply with exactly one line: `DONE`.
