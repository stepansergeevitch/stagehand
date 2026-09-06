import Database from "better-sqlite3";
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

export interface AccountRow {
    id: string;
    name: string;
    config_dir: string;
    email: string | null;
    org: string | null;
    plan: string | null;
    logged_in: number;
    chrome_capable: number | null;
    failover_enabled: number;
    failover_threshold: number;
    created_at: string;
}

export interface EnvRow {
    id: string;
    name: string;
    path: string;
    base_branch: string;
    default_account_id: string | null;
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
    created_at: string;
}

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
    config_dir TEXT NOT NULL UNIQUE,
    email TEXT,
    org TEXT,
    plan TEXT,
    logged_in INTEGER NOT NULL DEFAULT 0,
    chrome_capable INTEGER,
    failover_enabled INTEGER NOT NULL DEFAULT 0,
    failover_threshold REAL NOT NULL DEFAULT 0.6,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS envs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    base_branch TEXT NOT NULL DEFAULT 'main',
    default_account_id TEXT REFERENCES accounts(id),
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
    ["tasks.ticket_url", `ALTER TABLE tasks ADD COLUMN ticket_url TEXT`],
    ["tasks.model", `ALTER TABLE tasks ADD COLUMN model TEXT`],
];

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
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === column)) db.exec(sql);
    }
    return db;
};

export const now = (): string => new Date().toISOString();
