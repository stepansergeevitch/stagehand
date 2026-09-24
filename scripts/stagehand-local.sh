#!/bin/bash
# https://stagehand.local (no port) → the Vite dev UI on 127.0.0.1:5173, on this Mac only.
#   - /etc/hosts: 127.0.0.1 and ::1 for stagehand.local (both, or every request waits 5 s on an mDNS AAAA lookup)
#   - pf: a loopback-only rdr 443 → 5173 in the anchor "stagehand" (/etc/pf.anchors/stagehand, loaded from /etc/pf.conf)
#   - /Library/LaunchDaemons/local.stagehand.pf.plist: enables pf with /etc/pf.conf at boot (macOS loads the rules
#     at boot but leaves pf disabled — see the comment at the top of /etc/pf.conf)
#   - Stagehand's notification links: notifications.localBaseUrl = https://stagehand.local
# The TLS pair in ~/.stagehand/tls must carry DNS:stagehand.local (mkcert; see README) and web/vite.config.ts must list
# the name in server.allowedHosts — both done on 2026-09-24. The LAN and the public listener on 4748 are untouched.
#
#   sudo scripts/stagehand-local.sh          install / repair (idempotent)
#   sudo scripts/stagehand-local.sh remove   take it all out again
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run with sudo" >&2; exit 2; }
ME="${SUDO_USER:-stepanburlakov}"
API="http://127.0.0.1:${STAGEHAND_API_PORT:-4747}"
ANCHOR=/etc/pf.anchors/stagehand
PLIST=/Library/LaunchDaemons/local.stagehand.pf.plist
LABEL=local.stagehand.pf

say() { echo "stagehand-local: $*"; }

if [ "${1:-}" = "remove" ]; then
    launchctl bootout system/$LABEL 2>/dev/null || true
    rm -f "$PLIST"
    sed -i.bak-stagehand -e '/^rdr-anchor "stagehand"$/d' -e '/^load anchor "stagehand" from/d' /etc/pf.conf
    rm -f "$ANCHOR"
    pfctl -f /etc/pf.conf 2>/dev/null || true
    sed -i.bak-stagehand -e '/[[:space:]]stagehand\.local$/d' /etc/hosts
    say "removed (pf left in its current enabled/disabled state; /etc/hosts and /etc/pf.conf backups: *.bak-stagehand)"
    exit 0
fi

# 1. /etc/hosts — both address families
grep -qE '^127\.0\.0\.1[[:space:]]+stagehand\.local$' /etc/hosts || printf '127.0.0.1 stagehand.local\n' >> /etc/hosts
grep -qE '^::1[[:space:]]+stagehand\.local$' /etc/hosts || printf '::1 stagehand.local\n' >> /etc/hosts
say "/etc/hosts: $(grep -c 'stagehand\.local' /etc/hosts) line(s) for stagehand.local"

# 2. pf anchor + pf.conf
cat > "$ANCHOR" <<'EOF'
# Stagehand dev UI without a port: https://stagehand.local -> Vite on 127.0.0.1:5173 (loopback only; the LAN and the
# public listener on 4748 are untouched). Loaded from /etc/pf.conf (rdr-anchor "stagehand"); pf is enabled at boot by
# /Library/LaunchDaemons/local.stagehand.pf.plist. Installed by scripts/stagehand-local.sh.
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port 5173
EOF
chown root:wheel "$ANCHOR" && chmod 644 "$ANCHOR"
# Translation rules must precede filter rules: the rdr-anchor goes right after Apple's, the load line at the end.
grep -q '^rdr-anchor "stagehand"$' /etc/pf.conf || sed -i.bak-stagehand '/^rdr-anchor "com.apple\/\*"$/a\
rdr-anchor "stagehand"
' /etc/pf.conf
grep -q '^load anchor "stagehand" from' /etc/pf.conf || printf 'load anchor "stagehand" from "%s"\n' "$ANCHOR" >> /etc/pf.conf
pfctl -nf /etc/pf.conf >/dev/null
pfctl -f /etc/pf.conf 2>/dev/null
pfctl -e 2>/dev/null || true
say "pf: $(pfctl -s info 2>/dev/null | head -1); anchor: $(pfctl -a stagehand -s nat 2>/dev/null | grep -c rdr) rdr rule(s)"

# 3. enable pf at boot
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/sbin/pfctl</string><string>-e</string><string>-f</string><string>/etc/pf.conf</string></array>
    <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
chown root:wheel "$PLIST" && chmod 644 "$PLIST"
launchctl bootout system/$LABEL 2>/dev/null || true
launchctl bootstrap system "$PLIST"
say "LaunchDaemon $LABEL loaded"

# 4. notification links
if curl -sf "$API/api/health" >/dev/null 2>&1; then
    curl -sf -X PATCH "$API/api/settings" -H 'content-type: application/json' -d '{"notifications":{"localBaseUrl":"https://stagehand.local"}}' >/dev/null && say "notifications.localBaseUrl = https://stagehand.local"
else
    say "server not up — set notifications.localBaseUrl to https://stagehand.local in the UI later"
fi

# 5. check, as the user (the TLS trust store is theirs)
sudo -u "$ME" curl -s -m 10 -o /dev/null -w 'https://stagehand.local/ -> HTTP %{http_code} in %{time_total}s\n' https://stagehand.local/ || say "the UI did not answer — is stagehand-web running? scripts/up.sh"
