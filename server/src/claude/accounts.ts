import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AccountRow } from "../db.js";
import { claudeEnv } from "./env.js";
import { ResultEvent } from "./runner.js";

const execFileAsync = promisify(execFile);

export const AuthStatus = z.object({
    loggedIn: z.boolean(),
    authMethod: z.string().optional(),
    email: z.string().nullable().optional(),
    orgName: z.string().nullable().optional(),
    subscriptionType: z.string().nullable().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

// Scratch config dir used only while `claude setup-token` runs for this account (and by legacy browser logins).
export const authDirFor = (cfg: Config, name: string): string => {
    const dir = join(cfg.dataDir, "auth", name);
    mkdirSync(dir, { recursive: true });
    return dir;
};

// Where this account's BROWSER login lives (Claude Code keys logins by config dir path): its auth dir when Stagehand
// owns it, otherwise a Stagehand-owned dir the human logs into once. Browser stages run there with the env's config dir
// content mirrored in, because the Chrome bridge only answers under a claude.ai browser login.
export const browserDirFor = (cfg: Config, acc: Pick<AccountRow, "name" | "auth_dir">): string => {
    if (acc.auth_dir.startsWith(`${cfg.dataDir}/`)) return acc.auth_dir;
    const dir = join(cfg.dataDir, "browser", acc.name);
    mkdirSync(dir, { recursive: true });
    return dir;
};

// Entries of a config dir that carry behaviour (everything except login/session state); symlinked into a browser dir.
const MIRROR_SKIP = new Set([".claude.json", ".credentials.json", "setup-token.log", "backups", "cache", "debug", "statsig", "todos", "telemetry", "ide", "paste-cache", "sessions", "session-env", "shell-snapshots", "file-history", "history.jsonl", "daemon", "daemon.lock", "daemon.log", "daemon.status.json", "jobs", "exports"]);

// Makes `browserDir` behave like `configDir`: every behaviour entry of the config dir is symlinked in (existing symlinks
// are re-pointed, real files are left alone), and .claude.json (MCP servers, onboarding flags) is copied once.
// Never applied to a directory Stagehand does not own.
export const mirrorConfigDir = (cfg: Config, configDir: string, browserDir: string): void => {
    if (browserDir === configDir || !browserDir.startsWith(`${cfg.dataDir}/`)) return;
    for (const entry of readdirSync(configDir)) {
        if (MIRROR_SKIP.has(entry) || entry.endsWith("~") || entry.startsWith("#")) continue;
        const src = join(configDir, entry);
        const dst = join(browserDir, entry);
        try {
            const st = lstatSync(dst);
            if (st.isSymbolicLink()) {
                if (readlinkSync(dst) !== src) {
                    unlinkSync(dst);
                    symlinkSync(src, dst);
                }
            }
            // a real file/dir in the browser dir is the account's own; keep it
        } catch {
            symlinkSync(src, dst);
        }
    }
    const json = join(browserDir, ".claude.json");
    if (!existsSync(json) && existsSync(join(configDir, ".claude.json"))) copyFileSync(join(configDir, ".claude.json"), json);
};

// Environment that makes `claude` use this account: the long-lived OAuth token wins over whatever login the config dir holds.
export const authEnv = (acc: Pick<AccountRow, "oauth_token"> | null | undefined): Record<string, string> =>
    acc?.oauth_token ? { CLAUDE_CODE_OAUTH_TOKEN: acc.oauth_token } : {};

export const SETUP_TOKEN_COMMAND = "claude setup-token";
// What `claude setup-token` prints once the browser flow completes.
export const OAUTH_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/;

export const readAuthStatus = async (configDir: string, extraEnv: Record<string, string> = {}): Promise<AuthStatus> => {
    try {
        const { stdout } = await execFileAsync("claude", ["auth", "status"], { env: claudeEnv(configDir, extraEnv) });
        const parsed = AuthStatus.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data : { loggedIn: false };
    } catch {
        return { loggedIn: false };
    }
};

// stdin must be closed: with an open pipe claude waits for input and the Chrome bridge never attaches.
const runClaudeJson = (args: string[], cwd: string, configDir: string, extraEnv: Record<string, string>): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = spawn("claude", args, { cwd, env: claudeEnv(configDir, extraEnv), stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
        const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(-300)}`));
        });
        child.on("error", reject);
    });

// `--output-format json` prints the same object as the stream's final result event; keep it so the caller can record usage.
const parseResult = (stdout: string): ResultEvent | null => {
    try {
        const parsed = ResultEvent.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
};

export interface ChromeProbe {
    ok: boolean;
    browsers: Array<{ deviceId: string; name: string }>;
    result: ResultEvent | null;
}

// Runs WITHOUT an account token on purpose: Claude Code keeps Chrome integration off for token/API-key sessions, so the
// bridge only answers under the dir's own browser login. Also lists the connected Chrome profiles (extension instances).
const probeChromeOnce = async (configDir: string, cwd: string): Promise<ChromeProbe> => {
    const prompt =
        "Use ToolSearch to load mcp__claude-in-chrome__list_connected_browsers and mcp__claude-in-chrome__tabs_context_mcp. " +
        "Call list_connected_browsers once and remember its JSON. Then call tabs_context_mcp once; if it throws an error (for example \"extension is not connected\"), wait 5 seconds and call it once more. " +
        "Never call AskUserQuestion, select_browser or switch_browser. " +
        "Success means tabs_context_mcp returned without an error — an empty tab list or no tab group counts as success. " +
        'Reply with exactly one line: CHROME_OK <the JSON array from list_connected_browsers> on success, otherwise CHROME_FAIL <the error text>.';
    try {
        const stdout = await runClaudeJson(
            ["-p", prompt, "--chrome", "--output-format", "json", "--permission-mode", "auto", "--max-turns", "8", "--no-session-persistence", "--model", "sonnet"],
            cwd,
            configDir,
            {},
        );
        const result = parseResult(stdout);
        const text = result?.result ?? "";
        console.error(`[probeChrome] ${configDir} cwd=${cwd} → ${text.slice(0, 200) || "unparseable"}`);
        const ok = text.includes("CHROME_OK");
        let browsers: ChromeProbe["browsers"] = [];
        const m = /\[[\s\S]*\]/.exec(text);
        if (ok && m) {
            try {
                const parsed = z.array(z.object({ deviceId: z.string(), name: z.string().optional() })).safeParse(JSON.parse(m[0]));
                if (parsed.success) browsers = parsed.data.map((b) => ({ deviceId: b.deviceId, name: b.name ?? b.deviceId.slice(0, 8) }));
            } catch {
                /* browsers stay empty */
            }
        }
        return { ok, browsers, result };
    } catch (e) {
        console.error(`[probeChrome] ${configDir} failed: ${String(e).slice(0, 300)}`);
        return { ok: false, browsers: [], result: null };
    }
};

// One trivial run: proves the account's auth works in this config dir and reveals the model it gets without --model.
export const probeDefaultModel = async (configDir: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<{ ok: boolean; model: string | null; error: string | null; result: ResultEvent | null }> => {
    try {
        const stdout = await runClaudeJson(
            ["-p", "Reply with exactly OK", "--output-format", "json", "--permission-mode", "auto", "--max-turns", "1", "--no-session-persistence", "--no-chrome"],
            cwd,
            configDir,
            extraEnv,
        );
        const result = parseResult(stdout);
        const model = result ? Object.keys(result.modelUsage ?? {})[0] ?? null : null;
        const ok = !!result && !result.is_error && !!model;
        console.error(`[probeDefaultModel] ${configDir} → ${ok ? model : `failed: ${result?.result?.slice(0, 120) ?? "unparseable"}`}`);
        return { ok, model, error: ok ? null : result?.result?.slice(0, 200) ?? "no model usage reported", result };
    } catch (e) {
        console.error(`[probeDefaultModel] ${configDir} failed: ${String(e).slice(0, 300)}`);
        return { ok: false, model: null, error: String((e as Error).message ?? e).slice(0, 200), result: null };
    }
};

// The extension bridge connects lazily and occasionally misses the first attempt; three tries separates "flaky" from "not this dir".
// Every attempt's result is reported so the caller can record what the probes consumed.
export const probeChrome = async (configDir: string, cwd: string, attempts = 3, onResult?: (r: ResultEvent) => void): Promise<{ ok: boolean; browsers: ChromeProbe["browsers"] }> => {
    for (let i = 0; i < attempts; i++) {
        const { ok, browsers, result } = await probeChromeOnce(configDir, cwd);
        if (result && onResult) onResult(result);
        if (ok) return { ok: true, browsers };
        await new Promise((r) => setTimeout(r, 3_000));
    }
    return { ok: false, browsers: [] };
};
