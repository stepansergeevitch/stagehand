This is a REBASE the human asked for directly through the UI ("Rebase onto latest base") — not a stage of this task's pipeline. Bring the task branch `{{branch}}` up to date with the latest `origin/{{baseBranch}}` by rebasing, resolve whatever conflicts that raises in the spirit of this task's change, make sure the result still builds and passes the fast checks, and report. Do NOT push: Stagehand pushes the rebased branch itself (force-with-lease) when the environment allows it.

{{repoLayout}}

Worktree: `{{worktree}}` (every command below runs there; in a multi-repository workspace, inside each repository directory that has commits on this branch).

{{taskNotes}}

## What is known

- Base branch: `{{baseBranch}}` — the branch this task's PR targets. Behind by: {{behind}}.
- The task's accepted design is in `{{taskDir}}/design.md` (its Contract section says what must stay true) — the guide for resolving a conflict in favour of this task's intent versus what landed on the base.

## Steps

1. In each repository with commits on `{{branch}}`: `git fetch origin {{baseBranch}}`, confirm the tree is clean (`git status --porcelain` empty — if not, stop and say what is there), then `git rebase origin/{{baseBranch}}` (never `-i`).
2. On a conflict: read both sides and the design; keep this task's behaviour, take the base's changes for everything else, resolve the file, `git add` it, `git rebase --continue`. Do not create new commits and do not `--amend`: conflict resolutions are folded into the commit being replayed by the rebase itself. If a conflict cannot be resolved with confidence (the base removed or rewrote what this task builds on), `git rebase --abort` in that repository and explain — an aborted repository is left exactly as it was.
3. After a successful rebase, run the repository's fast checks on the touched areas — typecheck / lint and the tests this task added or changed (the commands the implementation stage used, or the repository's standard ones). A failure caused by the rebase (an API that moved, a renamed symbol) is yours to fix in the affected commit(s) — with a plain follow-up commit only if the environment allows commits and folding it into the replayed commit is impractical; say which.
4. Do not push, do not touch GitHub, do not run the browser.

## Reply

Plain text, not a file, not JSON — this has no output contract. For each repository: the base sha before/after (`git rev-parse` short), how many commits were replayed, which files had conflicts and how each was resolved (one line each), which checks you ran and their result, and whether the rebase was completed or aborted (and why). Nothing else.
