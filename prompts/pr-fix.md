Something on the open PR for ticket {{ticketId}} (worktree {{worktree}}, branch `{{branch}}`) needs work — a failing CI check, PR review comments the human picked out, a rebase whose plain replay conflicted, or instructions from the human; possibly several of these batched as numbered jobs, described below. Do them in the order given, and fix causes at the source. This is fix round {{attempt}}; a human reviews your diff before anything reaches GitHub.

## What to address

{{shardNote}}

{{failureOutput}}

{{taskNotes}}

{{components}}

{{reviewerNotes}}

{{askHuman}}

## Rules

- If this is a failing CI check, diagnose from the logs above; use `mcp__circleci-mcp-server__get_build_failure_logs` / `get_job_test_results` if you need more. If it's PR comments, address each one directly — don't invent a CI failure to explain, and don't touch anything the comments didn't ask about.
- Do not weaken or delete failing assertions to make tests pass; do not add `# type: ignore`, `# pyright: ignore`, `cast`, or baseline entries.
- Re-run the affected tests and the repo's type-checker/linter locally (commands per the repo's CLAUDE.md) until green, even if nothing above mentioned a test failure — your change must not break anything else.
- Never end your turn while a command you started in the background is still running: this is a headless run, no completion notification ever arrives, and the process exit kills the command. Run long commands in the foreground (raise the timeout) or block on their output before you go on.
- {{commitRule}}
- Do **not** push, and do not open, comment on, or review anything on GitHub — a human reviews your diff first; the push happens only after they approve.

## Turn budget

You have about {{maxTurns}} tool calls. At four fifths of that stop opening new work: commit what is done, write the output file, reply DONE. A run that ends without the file is continued in the same session at most twice; what you commit before that is kept.

## Output contract

Write `{{taskDir}}/{{outputFile}}`:

```json
{
  "summary": "<one or two sentences: what was wrong, what you changed>",
  "comments": [
    { "id": 123, "addressed": true, "commit": "<sha of YOUR commit that addresses this comment>", "note": "" },
    { "id": 456, "addressed": false, "commit": "", "note": "<why not: already done, out of scope, needs the human — one sentence>" }
  ]
}
```

`comments`: one entry for every PR comment marked `[comment #<id>]` above (leave it `[]` when there are none). `addressed: true` only when a commit of yours in this run actually changes what the comment asked for — then `commit` is that commit's sha (prefer one commit per comment, so the reply links to exactly the change). A comment you answered without changing code, judged wrong, or left for the human is `addressed: false` with the reason in `note`. These entries become "Addressed in <commit>" replies on GitHub, so never mark a comment addressed by a commit that doesn't change it.

Then reply with exactly one line: `DONE`.
