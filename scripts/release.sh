#!/bin/bash
# Lands a worktree branch on main and restarts the live app, in one go:
#   1. boundary check — no run running, no task running/queued (skip with --force: runs are killed, Retry resumes them)
#   2. rebase the branch onto main (in its worktree), fast-forward main to it (main's uncommitted files are stashed around it)
#   3. npm install when the lockfile changed, build the web bundle
#   4. stop the preview and remove the worktree + branch (keep them with --keep)
#   5. restart the live server in its tmux pane from a detached process (the caller may die with the server), wait for /api/health
#
#   scripts/release.sh <branch> [--force] [--keep]
# Never pushes. Prints what it did; exits non-zero at the first step that fails, with main untouched when the rebase fails.
set -euo pipefail

BRANCH="${1:-}"
[ -n "$BRANCH" ] || { echo "usage: release.sh <branch> [--force] [--keep]" >&2; exit 2; }
shift
FORCE=0; KEEP=0
for a in "$@"; do case "$a" in --force) FORCE=1 ;; --keep) KEEP=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done

# The main checkout — the one that owns .git — even when this copy of the script runs from a worktree (its
# --show-toplevel would be the worktree itself, and the release would "land" onto the branch and remove it).
REPO="$(dirname "$(cd "$(dirname "$0")/.." && git rev-parse --path-format=absolute --git-common-dir)")"
DB="${STAGEHAND_HOME:-$HOME/.stagehand}/stagehand.sqlite"
TMUX_SESSION="${STAGEHAND_TMUX:-stagehand-server}"
START_CMD="cd $REPO/server && npx tsx src/index.ts 2>&1 | tee ${STAGEHAND_HOME:-$HOME/.stagehand}/server.log"
API="http://127.0.0.1:${STAGEHAND_API_PORT:-4747}"

say() { echo "release: $*"; }

# 1. boundary
running=$(sqlite3 "$DB" "select count(*) from runs where status='running';")
busy=$(sqlite3 "$DB" "select count(*) from tasks where status in ('running','queued');")
if [ "$running" != "0" ] || [ "$busy" != "0" ]; then
    if [ "$FORCE" = "1" ]; then say "forced: $running run(s) running, $busy task(s) running/queued — they are killed by the restart (Retry resumes them)"
    else echo "release: not a boundary — $running run(s) running, $busy task(s) running/queued. Wait, or pass --force." >&2; exit 3; fi
fi

# 2. rebase + fast-forward
WT="$(git -C "$REPO" worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '$1=="worktree"{p=$2} $1=="branch"&&$2==b{print p}')"
[ -n "$WT" ] || { echo "release: no worktree checks out branch $BRANCH (git worktree list)" >&2; exit 2; }
[ "$WT" != "$REPO" ] || { echo "release: $BRANCH is checked out in the main checkout itself ($REPO) — land from a worktree" >&2; exit 2; }
[ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "release: the main checkout is on $(git -C "$REPO" rev-parse --abbrev-ref HEAD), not main" >&2; exit 2; }
if [ -n "$(git -C "$WT" status --porcelain)" ]; then echo "release: $WT has uncommitted changes — commit them first" >&2; exit 2; fi
say "rebasing $BRANCH onto main"
git -C "$WT" rebase main >/dev/null || { git -C "$WT" rebase --abort; echo "release: rebase of $BRANCH onto main conflicts — resolve in $WT, then run again" >&2; exit 4; }
before=$(git -C "$REPO" rev-parse --short HEAD)
stashed=0
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then git -C "$REPO" stash push -q -m "release.sh: main's uncommitted files"; stashed=1; fi
if ! git -C "$REPO" merge --ff-only "$BRANCH" >/dev/null; then
    [ "$stashed" = "1" ] && git -C "$REPO" stash pop -q
    echo "release: main could not fast-forward to $BRANCH" >&2; exit 4
fi
[ "$stashed" = "1" ] && git -C "$REPO" stash pop -q
after=$(git -C "$REPO" rev-parse --short HEAD)
say "main $before → $after ($(git -C "$REPO" rev-list --count "$before..$after") commit(s))"

# 3. dependencies + web bundle
if git -C "$REPO" diff --name-only "$before" "$after" | grep -qE '(^|/)package(-lock)?\.json$'; then
    say "lockfile changed — npm install"
    (cd "$REPO" && npm install --silent >/dev/null)
fi
say "building the web bundle"
(cd "$REPO/web" && npx vite build >/dev/null 2>&1) || { echo "release: web build failed — main is at $after; fix and run scripts/release.sh again or restart by hand" >&2; exit 5; }

# 4. cleanup — before the restart, because the caller may not survive it (see below)
"$REPO/scripts/preview.sh" stop >/dev/null 2>&1 || true
if [ "$KEEP" = "0" ]; then
    git -C "$REPO" worktree remove --force "$WT" && git -C "$REPO" branch -D "$BRANCH" >/dev/null && say "worktree and branch $BRANCH removed"
fi

# 5. restart — from a detached process in its own session. Whoever runs this script may be a child of the server
# (Prompter's turn, an agent run): the Ctrl-C that stops the server would kill that caller, and with it a restart
# performed inline (2026-09-22: the server was stopped and never started again). Output goes to a log.
say "restarting the server in tmux $TMUX_SESSION (detached; a caller that runs under the server ends here — the API answers again in ~10 s)"
LOG="${STAGEHAND_HOME:-$HOME/.stagehand}/release.log"
RESTART="tmux send-keys -t '$TMUX_SESSION' C-c; sleep 2; tmux send-keys -t '$TMUX_SESSION' \"$START_CMD\" Enter; for i in \$(seq 1 60); do sleep 1; curl -sf '$API/api/health' >/dev/null && { echo \"\$(date '+%H:%M:%S') release: server up @ $after\"; exit 0; }; done; echo \"\$(date '+%H:%M:%S') release: the server did not answer within 60 s — tmux attach -t $TMUX_SESSION\"; exit 6"
perl -MPOSIX -e 'POSIX::setsid(); open(STDIN, "<", "/dev/null"); open(STDOUT, ">>", $ARGV[0]); open(STDERR, ">&", STDOUT); exec("sh", "-c", $ARGV[1]) or die "exec: $!";' "$LOG" "$RESTART" &
disown 2>/dev/null || true
# When this process survives the restart (a human's terminal), report the outcome here as well.
for i in $(seq 1 60); do sleep 1; curl -sf "$API/api/health" >/dev/null 2>&1 && { say "server up @ $after"; break; }; done
say "done"
