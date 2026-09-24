    curl -skf -m 3 -o /dev/null "https://stagehand.local/" 2>/dev/null && echo "ui: https://stagehand.local (up — pf 443→, scripts/stagehand-local.sh)"
#!/bin/bash
# Starts the live Stagehand app after a reboot (or whenever its tmux sessions are gone), in one go:
#   - tmux stagehand-server → scripts/serve.sh (the restart loop around `npx tsx src/index.ts`, API on 4747, public 4748)
#   - tmux stagehand-web    → Vite dev UI on https://localhost:5173 with the TLS pair from ~/.stagehand/tls
# A session that already runs is left alone. Waits for /api/health and prints where things are.
#
#   scripts/up.sh            start what is missing
#   scripts/up.sh status     what runs where
#   scripts/up.sh down       stop both sessions (serve.sh gets its stop file, so the server does not come back)
# Nothing else auto-starts after a reboot: Docker Desktop (DualEntry Postgres/OpenSearch, Core compose) is by hand.
set -euo pipefail

REPO="$(dirname "$(cd "$(dirname "$0")/.." && git rev-parse --path-format=absolute --git-common-dir)")"
DATA="${STAGEHAND_HOME:-$HOME/.stagehand}"
API_PORT="${STAGEHAND_API_PORT:-4747}"
WEB_PORT="${STAGEHAND_WEB_PORT:-5173}"
S_SERVER="${STAGEHAND_TMUX:-stagehand-server}"
S_WEB=stagehand-web
TLS_CERT="${STAGEHAND_DEV_TLS_CERT:-$DATA/tls/cert.pem}"
TLS_KEY="${STAGEHAND_DEV_TLS_KEY:-$DATA/tls/key.pem}"

say() { echo "up: $*"; }
has() { tmux has-session -t "$1" 2>/dev/null; }

status() {
    for s in "$S_SERVER" "$S_WEB"; do
        if has "$s"; then echo "$s: running"; else echo "$s: not running"; fi
    done
    curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null && echo "api: http://127.0.0.1:$API_PORT (up @ $(git -C "$REPO" rev-parse --short HEAD))" || echo "api: down"
    curl -skf -o /dev/null "https://localhost:$WEB_PORT/" && echo "ui: https://localhost:$WEB_PORT (up)" || echo "ui: down"
    docker info >/dev/null 2>&1 && echo "docker: up" || echo "docker: down (start Docker Desktop by hand for DualEntry / Core envs)"
}

down() {
    if has "$S_SERVER"; then touch "$DATA/stop-server"; tmux send-keys -t "$S_SERVER" C-c; sleep 2; tmux kill-session -t "$S_SERVER" 2>/dev/null || true; fi
    tmux kill-session -t "$S_WEB" 2>/dev/null || true
    say "stopped"
}

case "${1:-}" in
    status) status; exit 0 ;;
    down) down; exit 0 ;;
    "") ;;
    *) echo "usage: up.sh [status|down]" >&2; exit 2 ;;
esac

[ -d "$REPO/web/dist" ] || { say "no web/dist — building the public bundle"; (cd "$REPO/web" && npx vite build >/dev/null 2>&1); }

if has "$S_SERVER"; then say "$S_SERVER already runs"
else
    tmux new-session -d -s "$S_SERVER" -c "$REPO" "cd '$REPO' && scripts/serve.sh"
    say "started $S_SERVER (scripts/serve.sh @ $(git -C "$REPO" rev-parse --short HEAD))"
fi

if has "$S_WEB"; then say "$S_WEB already runs"
else
    tls=""
    if [ -f "$TLS_CERT" ] && [ -f "$TLS_KEY" ]; then tls="STAGEHAND_DEV_TLS_CERT='$TLS_CERT' STAGEHAND_DEV_TLS_KEY='$TLS_KEY' "
    else say "no TLS pair at $TLS_CERT — the dev UI is plain http (config localBaseUrl expects https)"; fi
    tmux new-session -d -s "$S_WEB" -c "$REPO/web" "cd '$REPO/web' && ${tls}npx vite --port $WEB_PORT 2>&1 | tee -a '$DATA/web.log'"
    say "started $S_WEB (vite :$WEB_PORT)"
fi

for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 || { echo "up: the server did not answer within 60 s — tmux attach -t $S_SERVER; tail $DATA/server.log" >&2; exit 6; }
for i in $(seq 1 20); do curl -skf -o /dev/null "https://localhost:$WEB_PORT/" 2>/dev/null && break; sleep 1; done
status
