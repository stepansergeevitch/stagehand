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
    preflightUtilizationLimit: z.number().default(0.9),
    clickupToken: z.string().nullable().default(null),
    clickupTeamId: z.string().nullable().default(null),
    // Resolved once from GET /user with the token above and cached here.
    clickupUserId: z.string().nullable().default(null),
    linearApiKey: z.string().nullable().default(null),
    // Anthropic Admin API key with the read:analytics scope (Claude Enterprise orgs only): enables the organization
    // usage section in Analytics. Optional tagged user id (user_…) narrows the report to one member.
    anthropicAdminKey: z.string().nullable().default(null),
    anthropicUserId: z.string().nullable().default(null),
    defaultModel: z.string().nullable().default(null),
    // Per-stage model defaults (task.model overrides); cheaper models for reading-heavy or mechanical stages.
    stageModels: z
        .object({
            research: z.string().nullable().default("sonnet"),
            design_proposal: z.string().nullable().default(null),
            qa_baseline: z.string().nullable().default("sonnet"),
            implementation: z.string().nullable().default(null),
            manual_qa: z.string().nullable().default("sonnet"),
            pr_creation_review: z.string().nullable().default("sonnet"),
            pr_red: z.string().nullable().default(null),
            helper: z.string().nullable().default("sonnet"),
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
    preflightUtilizationLimit: 0.9,
    clickupToken: null,
    clickupTeamId: process.env.CLICKUP_TEAM_ID ?? null,
    clickupUserId: null,
    linearApiKey: null,
    anthropicAdminKey: null,
    anthropicUserId: null,
    defaultModel: null,
    stageModels: { research: "sonnet", design_proposal: null, qa_baseline: "sonnet", implementation: null, manual_qa: "sonnet", pr_creation_review: "sonnet", pr_red: null, helper: "sonnet" },
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
