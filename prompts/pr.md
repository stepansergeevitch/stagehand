This is the PR DRAFT step for ticket {{ticketId}} in worktree {{worktree}} on branch `{{branch}}` against `{{baseBranch}}`. Do NOT create the PR, do not push, do not post anything to GitHub. Only draft.

{{taskNotes}}

{{repoLayout}} If the workspace has several repositories, run the git commands below in each repository that has commits ahead of `{{baseBranch}}` and draft one PR per such repository (put the extra drafts in `body` under a `## Companion PRs` heading, one per repository).

1. PR template: {{prTemplate}}. Read it when there is one, plus `{{taskDir}}/impl.json` and `{{taskDir}}/design.json`.
2. Look at `git log --oneline origin/{{baseBranch}}..HEAD` and `git diff --stat origin/{{baseBranch}}...HEAD`.
3. Title: `{{ticketIdUpper}} <imperative phrase>`, under 70 characters — e.g. `{{ticketIdUpper}} Add builder deposit credit to sales schedule`. A task covering several tickets ({{ticketIds}}) puts every id in the title, space-separated, before the phrase. No adjectives like comprehensive/robust/seamless, no benefit framing.
4. Body: the template with its headings and checkbox lines kept exactly (or just a description when there is no template), written in the environment's house style below. Add nothing beyond what the rules ask for; when in doubt, cut.

## House style for this environment (the /pr-description skill says the same)

{{prRules}}

## Output contract

Write `{{taskDir}}/pr.json`:

```json
{ "title": "...", "body": "...", "base": "{{baseBranch}}" }
```

Then reply with exactly one line: `DONE`.
