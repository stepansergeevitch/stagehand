Something on the open PR for ticket {{ticketId}} (worktree {{worktree}}, branch `{{branch}}`) needs a code fix — a failing CI check, or PR review comments the human picked out, described below. Diagnose and fix it at the source. This is fix round {{attempt}}; a human reviews your diff before anything reaches GitHub.

## What to address

{{failureOutput}}

{{taskNotes}}

{{reviewerNotes}}

## Rules

- If this is a failing CI check, diagnose from the logs above; use `mcp__circleci-mcp-server__get_build_failure_logs` / `get_job_test_results` if you need more. If it's PR comments, address each one directly — don't invent a CI failure to explain, and don't touch anything the comments didn't ask about.
- Do not weaken or delete failing assertions to make tests pass; do not add `# type: ignore`, `# pyright: ignore`, `cast`, or baseline entries.
- Re-run the affected tests and the repo's type-checker/linter locally (commands per the repo's CLAUDE.md) until green, even if nothing above mentioned a test failure — your change must not break anything else.
- {{commitRule}}
- Do **not** push, and do not open, comment on, or review anything on GitHub — a human reviews your diff first; the push happens only after they approve.

## Output contract

Write `{{taskDir}}/pr_fix.json`:

```json
{ "summary": "<one or two sentences: what was wrong, what you changed>" }
```

Then reply with exactly one line: `DONE`.
