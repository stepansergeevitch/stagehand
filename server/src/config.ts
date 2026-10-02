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
    // QA passes run their scenarios in parallel shards (qa-shards.ts): at most this many runs per pass; 0 = one run.
    qaShards: z.number().int().default(4),
    // The Code Review stage after Implementation (gstack's review checklist and method); false = skipped.
    codeReview: z.boolean().default(true),
    // A checkout of github.com/garrytan/gstack: its review/checklist.md is read by the Code Review prompt at run time.
    gstackDir: z.string().default(join(homedir(), ".stagehand", "gstack")),
    clickupToken: z.string().nullable().default(null),
    clickupTeamId: z.string().nullable().default(null),
    // Resolved once from GET /user with the token above and cached here.
    clickupUserId: z.string().nullable().default(null),
    linearApiKey: z.string().nullable().default(null),
    // Notion integration token (an internal integration shared with the pages): Product Owners fetch pages by URL.
    notionApiKey: z.string().nullable().default(null),
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
    // Per-stage model for the FIRST run of a stage on a task (task.model overrides); cheaper models for reading-heavy
    // or mechanical stages. Null = defaultModel, else the account's default.
    stageModels: z
        .object({
            research: z.string().nullable().default("sonnet"),
            design_proposal: z.string().nullable().default(null),
            qa_baseline: z.string().nullable().default("sonnet"),
            implementation: z.string().nullable().default(null),
            code_review: z.string().nullable().default(null),
            manual_qa: z.string().nullable().default("sonnet"),
            pr_creation_review: z.string().nullable().default("sonnet"),
            pr_fix: z.string().nullable().default(null),
            helper: z.string().nullable().default("sonnet"),
        })
        .default({}),
    // Per-stage model for every LATER run of a stage on the same task — a review round sent back, a Retry, a contract
    // or unblock retry, a QA pass that returns to Implementation. Null = the first-run model of that stage.
    stageRerunModels: z
        .object({
            research: z.string().nullable().default(null),
            design_proposal: z.string().nullable().default(null),
            qa_baseline: z.string().nullable().default(null),
            implementation: z.string().nullable().default(null),
            code_review: z.string().nullable().default(null),
            manual_qa: z.string().nullable().default(null),
            pr_creation_review: z.string().nullable().default(null),
            pr_fix: z.string().nullable().default(null),
        })
        .default({}),
    // Models for the runs that are not pipeline stages (task.model overrides). Null = defaultModel, else the account's
    // default. pr_fix_ci / pr_fix_comments are PR Fix runs started for failing checks / for PR or Code-changes
    // comments; when set they win over stageModels.pr_fix for that run.
    operationModels: z
        .object({
            pr_fix_ci: z.string().nullable().default(null),
            pr_fix_comments: z.string().nullable().default(null),
            chat: z.string().nullable().default(null),
            instruct: z.string().nullable().default(null),
            rebase: z.string().nullable().default(null),
            fix_service: z.string().nullable().default(null),
            git_edit: z.string().nullable().default(null),
        })
        .default({}),
    // Prompter, the assistant in the web app (prompter.ts): which token account runs it, its model, when an idle
    // chat is ended, whether it gets a farewell turn to file its notes, and where its palace is seeded from.
    prompter: z
        .object({
            accountId: z.string().nullable().default(null),
            model: z.string().default("fable"),
            // Hours without activity (a message, or an open window's ping) before a chat is ended; closed chats and
            // their logs are removed after purgeDays.
            idleHours: z.number().default(24),
            purgeDays: z.number().default(7),
            farewell: z.boolean().default(true),
            maxTurns: z.number().int().default(40),
            seedFrom: z.string().default(""),
            seedWings: z.array(z.string()).default(["task-orchestrator=stagehand", "stagehand"]),
        })
        .default({}),
    // Resource policies (resources.ts): when a parked task's BE/FE, an idle terminal, a leftover browser or an orphan
    // pane is stopped, the dev-server cap, and the memory thresholds that drop every grace period to zero.
    resources: z
        .object({
            enabled: z.boolean().default(true),
            idleServiceMinutes: z.number().min(0).default(30),
            doneServiceMinutes: z.number().min(0).default(5),
            settleMinutes: z.number().min(0).default(20),
            // A task session whose transcript passes this many MB is rotated before the next resumed run (0 = never).
            maxSessionMb: z.number().min(0).default(12),
            terminalIdleHours: z.number().min(0).default(6),
            sessionIdleHours: z.number().min(0).default(12),
            loginMinutes: z.number().min(0).default(30),
            orphanMinutes: z.number().min(0).default(10),
            maxDevServerTasks: z.number().int().min(1).default(3),
            minAvailableMb: z.number().min(0).default(6144),
            maxSwapMb: z.number().min(0).default(8192),
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
    qaShards: 4,
    codeReview: true,
    gstackDir: join(homedir(), ".stagehand", "gstack"),
    clickupToken: null,
    clickupTeamId: process.env.CLICKUP_TEAM_ID ?? null,
    clickupUserId: null,
    linearApiKey: null,
    notionApiKey: null,
    typesafeApiKey: null,
    defaultModel: null,
    notifications: { macos: true, ntfyServer: "https://ntfy.sh", ntfyTopic: null, ntfyToken: null, baseUrl: null, localBaseUrl: "http://localhost:5173" },
    stageModels: { research: "sonnet", design_proposal: null, qa_baseline: "sonnet", implementation: null, code_review: null, manual_qa: "sonnet", pr_creation_review: "sonnet", pr_fix: null, helper: "sonnet" },
    stageRerunModels: { research: null, design_proposal: null, qa_baseline: null, implementation: null, code_review: null, manual_qa: null, pr_creation_review: null, pr_fix: null },
    operationModels: { pr_fix_ci: null, pr_fix_comments: null, chat: null, instruct: null, rebase: null, fix_service: null, git_edit: null },
    prompter: { accountId: null, model: "fable", idleHours: 24, purgeDays: 7, farewell: true, maxTurns: 40, seedFrom: "", seedWings: ["task-orchestrator=stagehand", "stagehand"] },
    resources: { enabled: true, idleServiceMinutes: 30, doneServiceMinutes: 5, settleMinutes: 20, maxSessionMb: 12, terminalIdleHours: 6, sessionIdleHours: 12, loginMinutes: 30, orphanMinutes: 10, maxDevServerTasks: 3, minAvailableMb: 6144, maxSwapMb: 8192 },
    server: { tmuxSession: "stagehand-server", startCommand: null },
    publicAccess: { enabled: false, host: "0.0.0.0", port: 4748, certPath: null, keyPath: null, user: null, passwordHash: null, sessionSecret: null, sessionDays: 30, natPmpGateway: null },
});

// A preview instance (scripts/preview.sh): a second server started from a worktree branch on its own port, sharing
// the data dir with the live server, for testing a change before it lands. It runs no scheduler, pollers, reaper or
// public listener, starts no runs, and never writes config.json.
export const PREVIEW = process.env["STAGEHAND_PREVIEW"] === "1";
const PREVIEW_PORT = Number(process.env["STAGEHAND_PORT"] ?? 4757);

export const saveConfig = (cfg: Config): void => {
    if (PREVIEW) {
        console.warn("[stagehand] preview instance: config.json not written");
        return;
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4));
};

const previewOverrides = (cfg: Config): Config => (PREVIEW ? { ...cfg, port: PREVIEW_PORT, publicAccess: { ...cfg.publicAccess, enabled: false } } : cfg);

export const loadConfig = (): Config => {
    mkdirSync(STAGEHAND_HOME, { recursive: true });
    if (!existsSync(CONFIG_PATH)) {
        const cfg = defaults();
        if (!PREVIEW) writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4));
        return previewOverrides(cfg);
    }
    const parsed = ConfigSchema.safeParse({ ...defaults(), ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) });
    if (!parsed.success) throw new Error(`Invalid ${CONFIG_PATH}: ${parsed.error.message}`);
    mkdirSync(parsed.data.accountsDir, { recursive: true });
    mkdirSync(join(parsed.data.dataDir, "runs"), { recursive: true });
    return previewOverrides(parsed.data);
};
