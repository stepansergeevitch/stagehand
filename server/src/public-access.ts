import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Config } from "./config.js";

const COOKIE = "stagehand_session";

export const hashPassword = (password: string): string => {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `scrypt$${salt}$${hash}`;
};

const verifyPassword = (password: string, stored: string): boolean => {
    const [algo, salt, hash] = stored.split("$");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
};

const sign = (secret: string, payload: string): string => createHmac("sha256", secret).update(payload).digest("hex");

const mintToken = (secret: string, user: string, days: number): string => {
    const exp = Date.now() + days * 86_400_000;
    const payload = `${user}.${exp}`;
    return `${payload}.${sign(secret, payload)}`;
};

const tokenUser = (secret: string, token: string | undefined): string | null => {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [user, exp, sig] = parts as [string, string, string];
    const expected = sign(secret, `${user}.${exp}`);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Number(exp) < Date.now()) return null;
    return user;
};

const basicCredentials = (header: string | undefined): { user: string; password: string } | null => {
    if (!header?.startsWith("Basic ")) return null;
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
};

type NodeEnv = { incoming?: IncomingMessage };

// True when the request (HTTP or WebSocket upgrade) arrived on the public listener rather than the loopback one.
export const isPublicRequest = (c: Context, publicPort: number): boolean => {
    const incoming = (c.env as NodeEnv | undefined)?.incoming;
    return incoming?.socket?.localPort === publicPort;
};

// Basic auth on the first request, a signed cookie afterwards (browsers don't reliably attach Basic credentials to WebSocket handshakes).
export const publicAuth = (cfg: Config): MiddlewareHandler => {
    const pa = cfg.publicAccess;
    return async (c, next) => {
        if (!pa.enabled || !isPublicRequest(c, pa.port)) return next();
        if (!pa.user || !pa.passwordHash || !pa.sessionSecret) return c.text("public access is enabled but user/passwordHash/sessionSecret are not configured", 503);
        const secret = pa.sessionSecret;
        if (tokenUser(secret, getCookie(c, COOKIE)) === pa.user) return next();
        const creds = basicCredentials(c.req.header("authorization"));
        if (creds && creds.user === pa.user && verifyPassword(creds.password, pa.passwordHash)) {
            setCookie(c, COOKIE, mintToken(secret, pa.user, pa.sessionDays), {
                httpOnly: true,
                secure: true,
                sameSite: "Strict",
                path: "/",
                maxAge: pa.sessionDays * 86_400,
            });
            return next();
        }
        return c.text("authentication required", 401, { "WWW-Authenticate": 'Basic realm="Stagehand", charset="UTF-8"' });
    };
};
