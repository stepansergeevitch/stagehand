import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// VORTEX_* first, then the legacy STAGEHAND_* name.
const env = (name: string): string | undefined => process.env[`VORTEX_${name}`] ?? process.env[`STAGEHAND_${name}`];

// Optional TLS for the dev server: point VORTEX_DEV_TLS_CERT / VORTEX_DEV_TLS_KEY at a locally trusted pair
// (e.g. mkcert's) and the UI is served on https://localhost:5173. Needed when the browser has HSTS pinned for
// "localhost" (Safari does, once any local https app sent it) and refuses the plain-http port.
const cert = env("DEV_TLS_CERT");
const key = env("DEV_TLS_KEY");
const https = cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
// A preview UI of a worktree branch (scripts/preview.sh) runs on other ports and talks to the preview server.
const webPort = Number(env("WEB_PORT") ?? 5173);
const apiPort = Number(env("API_PORT") ?? 4747);

export default defineConfig({
    plugins: [react()],
    // The design system resolves to its source (HMR, no pre-build); `npm run build -w @vortex/ds` produces the dist for consumers outside the app.
    resolve: {
        alias: [
            { find: "@vortex/ds/fonts.css", replacement: fileURLToPath(new URL("../packages/vortex-ds/src/fonts.css", import.meta.url)) },
            { find: "@vortex/ds/styles.css", replacement: fileURLToPath(new URL("../packages/vortex-ds/src/styles.css", import.meta.url)) },
            { find: /^@vortex\/ds$/, replacement: fileURLToPath(new URL("../packages/vortex-ds/src/index.ts", import.meta.url)) },
        ],
    },
    server: {
        // Bind the IPv4 loopback explicitly: with the default ("localhost") Node picks ::1 first on macOS and Vite
        // listens on IPv6 only, which Safari 26 (IPv4 first, no fallback) reports as "can't open the page".
        host: "127.0.0.1",
        port: webPort,
        strictPort: true,
        // The UI also answers as https://vortex.local:5173 (an /etc/hosts alias of 127.0.0.1; stagehand.local is the pre-rename alias); Vite refuses any
        // other Host header than localhost / the bound address unless it is listed here.
        allowedHosts: ["vortex.local", "stagehand.local"],
        ...(https ? { https } : {}),
        proxy: {
            "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
            "/ws": { target: `ws://localhost:${apiPort}`, ws: true },
        },
    },
});
