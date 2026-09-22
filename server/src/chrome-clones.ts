import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ClassicLevel } from "classic-level";
import { APP_NAMES, QA_CHROME_FLAGS } from "./chrome-profiles.js";

// A cloned Chrome profile per browser QA run. The QA Chrome profile (the one whose Claude extension is paired with the
// account) is copied into a private user-data-dir, the copy gets its own extension identity, and a separate Chrome
// process runs it beside the human's Chrome. Several copies can run at once, so browser stages of one account no
// longer queue behind each other, and each copy always starts with the QA launch flags. Facts this rests on
// (verified 2026-09-22): the Claude Code bridge is native messaging whose host manifest lives per user and per browser
// brand (not per user-data-dir), so any Chrome instance of the same brand reaches it; the extension identifies a
// browser by `bridgeDeviceId` in its chrome.storage.local (a LevelDB under "Local Extension Settings"), created once
// with crypto.randomUUID(); a copy with the same id never registers as a second browser, a copy whose storage was
// deleted never connects at all (its pairing is in that storage), while a copy with the id rewritten shows up as
// its own browser and keeps the claude.ai login (persistent cookies decrypt in any user-data-dir of the same brand —
// the macOS keychain item is per brand). AppleScript addresses one Chrome instance only, so a clone's tabs are
// driven through its own CDP port instead.

const execFileAsync = promisify(execFile);

export const EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
export const CLONES_ROOT = join(homedir(), ".stagehand", "chrome-clones");
const CDP_PORT_RANGE: [number, number] = [9333, 9399];
const LAUNCH_TIMEOUT_MS = 30_000;

// Profile entries that are pure cache, history or sync state: skipped so a copy is ~85 MB instead of ~770 MB and
// takes under a second (Profile 2, 2026-09-22). Everything else (Cookies, Local Storage, IndexedDB, Extensions and
// their settings, Preferences) comes over.
export const CLONE_EXCLUDES = [
    "Service Worker",
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnWebGPUCache",
    "DawnGraphiteCache",
    "Sessions",
    "Session Storage",
    "blob_storage",
    "File System",
    "optimization_guide*",
    "shared_proto_db",
    "Site Characteristics Database",
    "BudgetDatabase",
    "Feature Engagement Tracker",
    "Segmentation Platform",
    "History*",
    "Favicons*",
    "Top Sites*",
    "Visited Links",
    "Network Action Predictor*",
    "Download Service",
    "GCM Store",
    "Safe Browsing*",
    "heavy_ad_intervention_opt_out.db*",
    "PersistentOriginTrials",
    "commerce_subscription_db",
    "parcel_tracking_db",
    "discounts_db",
    "coupon_db",
    "Sync Data",
    "Sync App Settings",
    "Sync Extension Settings",
] as const;

// The user-data-dir of a browser brand as chrome-profiles names it ("Google", "Microsoft Edge", …).
const USER_DATA_DIRS: Record<string, string> = {
    Google: "Google/Chrome",
    "Microsoft Edge": "Microsoft Edge",
    BraveSoftware: "BraveSoftware/Brave-Browser",
    Arc: "Arc/User Data",
    Vivaldi: "Vivaldi",
};
export const userDataDirFor = (browser: string): string => join(homedir(), "Library", "Application Support", USER_DATA_DIRS[browser] ?? "Google/Chrome");

export interface ChromeClone {
    // Directory name under CLONES_ROOT (also the tmux-free handle shown in status lines).
    slot: string;
    dir: string;
    // The extension identity the QA runner selects (select_browser deviceId).
    deviceId: string;
    cdpPort: number;
    pid: number | null;
    browser: string;
}

export const rsyncArgs = (src: string, dst: string): string[] => ["-a", ...CLONE_EXCLUDES.flatMap((e) => ["--exclude", e]), `${src}/`, `${dst}/`];

// Chrome writes values of chrome.storage.local as JSON text; a copied store therefore holds "\"<uuid>\"" (with quotes).
// The new id is written in the same encoding as the one found, so an unexpected layout is not made worse.
export const rewriteBridgeDeviceId = async (storageDir: string, newId: string): Promise<{ previous: string | null }> => {
    // A store copied from a running Chrome carries its LOCK file; LevelDB refuses to open with it present.
    rmSync(join(storageDir, "LOCK"), { force: true });
    const db = new ClassicLevel<string, string>(storageDir, { keyEncoding: "utf8", valueEncoding: "utf8", createIfMissing: false });
    await db.open();
    try {
        // classic-level 2 resolves a missing key to undefined (older releases threw).
        const previous: string | null = (await db.get("bridgeDeviceId").catch(() => undefined)) ?? null;
        const encoded = previous === null || previous.startsWith('"') ? JSON.stringify(newId) : newId;
        await db.put("bridgeDeviceId", encoded);
        return { previous };
    } finally {
        await db.close();
    }
};

// Marks the copied profile as cleanly exited, so the clone does not open with Chrome's "restore pages?" bubble.
const markCleanExit = (profileDir: string): void => {
    const path = join(profileDir, "Preferences");
    if (!existsSync(path)) return;
    try {
        const prefs = JSON.parse(readFileSync(path, "utf8")) as { profile?: Record<string, unknown> };
        prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
        writeFileSync(path, JSON.stringify(prefs));
    } catch {
        /* the bubble is cosmetic */
    }
};

const portFree = async (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const srv = createServer();
        srv.once("error", () => resolve(false));
        srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });

export const pickCdpPort = async (taken: Set<number>): Promise<number> => {
    const [lo, hi] = CDP_PORT_RANGE;
    for (let p = lo; p <= hi; p++) if (!taken.has(p) && (await portFree(p))) return p;
    throw new Error(`no free CDP port in ${lo}-${hi}`);
};

// Copies the profile and gives the copy its own extension identity. Nothing is launched yet.
export const cloneProfile = async (browser: string, profileDir: string, slot: string, cdpPort: number): Promise<ChromeClone> => {
    const src = join(userDataDirFor(browser), profileDir);
    if (!existsSync(src)) throw new Error(`Chrome profile directory not found: ${src}`);
    const dir = join(CLONES_ROOT, slot);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "Default"), { recursive: true });
    await execFileAsync("rsync", rsyncArgs(src, join(dir, "Default")), { maxBuffer: 1024 * 1024 });
    markCleanExit(join(dir, "Default"));
    const storage = join(dir, "Default", "Local Extension Settings", EXTENSION_ID);
    if (!existsSync(storage)) throw new Error(`the Claude extension's storage is missing in ${profileDir} (${storage})`);
    const deviceId = randomUUID();
    await rewriteBridgeDeviceId(storage, deviceId);
    return { slot, dir, deviceId, cdpPort, pid: null, browser };
};

const pidOf = async (dir: string): Promise<number | null> => {
    // "--" ends option parsing: the pattern itself starts with "--".
    const { stdout } = await execFileAsync("pgrep", ["-f", "--", `--user-data-dir=${dir}`]).catch(() => ({ stdout: "" }));
    // The browser process is the lowest pid of the family (helpers are its children, spawned later).
    const pids = stdout
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
    return pids[0] ?? null;
};

// Starts a separate Chrome on the clone (beside whatever Chrome the human runs) and waits until its CDP port answers.
// `index` staggers the window so several clones do not stack exactly on top of each other.
export const launchClone = async (clone: ChromeClone, url: string, index = 0): Promise<ChromeClone> => {
    const app = APP_NAMES[clone.browser] ?? "Google Chrome";
    // -g: the new Chrome starts behind the human's windows instead of taking the front.
    const args = [
        "-g",
        "-na",
        app,
        "--args",
        `--user-data-dir=${clone.dir}`,
        "--profile-directory=Default",
        ...QA_CHROME_FLAGS,
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        `--remote-debugging-port=${clone.cdpPort}`,
        "--window-size=1440,900",
        `--window-position=${80 + 40 * index},${60 + 30 * index}`,
        url,
    ];
    await execFileAsync("open", args);
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await cdpAlive(clone.cdpPort)) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await cdpAlive(clone.cdpPort))) {
        await quitClone(clone);
        throw new Error(`cloned Chrome did not open its debugging port ${clone.cdpPort} within ${LAUNCH_TIMEOUT_MS / 1000} s`);
    }
    return { ...clone, pid: await pidOf(clone.dir) };
};

export interface CdpTab {
    id: string;
    type: string;
    url: string;
    title: string;
}

const cdpGet = async <T>(port: number, path: string, method: "GET" | "PUT" = "GET"): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(`CDP ${path} → ${res.status}`);
    const text = await res.text();
    return (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text) as T;
};

export const cdpAlive = (port: number): Promise<boolean> => cdpGet<unknown>(port, "/json/version").then(() => true, () => false);

export const cdpTabs = async (port: number): Promise<CdpTab[]> => {
    const all = await cdpGet<CdpTab[]>(port, "/json");
    return all.filter((t) => t.type === "page");
};

export const cdpActivate = (port: number, id: string): Promise<unknown> => cdpGet(port, `/json/activate/${id}`);
export const cdpClose = (port: number, id: string): Promise<unknown> => cdpGet(port, `/json/close/${id}`);
export const cdpNewTab = (port: number, url: string): Promise<CdpTab> => cdpGet<CdpTab>(port, `/json/new?${url}`, "PUT");

// Same job as activateChromeTab for the human's Chrome: keep the newest tab on the app origin in front (a background
// tab stops rendering popovers). /json lists the front tab first, so nothing is done while an app tab is already in
// front — CDP activation raises the whole window to the top of the screen, which must not happen every few seconds.
export const activateCloneTab = async (port: number, urlPrefix: string): Promise<boolean> => {
    try {
        const tabs = await cdpTabs(port);
        if (tabs[0]?.url.startsWith(urlPrefix)) return true;
        const tab = tabs.find((t) => t.url.startsWith(urlPrefix));
        if (!tab) return false;
        await cdpActivate(port, tab.id);
        return true;
    } catch {
        return false;
    }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ends the clone's Chrome (TERM, then KILL) and deletes its directory. Never throws.
export const quitClone = async (clone: Pick<ChromeClone, "dir" | "pid">): Promise<void> => {
    const pid = clone.pid ?? (await pidOf(clone.dir));
    if (pid) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            /* already gone */
        }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && (await pidOf(clone.dir)) !== null) await sleep(300);
    }
    // Helpers that outlived the browser process, or a browser that ignored TERM.
    await execFileAsync("pkill", ["-9", "-f", "--", `--user-data-dir=${clone.dir}`]).catch(() => undefined);
    await sleep(200);
    rmSync(clone.dir, { recursive: true, force: true });
};

// Ends every clone this server does not know about (after a restart, or a run that died without cleanup) and
// removes leftover directories. `keep` holds the directories of clones still in use.
export const sweepClones = async (keep: Set<string>): Promise<number> => {
    if (!existsSync(CLONES_ROOT)) return 0;
    let n = 0;
    for (const name of readdirSync(CLONES_ROOT)) {
        const dir = join(CLONES_ROOT, name);
        if (keep.has(dir)) continue;
        await quitClone({ dir, pid: null });
        n++;
    }
    return n;
};
