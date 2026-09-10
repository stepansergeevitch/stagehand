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
    | "pr_fix"
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
    "pr_fix",
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
    // Browser stages need a claude.ai browser login (the Chrome extension is bound to that account, and tokens get no
    // bridge). `login_ok` says the account's browser dir holds one; `chrome_capable` that the bridge answered under it;
    // `chrome_browsers` lists the Chrome profiles (extension instances) seen, `chrome_device_id` the one to use.
    login_ok: number | null;
    // Which dir holds that browser login: the account's auth dir (a real config dir, e.g. the main one) or the
    // Stagehand-owned browser dir that can mirror any env's config dir.
    login_dir: string | null;
    chrome_capable: number | null;
    chrome_browsers: string | null;
    chrome_device_id: string | null;
    chrome_browser_name: string | null;
    failover_enabled: number;
    failover_threshold: number;
    // What `claude` picks when no --model is passed for this account (observed from run init events / a probe).
    default_model: string | null;
    created_at: string;
}
export const accountBrowserReady = (a: Pick<AccountRow, "login_ok" | "chrome_capable">): boolean => a.login_ok === 1 && a.chrome_capable === 1;

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
    // The claude.ai browser login stored in this dir (`claude auth login`). The Chrome extension only works with it —
    // token-authenticated sessions keep Chrome off — so browser stages run with this login, not an account token.
    login_email: string | null;
    login_ok: number | null;
    // JSON [{deviceId, name}] — Chrome profiles with the extension, as seen by the last probe.
    chrome_browsers: string | null;
    created_at: string;
}

export interface ChromeBrowser {
    deviceId: string;
    // The extension's own label ("Browser 1"); `profile` is the Chrome profile name when the store could be matched.
    name: string;
    profile?: string;
    account?: string | null;
    // Enough to open a URL in that profile without an agent (`open -na <app> --args --profile-directory=<dir>`).
    profileDir?: string;
    browser?: string;
}
export const chromeBrowserLabel = (b: ChromeBrowser): string => b.profile ?? b.name;
export const chromeBrowsersOf = (d: Pick<ConfigDirRow, "chrome_browsers">): ChromeBrowser[] => {
    try {
        const v: unknown = d.chrome_browsers ? JSON.parse(d.chrome_browsers) : [];
        return Array.isArray(v) ? v.filter((b): b is ChromeBrowser => !!b && typeof b === "object" && typeof (b as ChromeBrowser).deviceId === "string") : [];
    } catch {
        return [];
    }
};

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
    // Chrome profile (connected extension instance) browser stages select before touching a page; null = whatever is paired.
    chrome_device_id: string | null;
    chrome_browser_name: string | null;
    app_url: string | null;
    qa_script: string | null;
    // Free text for agents: how to create test data in this env (local DB connection, API auth, seed scripts, tables).
    qa_seed_hints: string | null;
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
    // Runs from the worktree before it is removed by "Clean up" (drop a per-task database, free caches, …); {{worktree}} / {{envPath}} placeholders.
    cleanup_command: string | null;
    // JSON {"<repo dir or .>": "<template path relative to that repo>"} — per-repository PR template overrides; a repo not listed is auto-detected.
    pr_templates: string | null;
    // Open every PR this env creates as a GitHub draft (0/1). The human marks it ready for review themselves.
    pr_draft: number;
    // Another env whose BE this env's app needs reachable to work at all (e.g. Deal calling out to Core for auth).
    // Started once, shared, and reused across every task of this env — not per task (the dependency isn't itself
    // under test, and starting a heavy service N times over is wasteful).
    depends_on_env_id: string | null;
    created_at: string;
}

// One shared dependency service per env: started the first time any task of a *dependent* env needs it, reused by
// every task after that until its process actually dies. Keyed by the env that OWNS the service (e.g. Core), not by
// the env(s) that depend on it, since one dependency can be shared by several dependents.
export interface EnvServiceRow {
    env_id: string;
    port: number;
    url: string;
    tmux: string;
    command: string;
    log_path: string;
    started_at: string;
}

export const prTemplateOverridesOf = (env: Pick<EnvRow, "pr_templates">): Record<string, string> => {
    try {
        const v: unknown = env.pr_templates ? JSON.parse(env.pr_templates) : {};
        if (!v || typeof v !== "object" || Array.isArray(v)) return {};
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));
    } catch {
        return {};
    }
};

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
    // Free text from the human at creation (or later): constraints, hints, what to focus on — injected into every stage prompt.
    notes: string | null;
    // JSON array of {source,id,url} for the other tickets a batch task covers (ticket_id is the first one).
    extra_tickets: string | null;
    // JSON array of {text, color} — the human's own tags on the task.
    labels: string | null;
    created_at: string;
    updated_at: string;
}

export interface TaskLabel {
    text: string;
    color: string;
}

// One pull request of a task: one row per repository (repo = sub-repo directory, '' for a single-repo env). `approved_at`
// is the human's per-repo approval at PR Creation Review; `number`/`url` exist once the PR is open on GitHub.
export interface PrStateRow {
    task_id: string;
    repo: string;
    number: number | null;
    url: string | null;
    checks_json: string | null;
    review_decision: string | null;
    merged_at: string | null;
    pushed_at: string | null;
    approved_at: string | null;
    // GitHub's OPEN / CLOSED / MERGED as of the last poll.
    state: string | null;
    updated_at: string;
}

export const extraTicketsOf = (t: Pick<TaskRow, "extra_tickets">): Array<{ source: "clickup" | "linear"; id: string; url: string | null }> => {
    try {
        const v: unknown = t.extra_tickets ? JSON.parse(t.extra_tickets) : [];
        return Array.isArray(v) ? v.filter((x): x is { source: "clickup" | "linear"; id: string; url: string | null } => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") : [];
    } catch {
        return [];
    }
};

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
    ticket_id: string | null;
    task_title: string | null;
}

export interface MessageRow {
    id: string;
    task_id: string;
    role: "user" | "agent";
    text: string;
    created_at: string;
}

export interface RateLimitRow {
    account_id: string;
    window: string;
    utilization: number;
    resets_at: number;
    updated_at: string;
}

// How many dollars (claude's list-price estimate) one full rate-limit window of a subscription account holds, learned from
// runs: a run that moved the window's utilization by Δu while costing $c says the window is worth c/Δu. Rolling average.
export interface WindowCalibrationRow {
    account_id: string;
    window: string;
    usd_per_window: number;
    samples: number;
    // Accumulator: utilisation and reset instant when the current measurement started, and the cost spent since.
    // A sample is taken once the window moved enough (the 7-day window moves ~1% per run, so single runs are too noisy).
    anchor_u: number | null;
    anchor_resets: number | null;
    anchor_cost: number;
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
    login_email TEXT,
    login_ok INTEGER,
    chrome_browsers TEXT,
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
    task_id TEXT NOT NULL REFERENCES tasks(id),
    repo TEXT NOT NULL DEFAULT '',
    number INTEGER,
    url TEXT,
    checks_json TEXT,
    review_decision TEXT,
    merged_at TEXT,
    pushed_at TEXT,
    approved_at TEXT,
    state TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, repo)
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
CREATE TABLE IF NOT EXISTS window_calibration (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    window TEXT NOT NULL,
    usd_per_window REAL NOT NULL,
    samples INTEGER NOT NULL DEFAULT 1,
    anchor_u REAL,
    anchor_resets INTEGER,
    anchor_cost REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, window)
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, created_at);
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    stage TEXT NOT NULL,
    verdict TEXT NOT NULL,
    route_to TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    run_id TEXT,
    stage TEXT NOT NULL,
    questions TEXT NOT NULL,
    answers TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_task ON questions(task_id, created_at);
CREATE TABLE IF NOT EXISTS env_services (
    env_id TEXT PRIMARY KEY REFERENCES envs(id),
    port INTEGER NOT NULL,
    url TEXT NOT NULL,
    tmux TEXT NOT NULL,
    command TEXT NOT NULL,
    log_path TEXT NOT NULL,
    started_at TEXT NOT NULL
);
`;

// A round of questions the agent asked the human mid-stage (see prompts: questions.json → NEED_INPUT). `questions`
// and `answers` are JSON; an unanswered round has answers = NULL and keeps the task in waiting_user.
export interface QuestionRow {
    id: string;
    task_id: string;
    run_id: string | null;
    stage: Stage;
    questions: string;
    answers: string | null;
    created_at: string;
    answered_at: string | null;
}

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
    ["envs.chrome_device_id", `ALTER TABLE envs ADD COLUMN chrome_device_id TEXT`],
    ["envs.qa_seed_hints", `ALTER TABLE envs ADD COLUMN qa_seed_hints TEXT`],
    ["accounts.login_ok", `ALTER TABLE accounts ADD COLUMN login_ok INTEGER`],
    ["accounts.login_dir", `ALTER TABLE accounts ADD COLUMN login_dir TEXT`],
    ["accounts.chrome_browsers", `ALTER TABLE accounts ADD COLUMN chrome_browsers TEXT`],
    ["accounts.chrome_device_id", `ALTER TABLE accounts ADD COLUMN chrome_device_id TEXT`],
    ["accounts.chrome_browser_name", `ALTER TABLE accounts ADD COLUMN chrome_browser_name TEXT`],
    ["envs.chrome_browser_name", `ALTER TABLE envs ADD COLUMN chrome_browser_name TEXT`],
    ["config_dirs.login_email", `ALTER TABLE config_dirs ADD COLUMN login_email TEXT`],
    ["config_dirs.login_ok", `ALTER TABLE config_dirs ADD COLUMN login_ok INTEGER`],
    ["config_dirs.chrome_browsers", `ALTER TABLE config_dirs ADD COLUMN chrome_browsers TEXT`],
    ["tasks.notes", `ALTER TABLE tasks ADD COLUMN notes TEXT`],
    ["tasks.extra_tickets", `ALTER TABLE tasks ADD COLUMN extra_tickets TEXT`],
    ["envs.cleanup_command", `ALTER TABLE envs ADD COLUMN cleanup_command TEXT`],
    ["window_calibration.anchor_u", `ALTER TABLE window_calibration ADD COLUMN anchor_u REAL`],
    ["window_calibration.anchor_resets", `ALTER TABLE window_calibration ADD COLUMN anchor_resets INTEGER`],
    ["window_calibration.anchor_cost", `ALTER TABLE window_calibration ADD COLUMN anchor_cost REAL NOT NULL DEFAULT 0`],
    // The task's ticket id and title as of the last time the row was touched, so usage of a deleted task keeps its name.
    ["usage.ticket_id", `ALTER TABLE usage ADD COLUMN ticket_id TEXT`],
    ["usage.task_title", `ALTER TABLE usage ADD COLUMN task_title TEXT`],
    // When Stagehand last pushed the branch: right after a push GitHub reports no checks for a moment, which must not read as "green".
    ["pr_state.pushed_at", `ALTER TABLE pr_state ADD COLUMN pushed_at TEXT`],
    // Which repository's draft a PR Creation Review verdict was about (multi-repo envs review one PR per repo).
    ["reviews.repo", `ALTER TABLE reviews ADD COLUMN repo TEXT`],
    ["pr_state.state", `ALTER TABLE pr_state ADD COLUMN state TEXT`],
    ["envs.pr_templates", `ALTER TABLE envs ADD COLUMN pr_templates TEXT`],
    ["envs.pr_draft", `ALTER TABLE envs ADD COLUMN pr_draft INTEGER NOT NULL DEFAULT 0`],
    ["envs.depends_on_env_id", `ALTER TABLE envs ADD COLUMN depends_on_env_id TEXT REFERENCES envs(id)`],
    // Free-form labels the human puts on a task: JSON [{text, color}] (color = CSS hex), shown in the list and the header.
    ["tasks.labels", `ALTER TABLE tasks ADD COLUMN labels TEXT`],
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
    // Browser login / Chrome facts used to live on config_dirs; an account whose auth dir IS that dir owns them.
    db.exec(
        `UPDATE accounts SET login_ok = (SELECT d.login_ok FROM config_dirs d WHERE d.path = accounts.auth_dir),
             chrome_capable = (SELECT d.chrome_capable FROM config_dirs d WHERE d.path = accounts.auth_dir),
             chrome_browsers = (SELECT d.chrome_browsers FROM config_dirs d WHERE d.path = accounts.auth_dir)
         WHERE login_ok IS NULL AND EXISTS (SELECT 1 FROM config_dirs d WHERE d.path = accounts.auth_dir)`,
    );
    db.exec(`UPDATE accounts SET login_dir = auth_dir WHERE login_dir IS NULL AND login_ok = 1`);
    db.exec(
        `UPDATE accounts SET chrome_device_id = (SELECT e.chrome_device_id FROM envs e JOIN config_dirs d ON d.id = e.config_dir_id WHERE d.path = accounts.auth_dir AND e.chrome_device_id IS NOT NULL LIMIT 1),
             chrome_browser_name = (SELECT e.chrome_browser_name FROM envs e JOIN config_dirs d ON d.id = e.config_dir_id WHERE d.path = accounts.auth_dir AND e.chrome_device_id IS NOT NULL LIMIT 1)
         WHERE chrome_device_id IS NULL`,
    );
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
    // pr_state used to be one row per task (PRIMARY KEY task_id). A multi-repo workspace opens one PR per repository, so
    // the key is now (task_id, repo) with repo = '' for a single-repo env. SQLite cannot change a primary key in place:
    // rebuild the table once, carrying every existing row over as repo ''.
    if (!hasColumn(db, "pr_state", "repo")) {
        db.exec(`ALTER TABLE pr_state RENAME TO pr_state_old`);
        db.exec(`CREATE TABLE pr_state (
            task_id TEXT NOT NULL REFERENCES tasks(id),
            repo TEXT NOT NULL DEFAULT '',
            number INTEGER,
            url TEXT,
            checks_json TEXT,
            review_decision TEXT,
            merged_at TEXT,
            pushed_at TEXT,
            approved_at TEXT,
            state TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (task_id, repo)
        )`);
        db.exec(`INSERT INTO pr_state (task_id, repo, number, url, checks_json, review_decision, merged_at, pushed_at, approved_at, updated_at)
                 SELECT task_id, '', number, url, checks_json, review_decision, merged_at, pushed_at, updated_at, updated_at FROM pr_state_old`);
        db.exec(`DROP TABLE pr_state_old`);
    }
    // Stage identifiers are just data, not schema — renaming one (pr_red -> pr_fix, 2026-09-09: the same stage now also
    // triggers from picked PR comments, not just failing CI, so "red" stopped being accurate) means rewriting any
    // existing row that still has the old value, not adding a column. Safe to run every startup: a no-op once done.
    db.exec(`UPDATE tasks SET stage = 'pr_fix' WHERE stage = 'pr_red'`);
    db.exec(`UPDATE runs SET stage = 'pr_fix' WHERE stage = 'pr_red'`);
    // Cosmetic half of the same rename: status_line is a stored string, not recomputed from the stage, so any line
    // already written with the old label sits stale until something else updates it. Fix it once, here, alongside.
    db.exec(`UPDATE tasks SET status_line = REPLACE(status_line, 'PR Red', 'PR Fix') WHERE status_line LIKE 'PR Red%'`);
    // Usage rows written before the label columns existed: copy the name from the task while it still exists.
    db.exec(`UPDATE usage SET ticket_id = (SELECT t.ticket_id FROM tasks t WHERE t.id = usage.task_id), task_title = (SELECT t.title FROM tasks t WHERE t.id = usage.task_id) WHERE task_id IS NOT NULL AND ticket_id IS NULL AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = usage.task_id)`);
    return db;
};

export const now = (): string => new Date().toISOString();
