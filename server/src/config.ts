import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
    port: z.number().int().default(4747),
    mainConfigDir: z.string(),
    accountsDir: z.string(),
    dataDir: z.string(),
    tmuxSession: z.string().default("stagehand"),
    maxConcurrentRunsPerAccount: z.number().int().default(2),
    // Accounts that clone their QA Chrome profile per run (accounts.chrome_clone_qa): how many cloned Chrome windows may run at once.
    maxChromeClonesPerAccount: z.number().int().default(3),
    preflightUtilizationLimit: z.number().default(0.9),
    clickupToken: z.string().nullable().default(null),
    clickupTeamId: z.string().nullable().default(null),
    // Resolved once from GET /user with the token above and cached here.
    clickupUserId: z.string().nullable().default(null),
    linearApiKey: z.string().nullable().default(null),
    // TypeSafe AI — Jev decision model (jev.ts). Null: Jev-backed judgments use the built-in heuristics.
    typesafeApiKey: z.string().nullable().default(null),
    defaultModel: z.string().nullable().default(null),
    // Where to push "needs you" events: macOS notification centre, and ntfy (phone app subscribed to ntfyTopic).
    notifications: z
        .object({
            macos: z.boolean().default(true),
            ntfyServer: z.string().default("https://ntfy.sh"),
            ntfyTopic: z.string().nullable().default(null),
            ntfyToken: z.string().nullable().default(null),
            // Public UI origin used for click-through links, e.g. https://your-host:4748
            baseUrl: z.string().nullable().default(null),
            // UI origin the desktop notification opens (this Mac): the Vite dev server by default.
            localBaseUrl: z.string().default("http://localhost:5173"),
        })
        .default({}),
    // Per-stage model defaults (task.model overrides); cheaper models for reading-heavy or mechanical stages.
    stageModels: z
        .object({
            research: z.string().nullable().default("sonnet"),
            design_proposal: z.string().nullable().default(null),
            qa_baseline: z.string().nullable().default("sonnet"),
            implementation: z.string().nullable().default(null),
            manual_qa: z.string().nullable().default("sonnet"),
            pr_creation_review: z.string().nullable().default("sonnet"),
            pr_fix: z.string().nullable().default(null),
            helper: z.string().nullable().default("sonnet"),
        })
        .default({}),
    // Prompter, the assistant in the web app (prompter.ts): which token account runs it, its model, when an idle
    // chat is ended, whether it gets a farewell turn to file its notes, and where its palace is seeded from.
    prompter: z
        .object({
            accountId: z.string().nullable().default(null),
            model: z.string().default("fable"),
            // Minutes without a ping from an open chat window before a session is ended (a server restart resets it).
            idleMinutes: z.number().int().default(240),
            farewell: z.boolean().default(true),
            maxTurns: z.number().int().default(40),
            seedFrom: z.string().default(join(homedir(), "code", "northspyre", ".mempalace")),
            seedWings: z.array(z.string()).default(["task-orchestrator=stagehand", "stagehand"]),
        })
        .default({}),
    // How this server is hosted, for POST /api/server/restart: the tmux session whose pane runs it and the command
    // that starts it (null = the repository's own `npx tsx src/index.ts | tee <dataDir>/server.log`).
    server: z
        .object({
            tmuxSession: z.string().default("stagehand-server"),
            startCommand: z.string().nullable().default(null),
        })
        .default({}),
    // Second listener for access from outside the LAN: HTTPS + Basic auth (then a signed cookie), serving the built web UI too.
    publicAccess: z
        .object({
            enabled: z.boolean().default(false),
            host: z.string().default("0.0.0.0"),
            port: z.number().int().default(4748),
            certPath: z.string().nullable().default(null),
            keyPath: z.string().nullable().default(null),
            user: z.string().nullable().default(null),
            // scrypt$<saltHex>$<hashHex>
            passwordHash: z.string().nullable().default(null),
            sessionSecret: z.string().nullable().default(null),
            sessionDays: z.number().int().default(30),
            // Router gateway to ask for a NAT-PMP port mapping (public port = local port); renewed periodically while the server runs.
            natPmpGateway: z.string().nullable().default(null),
        })
        .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

const STAGEHAND_HOME = process.env.STAGEHAND_HOME ?? join(homedir(), ".stagehand");
const CONFIG_PATH = join(STAGEHAND_HOME, "config.json");

const defaults = (): Config => ({
    port: 4747,
    mainConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    accountsDir: join(STAGEHAND_HOME, "accounts"),
    dataDir: STAGEHAND_HOME,
    tmuxSession: "stagehand",
    maxConcurrentRunsPerAccount: 2,
    maxChromeClonesPerAccount: 3,
    preflightUtilizationLimit: 0.9,
    clickupToken: null,
    clickupTeamId: process.env.CLICKUP_TEAM_ID ?? null,
    clickupUserId: null,
    linearApiKey: null,
    typesafeApiKey: null,
    defaultModel: null,
    notifications: { macos: true, ntfyServer: "https://ntfy.sh", ntfyTopic: null, ntfyToken: null, baseUrl: null, localBaseUrl: "http://localhost:5173" },
    stageModels: { research: "sonnet", design_proposal: null, qa_baseline: "sonnet", implementation: null, manual_qa: "sonnet", pr_creation_review: "sonnet", pr_fix: null, helper: "sonnet" },
    prompter: { accountId: null, model: "fable", idleMinutes: 240, farewell: true, maxTurns: 40, seedFrom: join(homedir(), "code", "northspyre", ".mempalace"), seedWings: ["task-orchestrator=stagehand", "stagehand"] },
    server: { tmuxSession: "stagehand-server", startCommand: null },
    publicAccess: { enabled: false, host: "0.0.0.0", port: 4748, certPath: null, keyPath: null, user: null, passwordHash: null, sessionSecret: null, sessionDays: 30, natPmpGateway: null },
});

export const saveConfig = (cfg: Config): void => {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4));
};

export const loadConfig = (): Config => {
    mkdirSync(STAGEHAND_HOME, { recursive: true });
    if (!existsSync(CONFIG_PATH)) {
        const cfg = defaults();
        writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4));
        return cfg;
    }
    const parsed = ConfigSchema.safeParse({ ...defaults(), ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) });
    if (!parsed.success) throw new Error(`Invalid ${CONFIG_PATH}: ${parsed.error.message}`);
    mkdirSync(parsed.data.accountsDir, { recursive: true });
    mkdirSync(join(parsed.data.dataDir, "runs"), { recursive: true });
    return parsed.data;
};
