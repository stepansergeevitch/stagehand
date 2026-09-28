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

    // /__auth0/<tenant>.auth0.com/<path>: the patched login pages send their Auth0 token calls here, because Auth0's
    // CORS list has only the fixed port (a token response to https://localhost:18003 carries no
    // Access-Control-Allow-Origin, so the browser drops it and the login page says "Authentication failed"). Forwarded
    // with Origin set to this port's origin, which Auth0 allows; answered with CORS for the task app that asked.
    private async proxyAuth0(req: IncomingMessage, res: ServerResponse, apps: string[]): Promise<void> {
        const origin = req.headers.origin ?? "";
        const cors: Record<string, string> = apps.includes(origin)
            ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
            : {};
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                ...cors,
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": String(req.headers["access-control-request-headers"] ?? "content-type, auth0-client"),
                "Access-Control-Max-Age": "600",
            });
            res.end();
            return;
        }
        const m = /^\/__auth0\/([a-z0-9.-]+\.auth0\.com)(\/.*)$/i.exec(req.url ?? "");
        if (!m || !apps.includes(origin)) {
            res.writeHead(403, { ...cors, "Content-Type": "text/plain" });
            res.end("not an Auth0 call from a running task app");
            return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers: Record<string, string> = { Origin: `https://localhost:${this.port}` };
        for (const h of ["content-type", "auth0-client", "accept"]) {
            const v = req.headers[h];
            if (typeof v === "string") headers[h] = v;
        }
        const upstream = await fetch(`https://${m[1]}${m[2]}`, { method: req.method ?? "GET", headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { ...cors, "Content-Type": upstream.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
        res.end(body);
    }

    private handle(req: IncomingMessage, res: ServerResponse): void {
        const apps = this.apps();
        if ((req.url ?? "").startsWith("/__auth0/")) {
            void this.proxyAuth0(req, res, apps).catch((e: unknown) => {
                console.warn(`[stagehand] callback relay: Auth0 proxy failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
                if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
                res.end("Auth0 proxy failed");
            });
            return;
        }
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
