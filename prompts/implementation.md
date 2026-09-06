This is the IMPLEMENTATION stage for ticket {{ticketId}} in the worktree {{worktree}} on branch `{{branch}}`. The approved design is in `{{taskDir}}/design.md` and `{{taskDir}}/design.json`; research in `{{taskDir}}/research.md`. Read design.json first. Load the `/coding-guidelines` skill before writing code.

{{repoLayout}}

{{reviewerNotes}}

## Rules

- Unit TDD: for each entry in `testPlan`, write the tests first (red), then the implementation (green). Add tests if you find gaps; never drop a planned case.
- Use the repo's own commands, as documented in its CLAUDE.md / Makefile / pyproject, for tests, coverage and type-checking (northspyre-deal: `uv run pytest`, `npm test`, `uv run basedpyright --level error`; other repos: whatever CLAUDE.md prescribes). Run the targeted tests after each slice.
- Coverage on NEW lines must exceed 90% (e.g. `pytest --cov=<touched modules> --cov-report=term-missing <paths>`); add tests until it does.
- Gates before you finish: all targeted tests green AND the repo's type-checker/linter clean. Fix at the source — no `# type: ignore`, `# pyright: ignore`, `cast`, or baseline entries.
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
