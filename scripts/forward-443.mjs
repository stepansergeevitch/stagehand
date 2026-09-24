// https://stagehand.local (no port) → the Vite dev UI on 127.0.0.1:5173, as a plain TCP pipe on port 443.
// TLS is not terminated here: Vite already serves the mkcert pair whose SAN carries stagehand.local, so the bytes
// pass through untouched (HTTP, HMR websocket, the /api and /ws proxies behind it). No root, no pf, no LaunchDaemon —
// a pf `rdr` on lo0 was tried first (2026-09-24) and it made every DIRECT connection to 127.0.0.1:5173 hang for 7 s
// while the redirected ones worked.
//
// macOS lets an unprivileged process bind a port below 1024 only on the wildcard address (127.0.0.1:443 → EACCES),
// so the listener is "::" (dual-stack) and every peer that is not loopback is dropped before a byte is read: the
// LAN gets a closed connection, exactly as before. Started by scripts/up.sh in tmux `stagehand-443`. /etc/hosts maps
// the name to 127.0.0.1 and ::1 (without the ::1 line macOS asks mDNS for the AAAA record and waits 5 s).
import net from "node:net";

const target = { host: "127.0.0.1", port: Number(process.env["STAGEHAND_WEB_PORT"] ?? 5173) };
const port = Number(process.env["STAGEHAND_LOCAL_PORT"] ?? 443);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const server = net.createServer((client) => {
    if (!LOOPBACK.has(client.remoteAddress ?? "")) {
        client.destroy();
        return;
    }
    const upstream = net.connect(target);
    const drop = () => {
        client.destroy();
        upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
    client.pipe(upstream).pipe(client);
});
server.on("error", (e) => {
    console.error(`forward-443: cannot listen on port ${port} — ${e.message}`);
    process.exit(1);
});
server.listen({ port, host: "::", ipv6Only: false }, () => console.log(`forward-443: [::]:${port} (loopback peers only) → ${target.host}:${target.port}`));
