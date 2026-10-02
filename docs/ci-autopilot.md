# CI autopilot — design (draft)

A task fixes the CI failures it obviously caused, without the human: it triages a finished red run, fixes only the
failures on a whitelist, has the fix reviewed by the AI code review, and pushes. Everything else stays for the human,
as today ("Fix CI" button, blocked status).

## Today

- `pollPr` stores each PR's `statusCheckRollup`; `prRepoSummary` reports **failed as soon as one check fails, even while
  others run**; `syncPrTaskState` then sets the task `pr_waiting · blocked` and notifies once.
- "Fix CI" (`startPrFix`) is human-only: a `pr_fix` round per repository, commits locally, the human reviews the diff,
  Approve → `pushPrFix`.
- The AI code review (`code_review` stage, gstack checklist) runs only after Implementation.

## Trigger

Per repository PR, when **all** its gated checks are complete (none pending) and at least one failed — not on the first
red check. The autopilot looks at a head SHA once.

Skipped when: the task's toggle is off; a run is in progress; the round cap is reached (below). A commit someone else
pushed (a human, a bot) is pulled as today; its CI run is just the next run the autopilot looks at.

## 1. Triage — what failed, and is it ours?

A read-only agent run (fresh session, no edits) per repository. It reads the failed jobs' logs (`gh run view --log-failed`)
and the branch diff against the merge-base, and writes `ci-triage.json`:

```json
{ "failures": [ {
    "check": "backend-tests", "kind": "own_test | affected_test | own_lint | own_migration | other",
    "what": "tests/test_budget.py::test_list_query_budget", "files": ["app/views/items.py:88"],
    "evidence": "log excerpt", "verdict": "allow | deny", "reason": "…" } ] }
```

Deny by default: a failure the agent cannot tie to the branch is `other`.

## 2. Verification — Stagehand checks each "allow" mechanically

The triage agent only extracts identifiers from the logs (`file:line`, a test id, a migration file); git and GitHub
decide.

- **Changed lines:** `base = git merge-base HEAD origin/<base branch>` per repository; `git diff -U0 -M <base>..HEAD`
  parsed hunk by hunk (`@@ -a,b +c,d @@` → new-side ranges): `file → changed line ranges`. CI log paths
  (`/home/runner/work/<repo>/<repo>/app/x.py`) are cut to the repository-relative path.
- **own_lint:** every reported `file:line` must be inside the file's ranges; the others in the same check are denied
  (the fix brief gets only the allowed lines).
- **own_test:** the test file is added (`A`), or the test's own span overlaps the ranges — the span is found in the head
  file (`def test_x` and its indented body; `it("…")` / `test("…")` blocks in JS). A changed file with an untouched
  test → `affected_test`.
- **own_migration:** the migration file is `A` in `git diff --name-status <base>..HEAD`; a conflict is allowed when one
  of the leaves the log names was added by the branch.
- **affected_test:** the test's file exists at base (`git cat-file -e <base>:<path>`) and the test passes there:
  `gh api repos/{o}/{r}/commits/<base>/check-runs`, the check of the same name concluded `success` (the whole job was
  green, so the test passed); otherwise a local base run (below). Passes → allow; fails on base → deny.

A wrong "allow" from the agent is turned into deny by these checks; a wrong "deny" only leaves a failure for the human.

The agent proposes; Stagehand decides from git and CI facts. A failure that does not pass its check becomes `deny`.

| Kind | Allowed when | Check |
|---|---|---|
| `own_migration` | a migration conflict, or a migration that fails to apply, and the migration was **added by this branch** | the file is in `git diff --name-status <merge-base>..HEAD` as `A` (same detection as `migrate-down-*.py`); a conflict = two leaves, one of them the branch's |
| `own_test` | a test the branch **added or changed** fails | the test file is changed by the branch (and, when the log names the test function, its lines are in the diff) |
| `affected_test` | a test the branch did not touch fails **because of** the branch (query budget, snapshot, API contract) | it **passes on base**: the same job is green on the merge-base commit's CI run; when the merge-base has no run, run that one test on base locally (below) |
| `own_lint` | a lint error on a line the branch **added or changed** | `file:line` is inside the `+` hunks of `git diff -U0 <merge-base>..HEAD` — the file being touched is not enough |

Your examples: a query-budget test fails because of a new query → `affected_test`, base green → allow. A lint error in a
touched file, on a line the branch did not change → deny. The branch's migration fails to apply → allow. A failing test
in a touched module that also fails on base → deny.

**Local base run** (fallback for `affected_test`): a detached worktree at the merge-base (`git worktree add --detach`),
the env's setup, only the named test(s) through a new env setting — the command that runs named tests
(`poetry run pytest {{tests}}`) — then removed. Costly — used only when CI has no green run of that check on the base.

## 3. Fix

When at least one failure is allowed: a `pr_fix` round (`operation: "pr_fix_autopilot"`) whose brief lists **only the
allowed failures**, and the denied ones under "do not touch". Scope rule in the prompt: change only what these
failures need; no refactors, no other files. The env's verification command runs after it, as for every `pr_fix`.

## 4. AI code review of the fix

A fresh `code_review`-style run on **the fix commits only** (`<head-before>..HEAD`), with the triage as context. It
also checks the fix stayed in scope (no test weakened or skipped, no lint rule disabled, no migration edited that the
base has).

- Clean (no P0/P1 at confidence ≥ 7) → push (`pushPrFix`, a plain push of new commits), checks run again.
- Serious findings → the agent addresses them (one more fix pass with the findings as the brief, as Implementation does
  after Code Review today), then the push goes ahead; every finding stays visible on the Autopilot card.

## 5. Loop guards

- One autopilot round per head SHA.
- At most **5 autopilot rounds in a row** per task; the next red run after that waits for the human. Any human action
  on the task resets the count.
- The same check failing again after an autopilot push, for the same failure, stops the autopilot for the task.

## Human visibility

- **Notifications:** "Autopilot fixed 2 CI failures on #123 and pushed abc1234" / "CI red on #123: 1 failure outside
  the autopilot's list — needs you" (with what was denied and why).
- **Task page, PR section:** an Autopilot card — the triage table (check, kind, verdict, reason, evidence), the review
  verdict, the pushed commits; the denied failures keep the "Fix CI" button.
- **Toggle:** per task, "CI autopilot" in the task header; a new task takes its env's default (on by default).

## Data

- `envs.ci_autopilot INTEGER NOT NULL DEFAULT 1` (the default for its new tasks), `envs.test_command TEXT` (runs named
  tests, `{{tests}}`, for the local base run).
- `tasks.ci_autopilot INTEGER` (set from the env at creation).
- `<taskDir>/ci-autopilot.json`: rounds `[{ repo, headSha, triage, verified, fixCommits, review, pushed, at }]`.

## Change to today's behaviour

The task no longer goes `blocked` on the first failing check while others run: with the autopilot on it shows
"PR Waiting · 1 failing, 3 running" and decides when the run is complete. With the autopilot off, today's behaviour stays.

## Decided (2026-10-02)

1. "Passes on base": CI on the merge-base commit first, local base run as fallback.
2. AI review findings: the agent addresses them, then the push goes ahead.
3. Partial red: the allowed failures are fixed and pushed; the denied ones stay for the human.
4. Someone else's push: pulled as today; the autopilot goes on with the next red run.
5. At most 5 rounds in a row; per-task toggle with an env default (on).
