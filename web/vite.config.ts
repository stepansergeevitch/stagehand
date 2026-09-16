import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Optional TLS for the dev server: point STAGEHAND_DEV_TLS_CERT / STAGEHAND_DEV_TLS_KEY at a locally trusted pair
// (e.g. mkcert's) and the UI is served on https://localhost:5173. Needed when the browser has HSTS pinned for
// "localhost" (Safari does, once any local https app sent it) and refuses the plain-http port.
const cert = process.env["STAGEHAND_DEV_TLS_CERT"];
const key = process.env["STAGEHAND_DEV_TLS_KEY"];
const https = cert && key ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;

export default defineConfig({
    plugins: [react()],
    server: {
        // Bind the IPv4 loopback explicitly: with the default ("localhost") Node picks ::1 first on macOS and Vite
        // listens on IPv6 only, which Safari 26 (IPv4 first, no fallback) reports as "can't open the page".
        host: "127.0.0.1",
        port: 5173,
        ...(https ? { https } : {}),
        proxy: {
            "/api": { target: "http://localhost:4747", changeOrigin: true },
            "/ws": { target: "ws://localhost:4747", ws: true },
        },
    },
});
