import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type Stage =
    | "research"
    | "design_proposal"
    | "qa_baseline"
    | "implementation"
    | "manual_qa"
    | "user_review"
    | "pr_creation_review"
    | "pr_waiting"
    | "pr_red"
    | "pr_green"
    | "pr_approved"
    | "done";

export const STAGES: readonly Stage[] = [
    "research",
    "design_proposal",
    "qa_baseline",
    "implementation",
    "manual_qa",
    "user_review",
    "pr_creation_review",
    "pr_waiting",
    "pr_red",
    "pr_green",
    "pr_approved",
    "done",
];

export const WAIT_STAGES: ReadonlySet<Stage> = new Set(["design_proposal", "user_review", "pr_creation_review"]);

export type TaskStatus = "idle" | "running" | "waiting_user" | "blocked" | "rate_limited" | "failed" | "done" | "stopped";
export type RunStatus = "queued" | "running" | "blocked" | "rate_limited" | "done" | "failed" | "stopped";

// An AI provider login. Anthropic accounts carry a long-lived OAuth token (from `claude setup-token`), which lets the same
// account run in any Claude config dir. Accounts without a token are legacy browser logins that live inside `auth_dir`
// and therefore only work when that directory is the run's config dir.
export interface AccountRow {
    id: string;
    name: string;
    provider: string;
    auth_dir: string;
    oauth_token: string | null;
    email: string | null;
    org: string | null;
    plan: string | null;
    logged_in: number;
    chrome_capable: number | null;
    failover_enabled: number;
    failover_threshold: number;
    // What `claude` picks when no --model is passed for this account (observed from run init events / a probe).
    default_model: string | null;
    created_at: string;
}

export const hasToken = (a: Pick<AccountRow, "oauth_token">): boolean => !!a.oauth_token;
// Whether this account can drive a run whose CLAUDE_CONFIG_DIR is `configDirPath`.
export const accountUsableWith = (a: Pick<AccountRow, "logged_in" | "oauth_token" | "auth_dir">, configDirPath: string): boolean =>
    a.logged_in === 1 && (hasToken(a) || a.auth_dir === configDirPath);

// A Claude config dir on this host: skills, hooks, agents, commands, CLAUDE.md, MCP servers — the behaviour every agent
// in an environment inherits. The commit/branch/PR rules Stagehand enforces are stored here too, so switching an
// environment's dir switches its rules.
export interface ConfigDirRow {
    id: string;
    name: string;
    path: string;
    chrome_capable: number | null;
    rules: string | null;
    created_at: string;
}

export interface EnvRow {
    id: string;
    name: string;
    path: string;
    base_branch: string;
    default_account_id: string | null;
    config_dir_id: string | null;
    // JSON array of account ids in priority order: the first one that can run in the env's config dir and is not
    // exhausted drives a run; when it hits a rate limit the next one takes over. default_account_id mirrors its head.
    account_order: string | null;
    app_url: string | null;
    qa_script: string | null;
    be_command: string | null;
    fe_command: string | null;
    fe_url_template: string | null;
    be_url_template: string | null;
    be_port: number | null;
    fe_port: number | null;
    setup_command: string | null;
    // JSON array of sub-directories that are separate git repos (e.g. ["backend","frontend"]); null = path itself is the repo.
    repos: string | null;
    // Prepended to research's branch name (e.g. "stepanb/").
    branch_prefix: string | null;
    ticket_source: "clickup" | "linear";
    // KEY=VALUE per line; exported into every process run for this env (git, setup, BE/FE, claude runs, terminal).
    env_vars: string | null;
    // Legacy: rules used to live on the env; they moved to config_dirs.rules (migrated on startup, kept for reference).
    rules: string | null;
    created_at: string;
}

export const accountOrderOf = (env: Pick<EnvRow, "account_order" | "default_account_id">): string[] => {
    try {
        const v: unknown = env.account_order ? JSON.parse(env.account_order) : null;
        if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
    } catch {
        /* fall through */
    }
    return env.default_account_id ? [env.default_account_id] : [];
};

export const parseEnvVars = (text: string | null): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const raw of (text ?? "").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        out[key] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    return out;
};

export interface TaskRow {
    id: string;
    env_id: string;
    ticket_id: string;
    title: string | null;
    source: string;
    ticket_url: string | null;
    model: string | null;
    session_id: string;
    account_id: string | null;
    branch: string | null;
    worktree_path: string | null;
    stage: Stage;
    status: TaskStatus;
    status_line: string | null;
    pinned: number;
    created_at: string;
    updated_at: string;
}

export interface RunRow {
    id: string;
    task_id: string;
    stage: Stage;
    kind: string;
    status: RunStatus;
    account_id: string;
    pid: number | null;
    started_at: string | null;
    finished_at: string | null;
    resume_at: string | null;
    error: string | null;
    result_json: string | null;
    cost_usd: number | null;
    num_turns: number | null;
    last_event: string | null;
    attempt: number;
}

// One row per model used by one claude invocation: a stage run, or a helper (ticket fetch, QA login, probe).
export interface UsageRow {
    id: string;
    at: string;
    account_id: string | null;
    env_id: string | null;
    task_id: string | null;
    run_id: string | null;
    kind: string;
    stage: string | null;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
    duration_ms: number | null;
    turns: number | null;
}

export interface RateLimitRow {
    account_id: string;
    window: string;
    utilization: number;
    resets_at: number;
    updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    auth_dir TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'anthropic',
    oauth_token TEXT,
    email TEXT,
    org TEXT,
    plan TEXT,
    logged_in INTEGER NOT NULL DEFAULT 0,
    chrome_capable INTEGER,
    failover_enabled INTEGER NOT NULL DEFAULT 0,
    failover_threshold REAL NOT NULL DEFAULT 0.6,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_dirs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    chrome_capable INTEGER,
    rules TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS envs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    base_branch TEXT NOT NULL DEFAULT 'main',
    default_account_id TEXT REFERENCES accounts(id),
    config_dir_id TEXT REFERENCES config_dirs(id),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES envs(id),
    ticket_id TEXT NOT NULL,
    title TEXT,
    source TEXT NOT NULL DEFAULT 'clickup',
    session_id TEXT NOT NULL UNIQUE,
    account_id TEXT REFERENCES accounts(id),
    branch TEXT,
    worktree_path TEXT,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    status_line TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(env_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    stage TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    pid INTEGER,
    started_at TEXT,
    finished_at TEXT,
    resume_at TEXT,
    error TEXT,
    result_json TEXT,
    cost_usd REAL,
    num_turns INTEGER,
    last_event TEXT,
    attempt INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, started_at);
CREATE TABLE IF NOT EXISTS rate_limits (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    window TEXT NOT NULL,
    utilization REAL NOT NULL,
    resets_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, window)
);
CREATE TABLE IF NOT EXISTS pr_state (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    number INTEGER,
    url TEXT,
    checks_json TEXT,
    review_decision TEXT,
    merged_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL,
    port INTEGER NOT NULL,
    url TEXT NOT NULL,
    tmux TEXT NOT NULL,
    command TEXT NOT NULL,
    log_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    stopped_at TEXT
);
CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    account_id TEXT,
    env_id TEXT,
    task_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    stage TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    turns INTEGER
);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id);
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    stage TEXT NOT NULL,
    verdict TEXT NOT NULL,
    route_to TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);
`;

export type DB = Database.Database;

const MIGRATIONS: Array<[string, string]> = [
    ["envs.app_url", `ALTER TABLE envs ADD COLUMN app_url TEXT`],
    ["envs.qa_script", `ALTER TABLE envs ADD COLUMN qa_script TEXT`],
    ["envs.be_command", `ALTER TABLE envs ADD COLUMN be_command TEXT`],
    ["envs.fe_command", `ALTER TABLE envs ADD COLUMN fe_command TEXT`],
    ["envs.fe_url_template", `ALTER TABLE envs ADD COLUMN fe_url_template TEXT`],
    ["envs.be_url_template", `ALTER TABLE envs ADD COLUMN be_url_template TEXT`],
    ["envs.be_port", `ALTER TABLE envs ADD COLUMN be_port INTEGER`],
    ["envs.fe_port", `ALTER TABLE envs ADD COLUMN fe_port INTEGER`],
    ["envs.setup_command", `ALTER TABLE envs ADD COLUMN setup_command TEXT`],
    ["envs.repos", `ALTER TABLE envs ADD COLUMN repos TEXT`],
    ["envs.branch_prefix", `ALTER TABLE envs ADD COLUMN branch_prefix TEXT`],
    ["envs.ticket_source", `ALTER TABLE envs ADD COLUMN ticket_source TEXT NOT NULL DEFAULT 'clickup'`],
    ["envs.env_vars", `ALTER TABLE envs ADD COLUMN env_vars TEXT`],
    ["reviews.comments", `ALTER TABLE reviews ADD COLUMN comments TEXT`],
    ["accounts.default_model", `ALTER TABLE accounts ADD COLUMN default_model TEXT`],
    ["envs.rules", `ALTER TABLE envs ADD COLUMN rules TEXT`],
    ["tasks.ticket_url", `ALTER TABLE tasks ADD COLUMN ticket_url TEXT`],
    ["tasks.model", `ALTER TABLE tasks ADD COLUMN model TEXT`],
    ["accounts.provider", `ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'`],
    ["accounts.oauth_token", `ALTER TABLE accounts ADD COLUMN oauth_token TEXT`],
    ["envs.config_dir_id", `ALTER TABLE envs ADD COLUMN config_dir_id TEXT REFERENCES config_dirs(id)`],
    ["envs.account_order", `ALTER TABLE envs ADD COLUMN account_order TEXT`],
];

const hasColumn = (db: Database.Database, table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);

// Accounts used to BE config dirs (accounts.config_dir). Now an account is a login and a config dir is its own thing;
// the old column becomes auth_dir (where that legacy browser login lives) and each distinct real dir becomes a config_dirs
// row. Environments point at the dir their default account used (or `<env>/.claude` when that was registered), and the
// rules that lived on the env move to that dir.
export const migrateAccountsToConfigDirs = (db: Database.Database, opts: { mainConfigDir: string; scratchAccountsDir: string }): void => {
    if (hasColumn(db, "accounts", "config_dir")) db.exec(`ALTER TABLE accounts RENAME COLUMN config_dir TO auth_dir`);
    db.exec(`UPDATE envs SET account_order = json_array(default_account_id) WHERE account_order IS NULL AND default_account_id IS NOT NULL`);
    const dirs = db.prepare(`SELECT COUNT(*) AS n FROM config_dirs`).get() as { n: number };
    const envs = db.prepare(`SELECT * FROM envs`).all() as EnvRow[];
    if (dirs.n > 0 || envs.every((e) => e.config_dir_id)) return;
    const accounts = db.prepare(`SELECT * FROM accounts ORDER BY created_at`).all() as AccountRow[];
    const insert = db.prepare(`INSERT OR IGNORE INTO config_dirs (id, name, path, chrome_capable, rules, created_at) VALUES (?, ?, ?, ?, NULL, ?)`);
    const byPath = (p: string): ConfigDirRow | undefined => db.prepare(`SELECT * FROM config_dirs WHERE path = ?`).get(p) as ConfigDirRow | undefined;
    const real = (p: string): boolean => !p.startsWith(`${opts.scratchAccountsDir}/`);
    for (const a of accounts) if (real(a.auth_dir) && !byPath(a.auth_dir)) insert.run(randomUUID(), a.name, a.auth_dir, a.chrome_capable, now());
    if (!byPath(opts.mainConfigDir)) insert.run(randomUUID(), "main", opts.mainConfigDir, null, now());
    for (const env of envs) {
        if (env.config_dir_id) continue;
        const defaultAcc = env.default_account_id ? accounts.find((a) => a.id === env.default_account_id) : undefined;
        const dir = byPath(join(env.path, ".claude")) ?? (defaultAcc && real(defaultAcc.auth_dir) ? byPath(defaultAcc.auth_dir) : undefined) ?? byPath(opts.mainConfigDir)!;
        db.prepare(`UPDATE envs SET config_dir_id = ? WHERE id = ?`).run(dir.id, env.id);
        if (env.rules && !dir.rules) db.prepare(`UPDATE config_dirs SET rules = ? WHERE id = ?`).run(env.rules, dir.id);
    }
};

export type ServiceKind = "be" | "fe";
export interface ServiceRow {
    id: string;
    task_id: string;
    kind: ServiceKind;
    port: number;
    url: string;
    tmux: string;
    command: string;
    log_path: string;
    started_at: string;
    stopped_at: string | null;
}

export const openDb = (dataDir: string): DB => {
    const db = new Database(join(dataDir, "stagehand.sqlite"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    for (const [key, sql] of MIGRATIONS) {
        const [table, column] = key.split(".") as [string, string];
        if (!hasColumn(db, table, column)) db.exec(sql);
    }
    return db;
};

export const now = (): string => new Date().toISOString();
