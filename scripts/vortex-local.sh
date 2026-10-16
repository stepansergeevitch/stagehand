#!/bin/bash
# https://vortex.local (no port) → the Vite dev UI on 127.0.0.1:5173, on this Mac only. The root part:
#   - /etc/hosts: 127.0.0.1 and ::1 for vortex.local (both, or every request waits 5 s on an mDNS AAAA lookup)
#   - Vortex's notification links: notifications.localBaseUrl = https://vortex.local
#   - removes the pf redirect + LaunchDaemon an earlier version of this script installed (a pf rdr on lo0 made every
#     direct connection to 127.0.0.1:5173 hang; the port is now forwarded by scripts/forward-443.mjs, which
#     scripts/up.sh runs as the user in tmux `vortex-443` — no root, no pf)
# The TLS pair in ~/.vortex/tls must carry DNS:vortex.local (mkcert; see README) and web/vite.config.ts must list
# the name in server.allowedHosts — both done on 2026-09-24. The LAN and the public listener on 4748 are untouched.
#
#   sudo scripts/vortex-local.sh          install / repair (idempotent)
#   sudo scripts/vortex-local.sh remove   take the hosts lines out again (and any leftover pf pieces)
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 2; }
ME="${SUDO_USER:-stepanburlakov}"
API="http://127.0.0.1:${VORTEX_API_PORT:-${STAGEHAND_API_PORT:-4747}}"
# The pf redirect of the first version was installed under the pre-rename name (stagehand) too: both are cleaned up.
NAMES="vortex stagehand"

say() { echo "vortex-local: $*"; }

# The pf redirect of the first version: gone wherever it is found. pf itself is left enabled if it is (Apple's own
# anchors are harmless); `pfctl -d` would also switch off the application firewall's rules.
remove_pf() {
    local had=0 n
    for n in $NAMES; do
        local label="local.$n.pf" plist="/Library/LaunchDaemons/local.$n.pf.plist" anchor="/etc/pf.anchors/$n"
        launchctl bootout "system/$label" 2>/dev/null && had=1 || true
        [ -f "$plist" ] && { rm -f "$plist"; had=1; }
        if grep -q "$n" /etc/pf.conf; then
            sed -i.bak-vortex -e "/^rdr-anchor \"$n\"\$/d" -e "/^load anchor \"$n\" from/d" /etc/pf.conf
            had=1
        fi
        [ -f "$anchor" ] && { rm -f "$anchor"; had=1; }
        [ "$had" = "1" ] && pfctl -a "$n" -F all >/dev/null 2>&1 || true
    done
    if [ "$had" = "1" ]; then
        pfctl -f /etc/pf.conf >/dev/null 2>&1 || true
        say "pf redirect and LaunchDaemons removed"
    fi
}

if [ "${1:-}" = "remove" ]; then
    remove_pf
    sed -i.bak-vortex -e '/[[:space:]]vortex\.local$/d' -e '/[[:space:]]stagehand\.local$/d' /etc/hosts
    say "hosts lines removed (backups: /etc/hosts.bak-vortex, /etc/pf.conf.bak-vortex)"
    exit 0
fi

remove_pf

# 1. /etc/hosts — both address families, one line each
sed -i.bak-vortex -e '/[[:space:]]vortex\.local$/d' /etc/hosts
printf '127.0.0.1 vortex.local\n::1 vortex.local\n' >> /etc/hosts
say "/etc/hosts: $(grep -c 'vortex\.local' /etc/hosts) line(s) for vortex.local"

# 2. notification links
if curl -sf "$API/api/health" >/dev/null 2>&1; then
    curl -sf -X PATCH "$API/api/settings" -H 'content-type: application/json' -d '{"notifications":{"localBaseUrl":"https://vortex.local"}}' >/dev/null && say "notifications.localBaseUrl = https://vortex.local"
else
    say "server not up — set notifications.localBaseUrl to https://vortex.local in the UI later"
fi

say "now (as $ME): scripts/up.sh — it starts the 443 forwarder; then https://vortex.local"
