CI is red on the PR for ticket {{ticketId}} (worktree {{worktree}}, branch `{{branch}}`). Fix it at the source and push the branch. This is fix round {{attempt}} of 3.

## Failure output

{{failureOutput}}

## Rules

- Diagnose from the logs above; use `mcp__circleci-mcp-server__get_build_failure_logs` / `get_job_test_results` if you need more.
- Do not weaken or delete failing assertions to make tests pass; do not add `# type: ignore`, `# pyright: ignore`, `cast`, or baseline entries.
- Re-run the failing tests locally and `uv run basedpyright --level error` until green.
- Commit with a short one-line message and `git push origin {{branch}}`. Never force-push, never touch `{{baseBranch}}`, never post comments/reviews on GitHub.

Reply with exactly one line when pushed: `DONE`.
