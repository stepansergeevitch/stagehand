This is the IMPLEMENTATION stage for ticket {{ticketId}} in the worktree {{worktree}} on branch `{{branch}}`. The approved design is in `{{taskDir}}/design.md` and `{{taskDir}}/design.json`; research in `{{taskDir}}/research.md`. Read design.json first. Load the `/coding-guidelines` skill before writing code.

{{repoLayout}}

{{taskNotes}}
{{components}}
{{appTools}}

{{reviewerNotes}}

{{askHuman}}

## Rules

- Unit TDD: for each entry in `testPlan`, write the tests first (red), then the implementation (green). Add tests if you find gaps; never drop a planned case.
- Use the repo's own commands, as documented in its CLAUDE.md / Makefile / pyproject, for tests, coverage and type-checking (whatever CLAUDE.md prescribes, e.g. `uv run pytest`, `npm test`, `uv run basedpyright --level error`). Run the targeted tests after each slice.
- Coverage on NEW lines must exceed 90% (e.g. `pytest --cov=<touched modules> --cov-report=term-missing <paths>`); add tests until it does.
- In a Django repository, after any model or migration change, also run `manage.py check --database default` and `manage.py makemigrations --check --dry-run` from the backend and make both pass: plain `manage.py check`, pytest and the dev server skip the database-dependent checks (an index name over 30 characters passes all of them, then fails `migrate` in production). If the environment defines a verification command, Stagehand runs it after you finish and sends a failure back to you.
- Gates before you finish: all targeted tests green AND the repo's type-checker/linter clean. Fix at the source — no `# type: ignore`, `# pyright: ignore`, `cast`, or baseline entries.
- {{commitRule}} Never touch `{{baseBranch}}`, never rewrite history. Never push from this stage.
- Never put the ticket id in source code or comments. Never post to GitHub.
- Never end your turn while a command you started in the background is still running: this is a headless run, no completion notification ever arrives, and the process exit kills the command. Run long commands in the foreground (raise the timeout) or block on their output before you go on.
- If reviewer notes are present above, they come from a human reading your diff: fix every point (line comments name `path:line` in the current diff and quote the line), re-run the gates, and account for each point in `notes`.

## Turn budget

You have about {{maxTurns}} tool calls. At four fifths of that stop opening new work: commit what is done, write the output file, reply DONE. A run that ends without the file is continued in the same session at most twice; what you commit before that is kept.

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
