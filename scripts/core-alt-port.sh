#!/usr/bin/env bash
# Let the northspyre core app (Flask backend + React bundle) run on any port from a Stagehand worktree, so several
# tasks (and the user's own dev servers on 7777/9000) can run at once. Applied per worktree, never committed:
#   be: etc/northspyre_stagehand.cfg gets hostname_port=localhost:<port> (the backend binds from the cfg, PORT is
#       ignored); NorthSpyre/config.py serves the bundle from the backend's own origin (/static/js/react/…) instead of
#       //localhost:9000 (skip-worktree so git ignores the edit); the Auth0 PKCE pages send the allowed callback
#       https://localhost:7777/auth/callback (skip-worktree), which Stagehand's hop watcher moves back to this port
#   fe: src/services/getEnvironmentalVariables.ts derives the API base from window.location.origin when the page is
#       served by the backend (webpack's own :9000 keeps https://localhost:7777; skip-worktree); a git-excluded
#       webpack.stagehand.config.js wraps the dev config with Stagehand's port and writeToDisk, so the bundle lands in
#       NorthSpyre/static/js/react/ where the backend serves it
# Usage: core-alt-port.sh <worktree> be|fe <port>
set -euo pipefail

WT="${1:?usage: core-alt-port.sh <worktree> be|fe <port>}"
KIND="${2:?be|fe}"
PORT="${3:?port}"
MARK="stagehand alt-port"
cd "$WT"

skip() { git update-index --skip-worktree "$1" 2>/dev/null || true; }
exclude() {
    local f="$1" ex
    ex="$(git rev-parse --git-common-dir)/info/exclude"
    grep -qxF "$f" "$ex" 2>/dev/null || echo "$f" >> "$ex"
}

case "$KIND" in
be)
    [ -f etc/northspyre_stagehand.cfg ] || { echo "etc/northspyre_stagehand.cfg missing — the worktree setup did not run"; exit 1; }
    sed -i '' "s|^hostname_port=.*|hostname_port=localhost:${PORT}|" etc/northspyre_stagehand.cfg
    # The Deal→Core dependency instance runs from the main checkout: only the port moves there — its UI is never
    # opened, and the user's own dev server must keep loading the bundle from webpack on :9000.
    if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]; then exit 0; fi
    f=NorthSpyre/config.py
    if ! grep -q "$MARK" "$f"; then
        sed -i '' "s|northspyre_frontend_path: str = \"//localhost:9000/northspyre_frontend.js\"|northspyre_frontend_path: str = \"/static/js/react/northspyre_frontend.js\"  # $MARK: the bundle webpack writes to disk, served by this backend on any port|" "$f"
        grep -q "$MARK" "$f" || { echo "$f: northspyre_frontend_path default not found — update this script"; exit 1; }
    fi
    skip "$f"
    # Auth0 accepts only https://localhost:7777/auth/callback: the PKCE pages send that as redirect_uri on any other
    # port, and Stagehand's callback-hop watcher re-opens the landed callback on this backend's origin (same tab, so the
    # SDK's transaction in sessionStorage is there to finish the exchange).
    for f in NorthSpyre/templates/auth/pkce_login.html NorthSpyre/templates/auth/pkce_callback.html; do
        [ -f "$f" ] || continue
        if ! grep -q "$MARK" "$f"; then
            sed -i '' "s|window.location.origin + '/auth/callback'|(window.location.port === '7777' ? window.location.origin : 'https://localhost:7777') + '/auth/callback' /* $MARK: Auth0 allows only this callback */|" "$f"
            grep -q "$MARK" "$f" || { echo "$f: callback URL line not found — update this script"; exit 1; }
        fi
        skip "$f"
    done
    # The login page names its own origin in a cookie (per host, so :7777 gets it too): Stagehand's callback relay on
    # :7777 sends the callback back to this port in any browser, even with several tasks' apps up.
    f=NorthSpyre/templates/auth/pkce_login.html
    if [ -f "$f" ] && ! grep -q "stagehand_app_origin" "$f"; then
        # Appended to the callbackUrl line itself (a newline in a BSD sed replacement is not worth the quoting).
        sed -i '' "s|^\(.*var callbackUrl = .*$MARK.*\)$|\1 document.cookie = 'stagehand_app_origin=' + encodeURIComponent(window.location.origin) + '; path=/; secure; samesite=lax'; // $MARK: read by Stagehand's :7777 callback relay|" "$f"
        grep -q "stagehand_app_origin" "$f" || { echo "$f: callbackUrl line not found — update this script"; exit 1; }
    fi
    ;;
fe)
    f=NorthSpyre/front_end/react/src/services/getEnvironmentalVariables.ts
    if ! grep -q "$MARK" "$f"; then
        sed -i '' "s|^export const LOCAL_URL = 'https://localhost:7777';|export const LOCAL_URL = (typeof window !== 'undefined' \&\& window.location.port !== '9000') ? window.location.origin : 'https://localhost:7777'; // $MARK: served by the backend on any port|" "$f"
        grep -q "$MARK" "$f" || { echo "$f: LOCAL_URL line not found — update this script"; exit 1; }
    fi
    skip "$f"
    w=NorthSpyre/front_end/react/webpack.stagehand.config.js
    cat > "$w" <<EOF
// $MARK: the dev config on Stagehand's port, writing the bundle to disk so the backend serves it from its own origin.
const base = require('./webpack.dev.config.js');
module.exports = (env) => {
    const c = base(env);
    c.devServer = { ...c.devServer, port: ${PORT}, writeToDisk: true };
    return c;
};
EOF
    exclude "$w"
    ;;
*)
    echo "unknown kind: $KIND"; exit 1
    ;;
esac
