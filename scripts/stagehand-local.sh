#!/bin/bash
# https://stagehand.local (no port) → the Vite dev UI on 127.0.0.1:5173, on this Mac only. The root part:
#   - /etc/hosts: 127.0.0.1 and ::1 for stagehand.local (both, or every request waits 5 s on an mDNS AAAA lookup)
#   - Stagehand's notification links: notifications.localBaseUrl = https://stagehand.local
#   - removes the pf redirect + LaunchDaemon an earlier version of this script installed (a pf rdr on lo0 made every
#     direct connection to 127.0.0.1:5173 hang; the port is now forwarded by scripts/forward-443.mjs, which
#     scripts/up.sh runs as the user in tmux `stagehand-443` — no root, no pf)
# The TLS pair in ~/.stagehand/tls must carry DNS:stagehand.local (mkcert; see README) and web/vite.config.ts must list
# the name in server.allowedHosts — both done on 2026-09-24. The LAN and the public listener on 4748 are untouched.
#
#   sudo scripts/stagehand-local.sh          install / repair (idempotent)
#   sudo scripts/stagehand-local.sh remove   take the hosts lines out again (and any leftover pf pieces)
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 2; }
ME="${SUDO_USER:-stepanburlakov}"
API="http://127.0.0.1:${STAGEHAND_API_PORT:-4747}"
ANCHOR=/etc/pf.anchors/stagehand
PLIST=/Library/LaunchDaemons/local.stagehand.pf.plist
LABEL=local.stagehand.pf

say() { echo "stagehand-local: $*"; }

# The pf redirect of the first version: gone wherever it is found. pf itself is left enabled if it is (Apple's own
# anchors are harmless); `pfctl -d` would also switch off the application firewall's rules.
remove_pf() {
    local had=0
    launchctl bootout system/$LABEL 2>/dev/null && had=1 || true
    [ -f "$PLIST" ] && { rm -f "$PLIST"; had=1; }
    if grep -q 'stagehand' /etc/pf.conf; then
        sed -i.bak-stagehand -e '/^rdr-anchor "stagehand"$/d' -e '/^load anchor "stagehand" from/d' /etc/pf.conf
        had=1
    fi
    [ -f "$ANCHOR" ] && { rm -f "$ANCHOR"; had=1; }
    if [ "$had" = "1" ]; then
        pfctl -a stagehand -F all >/dev/null 2>&1 || true
        pfctl -f /etc/pf.conf >/dev/null 2>&1 || true
        say "pf redirect and LaunchDaemon $LABEL removed"
    fi
}

if [ "${1:-}" = "remove" ]; then
    remove_pf
    sed -i.bak-stagehand -e '/[[:space:]]stagehand\.local$/d' /etc/hosts
    say "hosts lines removed (backups: /etc/hosts.bak-stagehand, /etc/pf.conf.bak-stagehand)"
    exit 0
fi

remove_pf

# 1. /etc/hosts — both address families, one line each
sed -i.bak-stagehand -e '/[[:space:]]stagehand\.local$/d' /etc/hosts
printf '127.0.0.1 stagehand.local\n::1 stagehand.local\n' >> /etc/hosts
say "/etc/hosts: $(grep -c 'stagehand\.local' /etc/hosts) line(s) for stagehand.local"

# 2. notification links
if curl -sf "$API/api/health" >/dev/null 2>&1; then
    curl -sf -X PATCH "$API/api/settings" -H 'content-type: application/json' -d '{"notifications":{"localBaseUrl":"https://stagehand.local"}}' >/dev/null && say "notifications.localBaseUrl = https://stagehand.local"
else
    say "server not up — set notifications.localBaseUrl to https://stagehand.local in the UI later"
fi

say "now (as $ME): scripts/up.sh — it starts the 443 forwarder; then https://stagehand.local"
