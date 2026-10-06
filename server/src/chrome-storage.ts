import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassicLevel } from "classic-level";
import { userDataDirFor } from "./chrome-clones.js";

// A Chrome profile's localStorage, for the headless QA browser: apps that keep their session there (an SPA's token
// cache) are not signed in by cookies alone (PRODUCT-10578, 2026-10-06: every pass met the sign-in page although the
// human was signed in). Chrome keeps it in a LevelDB under "<profile>/Local Storage/leveldb"; the live one is locked,
// so a copy is read. Keys are "_" + origin + "\0" + a script key, values a script value; both script strings start
// with an encoding byte (1 = Latin-1, 0 = UTF-16LE).

const decode = (b: Buffer): string => (b[0] === 1 ? b.subarray(1).toString("latin1") : b.subarray(1).toString("utf16le"));

// OAuth refresh tokens stay behind: a refresh from the copy would rotate the token the human's browser still holds,
// and a rotated-out token used again signs the human out. The copy lives on the access token while it is valid.
export const withoutRefreshTokens = (value: string): string => {
    if (!value.includes("refresh_token")) return value;
    try {
        const strip = (v: unknown): unknown =>
            Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "refresh_token").map(([k, x]) => [k, strip(x)])) : v;
        return JSON.stringify(strip(JSON.parse(value)));
    } catch {
        return value;
    }
};

// Entries the app at `origin` should see: the origin's own, plus those of the same scheme and host on other ports
// (cookies are per host, not per port; per-task app ports change, the session was made on one of them). The origin's
// own entries win a key both have.
export const pickLocalStorage = (rows: { origin: string; key: string; value: string }[], origin: string): Record<string, string> => {
    const want = new URL(origin);
    const sameHost = (o: string): boolean => {
        try {
            const u = new URL(o);
            return u.protocol === want.protocol && u.hostname === want.hostname;
        } catch {
            return false;
        }
    };
    const out: Record<string, string> = {};
    for (const r of rows) if (r.origin !== want.origin && sameHost(r.origin)) out[r.key] = withoutRefreshTokens(r.value);
    for (const r of rows) if (r.origin === want.origin) out[r.key] = withoutRefreshTokens(r.value);
    return out;
};

export const readLocalStorage = async (browser: string, profileDir: string, origin: string): Promise<Record<string, string>> => {
    const src = join(userDataDirFor(browser), profileDir, "Local Storage", "leveldb");
    const dir = mkdtempSync(join(tmpdir(), "stagehand-ls-"));
    try {
        cpSync(src, dir, { recursive: true, filter: (p) => !p.endsWith("LOCK") });
        const db = new ClassicLevel<Buffer, Buffer>(dir, { keyEncoding: "buffer", valueEncoding: "buffer", createIfMissing: false });
        const rows: { origin: string; key: string; value: string }[] = [];
        try {
            for await (const [k, v] of db.iterator()) {
                if (k[0] !== 0x5f) continue;
                const i = k.indexOf(0);
                if (i < 0) continue;
                rows.push({ origin: k.subarray(1, i).toString("latin1"), key: decode(k.subarray(i + 1)), value: decode(v) });
            }
        } finally {
            await db.close();
        }
        return pickLocalStorage(rows, origin);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};
