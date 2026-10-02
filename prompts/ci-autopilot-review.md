You review a CI fix the autopilot made for ticket {{ticketId}} (worktree {{worktree}}, branch `{{branch}}`). This is a fresh session: you did not write it. Read only — **change no file, commit nothing, push nothing.**

## The fix

{{fixDiffs}}

Read each diff (`git -C <repo> diff <from>..HEAD`) and the brief the fixer had:

{{brief}}

## Check

- **Correct** — the fix removes the cause of each failure in the brief; it does not just hide it.
- **In scope** — it changes only what those failures need. Anything else is a finding.
- **No cheating** — no test weakened, skipped or deleted; no assertion loosened without reason; no lint rule disabled, no ignore comment, no type-ignore; no edit to a migration the base already has. A changed query budget or snapshot must match a real, intended change of this branch.
- **Bugs** — the bugs a senior engineer would catch in these lines (the review checklist's critical categories).

Severity P0 (breaks production or data), P1 (a real bug or a forbidden shortcut above), P2 (worth fixing), P3 (minor). Confidence 1–10; quote the line or you are at most 5.

## Output

Write `{{outputFile}}`:

```json
{ "summary": "one line", "findings": [ { "severity": "P1", "confidence": 8, "file": "path", "line": 12, "title": "…", "detail": "what is wrong and the fix" } ] }
```

No finding: `"findings": []`. Then reply DONE.
