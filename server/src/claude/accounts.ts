import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AccountRow } from "../db.js";
import { claudeEnv } from "./env.js";

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

const probeChromeOnce = async (configDir: string, cwd: string, extraEnv: Record<string, string>): Promise<boolean> => {
    const prompt =
        "Use ToolSearch to load mcp__claude-in-chrome__tabs_context_mcp, then call it once. If it errors, wait 5 seconds and call it once more. " +
        "Reply with exactly CHROME_OK if it returned tab data, otherwise CHROME_FAIL.";
    try {
        const stdout = await runClaudeJson(
            ["-p", prompt, "--chrome", "--output-format", "json", "--permission-mode", "auto", "--max-turns", "6", "--no-session-persistence", "--model", "sonnet"],
            cwd,
            configDir,
            extraEnv,
        );
        const res = z.object({ result: z.string().optional(), is_error: z.boolean().optional() }).safeParse(JSON.parse(stdout));
        console.error(`[probeChrome] ${configDir} cwd=${cwd} → ${res.success ? res.data.result : "unparseable"}`);
        return res.success && (res.data.result ?? "").includes("CHROME_OK");
    } catch (e) {
        console.error(`[probeChrome] ${configDir} failed: ${String(e).slice(0, 300)}`);
        return false;
    }
};

// One trivial run: proves the account's auth works in this config dir and reveals the model it gets without --model.
export const probeDefaultModel = async (configDir: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<{ ok: boolean; model: string | null; error: string | null }> => {
    try {
        const stdout = await runClaudeJson(
            ["-p", "Reply with exactly OK", "--output-format", "json", "--permission-mode", "auto", "--max-turns", "1", "--no-session-persistence", "--no-chrome"],
            cwd,
            configDir,
            extraEnv,
        );
        const res = z.object({ is_error: z.boolean().optional(), result: z.string().optional(), modelUsage: z.record(z.unknown()).optional() }).safeParse(JSON.parse(stdout));
        const model = res.success ? Object.keys(res.data.modelUsage ?? {})[0] ?? null : null;
        const ok = res.success && !res.data.is_error && !!model;
        console.error(`[probeDefaultModel] ${configDir} → ${ok ? model : `failed: ${res.success ? res.data.result?.slice(0, 120) : "unparseable"}`}`);
        return { ok, model, error: ok ? null : (res.success ? res.data.result?.slice(0, 200) : null) ?? "no model usage reported" };
    } catch (e) {
        console.error(`[probeDefaultModel] ${configDir} failed: ${String(e).slice(0, 300)}`);
        return { ok: false, model: null, error: String((e as Error).message ?? e).slice(0, 200) };
    }
};

// The extension bridge connects lazily and occasionally misses the first attempt; three tries separates "flaky" from "not this dir".
export const probeChrome = async (configDir: string, cwd: string, extraEnv: Record<string, string> = {}, attempts = 3): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
        if (await probeChromeOnce(configDir, cwd, extraEnv)) return true;
        await new Promise((r) => setTimeout(r, 3_000));
    }
    return false;
};
