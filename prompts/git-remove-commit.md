This is a GIT HISTORY EDIT the human asked for directly through the UI (Code changes → Delete on the commits picked) — not a normal stage of this task's pipeline. You have permission here to use `git rebase`, `git commit --amend`, and other history-rewriting commands, scoped ONLY to this one instruction. Never push, never force-push, never touch GitHub (`gh`) in this run — the human reviews the result and pushes it themselves.

Repository: `{{repo}}` — every git command below runs inside `{{cwd}}`, on branch `{{branch}}`.

## Task

Remove these commits from the branch entirely — not a revert (a new commit undoing them), an actual removal from history, as if they had never been committed:

{{commits}}
{{humanNote}}

## Steps

1. Confirm you're in `{{cwd}}`, on branch `{{branch}}`, and the worktree is clean.
2. Drop them newest first — {{removeSteps}}. Each drops exactly one commit and replays every commit after it on top of its parent; going newest first keeps the older shas valid.
3. If the rebase reports conflicts: resolve them with the same judgment you'd use fixing any other bug — read the conflicting file, understand what the commit being removed changed and what each side of the conflict now expects, produce correct code (not just "pick one side"), `git add` the resolved files, `git rebase --continue`. Repeat until the rebase finishes. If a conflict is genuinely unresolvable without information only the human has, run `git rebase --abort` first, then explain exactly what's blocking it — never leave a rebase half-done.
4. Once the rebase completes cleanly, re-run the affected tests and the repo's type-checker/linter (commands per the repo's CLAUDE.md) — removing a commit can break something it never touched directly. Fix anything that breaks; don't weaken assertions to make it pass.
5. Do not commit anything beyond what the rebase itself produced (fixes for conflicts or breakage go into the commit(s) they belong to, via `git rebase --continue` after `git add`, not a new trailing commit) — the resulting history should read as if the removed commits' changes never happened, cleanly.
6. Do not push. Leave the rewritten history local.

## Reply

Plain text, not a file, not JSON — this has no output contract. Say plainly: whether the commits were removed cleanly or conflicts were hit, how each conflict was resolved (or, if aborted, exactly why), and the result of the test/type-check re-run.
