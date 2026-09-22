#!/bin/bash
# Runs a Stagehand worktree branch as a PREVIEW beside the live app: its server on port 4757 (no scheduler, no
# pollers, no public listener, no runs started — it shares the live data dir read-mostly) and its Vite UI on 5174,
# both in tmux. Use it to test a change from its branch before scripts/release.sh lands it.
#
#   scripts/preview.sh <worktree-path>     start (or replace) the preview on that worktree
#   scripts/preview.sh stop                end the preview sessions
#   scripts/preview.sh status              what runs where
set -euo pipefail

API_PORT="${STAGEHAND_PREVIEW_PORT:-4757}"
WEB_PORT="${STAGEHAND_PREVIEW_WEB_PORT:-5174}"
S_SERVER=stagehand-preview-server
S_WEB=stagehand-preview-web
# The main checkout (owner of .git), where the shared node_modules live — also when this copy runs from a worktree.
REPO="$(dirname "$(cd "$(dirname "$0")/.." && git rev-parse --path-format=absolute --git-common-dir)")"

stop() {
    tmux kill-session -t "$S_SERVER" 2>/dev/null || true
    tmux kill-session -t "$S_WEB" 2>/dev/null || true
    echo "preview stopped"
}

status() {
    for s in "$S_SERVER" "$S_WEB"; do
        if tmux has-session -t "$s" 2>/dev/null; then echo "$s: running"; else echo "$s: not running"; fi
    done
    curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null && echo "api: http://127.0.0.1:$API_PORT (up)" || echo "api: down"
    curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT/" && echo "ui: http://localhost:$WEB_PORT (up)" || echo "ui: down"
}

case "${1:-}" in
    stop) stop; exit 0 ;;
    status) status; exit 0 ;;
    "") echo "usage: preview.sh <worktree-path> | stop | status" >&2; exit 2 ;;
esac

WT="$(cd "$1" && pwd)"
[ -f "$WT/server/src/index.ts" ] || { echo "not a Stagehand checkout: $WT" >&2; exit 2; }
# The worktree shares the main checkout's dependencies (npm workspaces): symlink what is missing.
for d in node_modules server/node_modules web/node_modules; do
    [ -e "$WT/$d" ] || { [ -d "$REPO/$d" ] && ln -s "$REPO/$d" "$WT/$d"; }
done

stop >/dev/null
tmux new-session -d -s "$S_SERVER" -c "$WT/server"
tmux send-keys -t "$S_SERVER" "export STAGEHAND_PREVIEW=1 STAGEHAND_PORT=$API_PORT; npx tsx src/index.ts 2>&1 | tee ~/.stagehand/preview-server.log" Enter
tmux new-session -d -s "$S_WEB" -c "$WT/web"
tmux send-keys -t "$S_WEB" "export STAGEHAND_WEB_PORT=$WEB_PORT STAGEHAND_API_PORT=$API_PORT; npx vite" Enter

for i in $(seq 1 40); do
    sleep 1
    curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null && break
done
curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null || { echo "preview server did not come up — tmux attach -t $S_SERVER" >&2; exit 1; }
for i in $(seq 1 20); do
    sleep 1
    curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT/" && break
done
echo "preview of $(git -C "$WT" rev-parse --abbrev-ref HEAD) @ $(git -C "$WT" rev-parse --short HEAD)"
echo "ui:  http://localhost:$WEB_PORT"
echo "api: http://127.0.0.1:$API_PORT (preview: no scheduler, no runs)"
