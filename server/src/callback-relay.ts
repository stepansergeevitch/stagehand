import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

// A login-callback relay on an identity provider's fixed callback port (Northspyre Core: Auth0 accepts only
// https://localhost:7777/auth/callback). An app on a Stagehand port pins that redirect_uri, so after logging in the
// browser lands on :7777 — where nothing listens, in any browser (the Chrome-only hop watcher never saw Safari tabs,
// 2026-09-28). While at least one such app is up, this listens on the port and redirects the request, path and query
// unchanged, to the app it came from: the origin in the `stagehand_app_origin` cookie the patched login page sets
// (cookies are per host, not per port, so :7777 receives it), else the only app that is up; with several and no cookie
// it lists them. It binds loopback only, and gives the port back as soon as no such app runs — a port someone else
// already holds (the human's own dev server) is left alone and retried a minute later.
export class CallbackRelay {
    private servers: Server[] = [];
    private retryAt = 0;

    constructor(
        private readonly port: number,
        private readonly tls: () => { cert: Buffer; key: Buffer } | null,
        private readonly apps: () => string[],
    ) {}

    sync(): void {
        const want = this.apps().length > 0;
        if (want && this.servers.length === 0 && Date.now() >= this.retryAt) this.start();
        else if (!want && this.servers.length) this.stop();
    }

    private start(): void {
        const tls = this.tls();
        if (!tls) return;
        this.retryAt = Date.now() + 60_000;
        for (const host of ["127.0.0.1", "::1"]) {
            const srv = createServer(tls, (req, res) => this.handle(req, res));
            srv.once("error", (e: NodeJS.ErrnoException) => {
                console.warn(`[stagehand] callback relay on ${host}:${this.port}: ${e.code ?? e.message} — not relaying there`);
                this.stop();
            });
            srv.listen(this.port, host, () => console.log(`[stagehand] login callback relay listening on https://${host.includes(":") ? `[${host}]` : host}:${this.port}`));
            this.servers.push(srv);
        }
    }

    private stop(): void {
        for (const s of this.servers) s.close();
        if (this.servers.length) console.log(`[stagehand] login callback relay on :${this.port} stopped`);
        this.servers = [];
    }

    private handle(req: IncomingMessage, res: ServerResponse): void {
        const apps = this.apps();
        const cookie = /(?:^|;\s*)stagehand_app_origin=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        const fromCookie = cookie ? decodeURIComponent(cookie) : null;
        const target = fromCookie && apps.includes(fromCookie) ? fromCookie : apps.length === 1 ? apps[0] : null;
        const path = req.url ?? "/";
        if (target) {
            console.log(`[stagehand] login callback relayed from :${this.port} to ${target}${path.split("?")[0]}`);
            res.writeHead(302, { Location: `${target}${path}`, "Cache-Control": "no-store" });
            res.end();
            return;
        }
        const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
        const links = apps.map((o) => `<li><a href="${esc(o + path)}">${esc(o)}</a></li>`).join("");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Stagehand login relay</title><body style="font-family:system-ui;padding:40px">
<h2>Stagehand: which app did you log in to?</h2>
<p>This is the login callback for port ${this.port}. ${apps.length ? "Open it on the task's app:" : "No task app is running any more."}</p><ul>${links}</ul></body>`);
    }
}
