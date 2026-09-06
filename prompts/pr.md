This is the PR DRAFT step for ticket {{ticketId}} in worktree {{worktree}} on branch `{{branch}}` against `{{baseBranch}}`. Do NOT create the PR, do not push, do not post anything to GitHub. Only draft.

{{repoLayout}} If the workspace has several repositories, run the git commands below in each repository that has commits ahead of `{{baseBranch}}` and draft one PR per such repository (put the extra drafts in `body` under a `## Companion PRs` heading, one per repository).

1. Read `.github/pull_request_template.md` in the repo and `{{taskDir}}/impl.json`, `{{taskDir}}/design.json`.
2. Look at `git log --oneline origin/{{baseBranch}}..HEAD` and `git diff --stat origin/{{baseBranch}}...HEAD`.
3. Draft the PR title: it MUST begin with the uppercase ticket id, then a short imperative phrase — e.g. `{{ticketIdUpper}} Fix recoverables WS handler`. No adjectives like comprehensive/robust/seamless, no benefit framing.
4. Draft the body by filling every section of the template. Description: 1–2 sentences, what the diff adds/changes/fixes, class and route names quoted. QA instructions: concrete steps a reviewer can follow. Tick the right checkboxes.

## Output contract

Write `{{taskDir}}/pr.json`:

```json
{ "title": "...", "body": "...", "base": "{{baseBranch}}" }
```

Then reply with exactly one line: `DONE`.
