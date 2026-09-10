This is the PR DRAFT step for ticket {{ticketId}} in worktree {{worktree}} on branch `{{branch}}` against `{{baseBranch}}`. Do NOT create the PR, do not push, do not post anything to GitHub. Only draft.

{{taskNotes}}

{{askHuman}}

{{repoLayout}}

## One draft per repository

Every repository that has commits ahead of `origin/{{baseBranch}}` gets its own pull request, so it gets its own draft: its own title, its own body written on that repository's own template. A single-repository project has exactly one draft with `"repo": ""`. In a multi-repository workspace, run the git commands below inside each repository directory and write one entry per repository that has commits; `repo` is the directory name exactly as listed above (e.g. `backend`, `frontend`). Repositories with no commits get no entry. Do not describe one repository's change in another's body; if the PRs belong together, one short sentence "Companion PR: <other repo>" in each body is enough — no link, it does not exist yet.

1. PR templates: {{prTemplate}}. Read the template of each repository you draft for, plus `{{taskDir}}/impl.json` and `{{taskDir}}/design.json`.
2. In each repository: `git log --oneline origin/{{baseBranch}}..HEAD` and `git diff --stat origin/{{baseBranch}}...HEAD`.
3. Title: `{{ticketIdUpper}} <imperative phrase>`, under 70 characters — e.g. `{{ticketIdUpper}} Add builder deposit credit to sales schedule`. A task covering several tickets ({{ticketIds}}) puts every id in the title, space-separated, before the phrase. No adjectives like comprehensive/robust/seamless, no benefit framing. Each repository's title describes that repository's change.
4. Body: that repository's template with its headings and checkbox lines kept exactly (or just a description when there is no template), written in the environment's house style below. Add nothing beyond what the rules ask for; when in doubt, cut.

## House style for this environment (the /pr-description skill says the same)

{{prRules}}

## Output contract

Write `{{taskDir}}/pr.json`:

```json
{
  "base": "{{baseBranch}}",
  "drafts": [
    { "repo": "<directory name, or \"\" for a single-repo project>", "title": "...", "body": "..." }
  ]
}
```

Then reply with exactly one line: `DONE`.
