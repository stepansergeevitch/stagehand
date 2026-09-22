import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassicLevel } from "classic-level";
import { afterEach, describe, expect, it } from "vitest";
import { CLONE_EXCLUDES, rewriteBridgeDeviceId, rsyncArgs, seedLocalState } from "./chrome-clones.js";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("rsyncArgs", () => {
    it("copies the profile with every exclude and trailing slashes on both ends", () => {
        const args = rsyncArgs("/src/Profile 2", "/dst/Default");
        expect(args[0]).toBe("-a");
        expect(args.at(-2)).toBe("/src/Profile 2/");
        expect(args.at(-1)).toBe("/dst/Default/");
        for (const e of CLONE_EXCLUDES) expect(args).toContain(e);
        expect(args.filter((a) => a === "--exclude")).toHaveLength(CLONE_EXCLUDES.length);
    });
    it("never excludes what a login needs", () => {
        for (const keep of ["Cookies", "Local Storage", "IndexedDB", "Extensions", "Local Extension Settings", "Preferences", "Secure Preferences"]) {
            expect(CLONE_EXCLUDES.some((e) => e === keep || (e.endsWith("*") && keep.startsWith(e.slice(0, -1))))).toBe(false);
        }
    });
});

describe("rewriteBridgeDeviceId", () => {
    const makeStore = async (value?: string): Promise<string> => {
        const dir = mkdtempSync(join(tmpdir(), "ext-store-"));
        dirs.push(dir);
        const db = new ClassicLevel<string, string>(dir, { keyEncoding: "utf8", valueEncoding: "utf8" });
        await db.open();
        await db.put("otherKey", '"kept"');
        if (value !== undefined) await db.put("bridgeDeviceId", value);
        await db.close();
        return dir;
    };
    const read = async (dir: string, key: string): Promise<string> => {
        const db = new ClassicLevel<string, string>(dir, { keyEncoding: "utf8", valueEncoding: "utf8" });
        await db.open();
        try {
            return await db.get(key);
        } finally {
            await db.close();
        }
    };

    it("keeps Chrome's JSON-string encoding and leaves the rest of the store alone", async () => {
        const dir = await makeStore('"1974857b-d99b-41c8-bc95-5d460ed2f951"');
        const r = await rewriteBridgeDeviceId(dir, "7a1e5b2c-0000-4000-8000-00000000c10e");
        expect(r.previous).toBe('"1974857b-d99b-41c8-bc95-5d460ed2f951"');
        expect(await read(dir, "bridgeDeviceId")).toBe('"7a1e5b2c-0000-4000-8000-00000000c10e"');
        expect(await read(dir, "otherKey")).toBe('"kept"');
    });
    it("writes a JSON string when the key was absent", async () => {
        const dir = await makeStore();
        const r = await rewriteBridgeDeviceId(dir, "abc");
        expect(r.previous).toBeNull();
        expect(await read(dir, "bridgeDeviceId")).toBe('"abc"');
    });
});

describe("seedLocalState", () => {
    const setup = (localState: unknown): { userData: string; clone: string } => {
        const root = mkdtempSync(join(tmpdir(), "clone-ls-"));
        dirs.push(root);
        const userData = join(root, "Chrome");
        const clone = join(root, "clone");
        mkdirSync(userData);
        mkdirSync(clone);
        if (localState !== undefined) writeFileSync(join(userData, "Local State"), typeof localState === "string" ? localState : JSON.stringify(localState));
        return { userData, clone };
    };
    const entry = { name: "Northspyre", hosted_domain: "northspyre.com", is_managed: 1, user_accepted_account_management: true, gaia_id: "g" };

    it("moves the source profile's entry under Default and makes it the last used profile", () => {
        const { userData, clone } = setup({ profile: { info_cache: { Default: { name: "Other" }, "Profile 2": entry }, last_used: "Profile 2" }, browser: {} });
        expect(seedLocalState(userData, clone, "Profile 2")).toBe(true);
        const out = JSON.parse(readFileSync(join(clone, "Local State"), "utf8")) as { profile: Record<string, unknown> };
        expect(out.profile.info_cache).toEqual({ Default: entry });
        expect(out.profile.last_used).toBe("Default");
        expect(out.profile.profiles_order).toEqual(["Default"]);
        expect(out).not.toHaveProperty("browser");
    });
    it("writes nothing when the entry, the file or valid JSON is missing", () => {
        const a = setup({ profile: { info_cache: { Default: entry } } });
        expect(seedLocalState(a.userData, a.clone, "Profile 2")).toBe(false);
        const b = setup(undefined);
        expect(seedLocalState(b.userData, b.clone, "Profile 2")).toBe(false);
        const c = setup("{not json");
        expect(seedLocalState(c.userData, c.clone, "Profile 2")).toBe(false);
    });
});
