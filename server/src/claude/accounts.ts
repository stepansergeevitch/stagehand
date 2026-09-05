import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Config } from "../config.js";

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
        const { stdout } = await execFileAsync("claude", ["auth", "status"], {
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        });
        const parsed = AuthStatus.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data : { loggedIn: false };
    } catch {
        return { loggedIn: false };
    }
};

export const probeChrome = async (configDir: string, cwd: string): Promise<boolean> => {
    const prompt =
        "Use ToolSearch to load mcp__claude-in-chrome__tabs_context_mcp, then call it once. " +
        "Reply with exactly CHROME_OK if it returned tab data, otherwise CHROME_FAIL.";
    try {
        const { stdout } = await execFileAsync(
            "claude",
            ["-p", prompt, "--chrome", "--output-format", "json", "--permission-mode", "auto", "--max-turns", "4", "--no-session-persistence"],
            { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, timeout: 120_000 },
        );
        const res = z.object({ result: z.string().optional() }).safeParse(JSON.parse(stdout));
        return res.success && (res.data.result ?? "").includes("CHROME_OK");
    } catch {
        return false;
    }
};
