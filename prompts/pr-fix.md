CI is red on the PR for ticket {{ticketId}} (worktree {{worktree}}, branch `{{branch}}`). Diagnose and fix it at the source. This is fix round {{attempt}}; a human reviews your diff before anything reaches GitHub.

## Failure output

{{failureOutput}}

{{reviewerNotes}}

## Rules

- Diagnose from the logs above; use `mcp__circleci-mcp-server__get_build_failure_logs` / `get_job_test_results` if you need more.
- Do not weaken or delete failing assertions to make tests pass; do not add `# type: ignore`, `# pyright: ignore`, `cast`, or baseline entries.
- Re-run the failing tests and the repo's type-checker/linter locally (commands per the repo's CLAUDE.md) until green.
- {{commitRule}}
- Do **not** push, and do not open, comment on, or review anything on GitHub — a human reviews your diff first; the push happens only after they approve.

## Output contract

Write `{{taskDir}}/pr_fix.json`:

```json
{ "summary": "<one or two sentences: what was wrong, what you changed>" }
```

Then reply with exactly one line: `DONE`.
