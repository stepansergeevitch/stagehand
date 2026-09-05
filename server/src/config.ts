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
});

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
