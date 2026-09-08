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

export interface ChromeTab { window: number; tab: number; url: string; title: string }

const osascript = (script: string): Promise<string> =>
    new Promise((resolve, reject) => {
        execFile("osascript", ["-e", script], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });

// Every tab of every window of the running Chrome (all profiles share one process), with 1-based indices that
// `setTabUrl` accepts. Empty when Chrome is not running.
export const listChromeTabs = async (browser = "Google"): Promise<ChromeTab[]> => {
    const app = APP_NAMES[browser] ?? "Google Chrome";
    const script =
        `if application "${app}" is not running then return ""\n` +
        `set sep to character id 9\ntell application "${app}"\n set out to ""\n repeat with w from 1 to count of windows\n  repeat with t from 1 to count of tabs of window w\n` +
        `   set out to out & w & sep & t & sep & (URL of tab t of window w) & sep & (title of tab t of window w) & linefeed\n  end repeat\n end repeat\n return out\nend tell`;
    const out = await osascript(script).catch(() => "");
    return out.split("\n").filter(Boolean).map((line) => {
        const [w, t, url = "", ...title] = line.split("\t");
        return { window: Number(w), tab: Number(t), url, title: title.join("\t") };
    });
};

export const setChromeTabUrl = (tabRef: Pick<ChromeTab, "window" | "tab">, url: string, browser = "Google"): Promise<void> => {
    const app = APP_NAMES[browser] ?? "Google Chrome";
    return osascript(`tell application "${app}" to set URL of tab ${tabRef.tab} of window ${tabRef.window} to "${url.replace(/"/g, '\\"')}"`).then(() => undefined);
};

// Quits and relaunches the browser entirely — closes every window/tab, not just the automation profile. A brand-new
// CLAUDE_CONFIG_DIR's first Chrome bridge connection often fails until the browser is restarted once (confirmed
// 2026-09-08: the extension's own error names this — "If this is your first time connecting to Chrome, you may need
// to restart Chrome for the installation to take effect" — and a probe that failed before a restart succeeded right
// after, from the same directory, with nothing else changed). Used only as an explicit, human-triggered fallback
// (the Probe Chrome button) after a first probe attempt fails — never from an unattended background dispatch.
export const restartChrome = async (browser = "Google"): Promise<void> => {
    const app = APP_NAMES[browser] ?? "Google Chrome";
    await new Promise<void>((resolve) => execFile("osascript", ["-e", `tell application "${app}" to quit`], () => resolve()));
    await new Promise((r) => setTimeout(r, 2_000));
    await new Promise<void>((resolve, reject) => execFile("open", ["-a", app], (err) => (err ? reject(err) : resolve())));
    await new Promise((r) => setTimeout(r, 3_000));
};
