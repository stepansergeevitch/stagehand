import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Config } from "../config.js";
import { claudeEnv } from "./env.js";

const execFileAsync = promisify(execFile);

const SHARED_ENTRIES = [
    "projects",
    "settings.json",
    "settings.local.json",
    "plugins",
    "skills",
    "agents",
    "commands",
    "CLAUDE.md",
    "MEMPALACE.md",
    "statusline-command.sh",
    "chrome",
    "tasks",
    "sessions",
    "session-env",
    "file-history",
    "shell-snapshots",
    "history.jsonl",
];

export const AuthStatus = z.object({
    loggedIn: z.boolean(),
    authMethod: z.string().optional(),
    email: z.string().nullable().optional(),
    orgName: z.string().nullable().optional(),
    subscriptionType: z.string().nullable().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const accountDirFor = (cfg: Config, name: string): string => join(cfg.accountsDir, name);

export const scaffoldAccountDir = (cfg: Config, name: string): string => {
    const dir = accountDirFor(cfg, name);
    mkdirSync(dir, { recursive: true });
    for (const entry of SHARED_ENTRIES) {
        const src = join(cfg.mainConfigDir, entry);
        const dst = join(dir, entry);
        if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst);
    }
    const mainJson = join(cfg.mainConfigDir, ".claude.json");
    const accJson = join(dir, ".claude.json");
    if (existsSync(mainJson) && !existsSync(accJson)) copyFileSync(mainJson, accJson);
    return dir;
};

export const loginCommand = (configDir: string, email?: string): string => {
    const parts = [`CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)}`, "claude", "auth", "login", "--claudeai"];
    if (email) parts.push("--email", JSON.stringify(email));
    return parts.join(" ");
};

export const readAuthStatus = async (configDir: string): Promise<AuthStatus> => {
    try {
        const { stdout } = await execFileAsync("claude", ["auth", "status"], { env: claudeEnv(configDir) });
        const parsed = AuthStatus.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data : { loggedIn: false };
    } catch {
        return { loggedIn: false };
    }
};

// stdin must be closed: with an open pipe claude waits for input and the Chrome bridge never attaches.
const runClaudeJson = (args: string[], cwd: string, configDir: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const child = spawn("claude", args, { cwd, env: claudeEnv(configDir), stdio: ["ignore", "pipe", "pipe"] });
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

const probeChromeOnce = async (configDir: string, cwd: string): Promise<boolean> => {
    const prompt =
        "Use ToolSearch to load mcp__claude-in-chrome__tabs_context_mcp, then call it once. If it errors, wait 5 seconds and call it once more. " +
        "Reply with exactly CHROME_OK if it returned tab data, otherwise CHROME_FAIL.";
    try {
        const stdout = await runClaudeJson(
            ["-p", prompt, "--chrome", "--output-format", "json", "--permission-mode", "auto", "--max-turns", "6", "--no-session-persistence"],
            cwd,
            configDir,
        );
        const res = z.object({ result: z.string().optional(), is_error: z.boolean().optional() }).safeParse(JSON.parse(stdout));
        console.error(`[probeChrome] ${configDir} cwd=${cwd} → ${res.success ? res.data.result : "unparseable"}`);
        return res.success && (res.data.result ?? "").includes("CHROME_OK");
    } catch (e) {
        console.error(`[probeChrome] ${configDir} failed: ${String(e).slice(0, 300)}`);
        return false;
    }
};

// The extension bridge connects lazily and occasionally misses the first attempt; three tries separates "flaky" from "not this account".
export const probeChrome = async (configDir: string, cwd: string, attempts = 3): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
        if (await probeChromeOnce(configDir, cwd)) return true;
        await new Promise((r) => setTimeout(r, 3_000));
    }
    return false;
};
