#!/usr/bin/env bash
# Let the northspyre-deal frontend run on a port other than 3000 while Auth0 and the backend only accept
# https://localhost:3000 as the browser origin. Applied per worktree, never committed:
#   - frontend/src/App.tsx: redirect_uri pinned to the allowed origin, tokens cached in localStorage, and a fetch
#     shim that sends Auth0 token calls through the dev server (marked skip-worktree so git ignores the edit)
#   - frontend/src/setupProxy.js: dev-server proxy that forwards /__auth0 (Auth0) and /api (backend REST +
#     socket.io) with Origin/Referer rewritten to the allowed origin (listed in .git/info/exclude)
# The FE must then be started with REACT_APP_API_BASE_URL=<its own https url>/api and
# REACT_APP_WEBSOCKET_BASE_URL=wss://localhost:<its port>, and STAGEHAND_BE_URL pointing at the backend.
# After Auth0 login the browser lands on https://localhost:3000/?code=…&state=…; open the same query on the real
# port in the same tab and the SDK completes the login (Stagehand's QA prompt does this by itself).
set -euo pipefail

WORKTREE="${1:?usage: deal-alt-port.sh <worktree>}"
ORIGIN="${2:-https://localhost:3000}"
FE="$WORKTREE/frontend"
APP="$FE/src/App.tsx"
PROXY="$FE/src/setupProxy.js"
[ -f "$APP" ] || { echo "no $APP"; exit 1; }

python3 - "$APP" "$ORIGIN" <<'PY'
import sys
path, origin = sys.argv[1], sys.argv[2]
s = open(path).read()
marker = "__stagehandFetch"
if marker not in s:
    s = s.replace("redirect_uri: window.location.origin,", f"redirect_uri: '{origin}', // stagehand alt-port: Auth0 only allows this origin", 1)
    s = s.replace('cacheLocation="memory"', 'cacheLocation="localstorage" // stagehand alt-port: keep tokens across loads', 1)
    shim = """// stagehand alt-port: Auth0 token calls go through the dev-server proxy so Auth0 sees the allowed origin.
if (typeof window !== 'undefined' && config.auth0Domain && !(window as unknown as { __stagehandFetch?: boolean }).__stagehandFetch) {
    (window as unknown as { __stagehandFetch?: boolean }).__stagehandFetch = true;
    const realFetch = window.fetch.bind(window);
    const auth0Base = `https://${config.auth0Domain}/`;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith(auth0Base) ? realFetch(`/__auth0/${url.slice(auth0Base.length)}`, init) : realFetch(input, init);
    };
}
"""
    s = s.replace("\nconst App = () => (", "\n" + shim + "\nconst App = () => (", 1)
    open(path, "w").write(s)
    print("App.tsx patched")
else:
    print("App.tsx already patched")
PY

cat > "$PROXY" <<'JS'
// stagehand alt-port (uncommitted, git-excluded): run the app on a port other than 3000 behind Auth0's fixed origin.
// Auth0 and the deal backend only accept https://localhost:3000 as the browser origin and the browser's Origin header
// can't be changed from JS, so Auth0 token calls, the REST API and the socket.io websocket are routed through this
// dev server, which forwards them with Origin/Referer rewritten to the allowed origin.
const { createProxyMiddleware } = require('http-proxy-middleware');

const ALLOWED_ORIGIN = process.env.STAGEHAND_AUTH0_ORIGIN || 'https://localhost:3000';
const auth0Domain = process.env.REACT_APP_AUTH0_DOMAIN;
const backendUrl = process.env.STAGEHAND_BE_URL || 'https://localhost:8000';

const rewriteOrigin = (proxyReq) => {
    proxyReq.setHeader('Origin', ALLOWED_ORIGIN);
    proxyReq.setHeader('Referer', `${ALLOWED_ORIGIN}/`);
};

module.exports = (app) => {
    if (auth0Domain) {
        app.use(
            '/__auth0',
            createProxyMiddleware({
                target: `https://${auth0Domain}`,
                changeOrigin: true,
                secure: true,
                pathRewrite: { '^/__auth0': '' },
                onProxyReq: rewriteOrigin,
                logLevel: 'warn',
            }),
        );
    }
    // REST (/api/...) and socket.io (/api/socket.io) to this task's backend; self-signed cert → secure: false.
    app.use(
        '/api',
        createProxyMiddleware({
            target: backendUrl,
            changeOrigin: true,
            secure: false,
            ws: true,
            onProxyReq: rewriteOrigin,
            onProxyReqWs: rewriteOrigin,
            logLevel: 'warn',
        }),
    );
};
JS

# Keep both out of git: the tracked file via skip-worktree, the new file via the repo-local exclude list.
git -C "$FE" update-index --skip-worktree src/App.tsx
GITDIR=$(git -C "$FE" rev-parse --git-common-dir)
EXCL="$GITDIR/info/exclude"
grep -qx "frontend/src/setupProxy.js" "$EXCL" 2>/dev/null || echo "frontend/src/setupProxy.js" >> "$EXCL"
echo "deal alt-port hack applied in $WORKTREE (origin $ORIGIN); git status for frontend/: $(git -C "$WORKTREE" status --short frontend/ | wc -l | tr -d ' ') line(s)"
