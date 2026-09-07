import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Maps a connected-browser deviceId (what the Claude extension reports) to the human name of the Chrome profile that
// holds it: the extension keeps its deviceId in the profile's "Local Extension Settings" store, and Chrome's Local State
// carries the profile display names. macOS paths; other browsers/OSes simply yield no match.

const EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const BROWSER_DIRS = ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Arc/User Data", "Vivaldi"];

interface Profile {
    browser: string;
    dir: string;
    name: string;
    account: string | null;
    storage: string;
}

const listProfiles = (): Profile[] => {
    const out: Profile[] = [];
    const base = join(homedir(), "Library", "Application Support");
    for (const rel of BROWSER_DIRS) {
        const root = join(base, rel);
        const localState = join(root, "Local State");
        if (!existsSync(localState)) continue;
        let cache: Record<string, { name?: string; user_name?: string }> = {};
        try {
            cache = (JSON.parse(readFileSync(localState, "utf8")) as { profile?: { info_cache?: typeof cache } }).profile?.info_cache ?? {};
        } catch {
            continue;
        }
        for (const [dir, info] of Object.entries(cache)) {
            const storage = join(root, dir, "Local Extension Settings", EXTENSION_ID);
            if (!existsSync(storage)) continue;
            out.push({ browser: rel.split("/")[0] ?? rel, dir, name: info.name ?? dir, account: info.user_name ?? null, storage });
        }
    }
    return out;
};

const storageContains = (dir: string, needle: string): boolean => {
    try {
        for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (!statSync(p).isFile() || statSync(p).size > 64 * 1024 * 1024) continue;
            if (readFileSync(p).includes(needle)) return true;
        }
    } catch {
        /* unreadable store */
    }
    return false;
};

export interface ProfileMatch {
    profile: string;
    account: string | null;
    browser: string;
    profileDir: string;
}

const asMatch = (p: Profile): ProfileMatch => ({ profile: p.name, account: p.account, browser: p.browser, profileDir: p.dir });

// deviceId → profile, for every id at once (each profile's store is scanned once).
export const matchChromeProfiles = (deviceIds: string[]): Map<string, ProfileMatch> => {
    const found = new Map<string, ProfileMatch>();
    const profiles = listProfiles();
    for (const id of deviceIds) {
        const hit = profiles.find((p) => storageContains(p.storage, id));
        if (hit) found.set(id, asMatch(hit));
    }
    // A single profile with the extension and a single connected browser is the same thing even if the store is unreadable.
    if (found.size === 0 && deviceIds.length === 1 && profiles.length === 1 && deviceIds[0] && profiles[0]) found.set(deviceIds[0], asMatch(profiles[0]));
    return found;
};

// macOS application name for a browser data dir, for `open -a`.
const APP_NAMES: Record<string, string> = { Google: "Google Chrome", "Microsoft Edge": "Microsoft Edge", BraveSoftware: "Brave Browser", Arc: "Arc", Vivaldi: "Vivaldi" };

// Opens `url` in that browser profile without any agent: `open -na <app> --args --profile-directory=<dir> <url>` hands the
// URL to the running instance (or starts one) and Chrome honours the profile flag either way.
export const openInProfile = (browser: string, profileDir: string, url: string): Promise<void> =>
    new Promise((resolve, reject) => {
        const app = APP_NAMES[browser] ?? "Google Chrome";
        execFile("open", ["-na", app, "--args", `--profile-directory=${profileDir}`, url], (err) => (err ? reject(err) : resolve()));
    });
