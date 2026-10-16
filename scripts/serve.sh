#!/bin/bash
# Runs the Vortex server in a loop inside its tmux pane: whenever the server process exits — the Ctrl-C of a
# restart, a crash — it starts again two seconds later from the checkout as it is then. A restart is therefore only
# "stop the current process"; nobody has to survive it to send a start command (Prompter's turn and every agent run
# are children of the server and die with it — 2026-09-22 twice the server stayed down for that reason).
#
#   scripts/serve.sh            run in tmux session vortex-server (release.sh and POST /api/server/restart start it)
#   touch ~/.vortex/stop-server ; then Ctrl-C     stop for real (or tmux kill-session -t vortex-server)
set -u
REPO="$(dirname "$(cd "$(dirname "$0")/.." && git rev-parse --path-format=absolute --git-common-dir)")"
DATA="${VORTEX_HOME:-${STAGEHAND_HOME:-}}"
# Default ~/.vortex; the pre-rename ~/.stagehand is used in place while ~/.vortex does not exist.
[ -n "$DATA" ] || { if [ ! -d "$HOME/.vortex" ] && [ -d "$HOME/.stagehand" ]; then DATA="$HOME/.stagehand"; else DATA="$HOME/.vortex"; fi; }
STOP="$DATA/stop-server"
LOG="$DATA/server.log"
rm -f "$STOP"
# A handled (not ignored) SIGINT: this loop continues, while the server child — which inherits the default
# disposition across exec — receives the Ctrl-C and exits as before.
trap 'true' INT TERM
cd "$REPO/server" || exit 2
while :; do
    echo "$(date '+%F %T') serve: starting @ $(git rev-parse --short HEAD 2>/dev/null)" | tee -a "$LOG"
    npx tsx src/index.ts 2>&1 | tee -a "$LOG"
    if [ -f "$STOP" ]; then
        rm -f "$STOP"
        echo "$(date '+%F %T') serve: stop file found — not restarting" | tee -a "$LOG"
        exit 0
    fi
    echo "$(date '+%F %T') serve: server exited — starting again in 2 s" | tee -a "$LOG"
    sleep 2
done
