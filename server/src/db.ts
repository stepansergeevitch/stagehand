import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type Stage =
    | "research"
    | "design_proposal"
    | "qa_baseline"
    | "implementation"
    | "code_review"
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
    "code_review",
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
    // 1: every browser QA run copies the profile above into a private Chrome (chrome-clones.ts) instead of sharing it.
    chrome_clone_qa: number;
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
    // Prepended to research's branch name (e.g. "yourname/").
    branch_prefix: string | null;
    ticket_source: "clickup" | "linear";
    // KEY=VALUE per line; exported into every process run for this env (git, setup, BE/FE, claude runs, terminal).
    env_vars: string | null;
    // Legacy: rules used to live on the env; they moved to config_dirs.rules (migrated on startup, kept for reference).
    rules: string | null;
    // Runs from the worktree before it is removed by "Clean up" (drop a per-task database, free caches, …); {{worktree}} / {{envPath}} placeholders.
    cleanup_command: string | null;
    // Runs from the worktree after every successful rebase (plain or agent-resolved): rebuild what the rebase made stale.
    rebase_command: string | null;
    // Runs from the worktree after every implementation / PR-fix run; non-zero = the run goes back to the agent with the
    // output (e.g. Django `check --database default` + `makemigrations --check`, which tests and a dev server never run).
    check_command: string | null;
    // JSON array of EnvComponent: optional per-task services next to the BE/FE (a queue worker, a scheduler), started
    // on demand by the human or the agents, or automatically (autoStart / a QA scenario's `services`).
    components: string | null;
    // 1 = a task's BE/FE stay up between QA baseline → implementation → Manual QA → User Review instead of being stopped
    // after every QA pass (a Next dev server compiles for minutes on every cold start); stopped when the task is done or cleaned up.
    keep_services: number;
    // Which browser the QA runner drives: "chrome" = the account's Chrome profile via claude-in-chrome; "gstack" = gstack's headless Chromium daemon (cookies imported from that profile).
    qa_browser: string;
    // JSON ReviewChecklist (review-checklist.ts): built-in gstack categories switched off, points added, extra
    // do-not-flag rules for the Code Review stage. Null = gstack's full checklist.
    review_checklist: string | null;
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

// Optional components of an env (envs.components, JSON): extra per-task services beside the BE/FE — a queue worker, a
// scheduler, a relay — each its own tmux session from the worktree, without a port. Started on demand (App widget,
// POST /api/tasks/:id/services/<key>/start, the agents' prompts) or automatically (autoStart, or a QA scenario's `services`).
export interface EnvComponent {
    key: string;
    label: string;
    command: string;
    autoStart: boolean;
}
export const COMPONENT_KEY = /^[a-z][a-z0-9_-]{0,30}$/;
export const componentsOf = (env: Pick<EnvRow, "components">): EnvComponent[] => {
    try {
        const v: unknown = env.components ? JSON.parse(env.components) : [];
        if (!Array.isArray(v)) return [];
        return v
            .filter((c): c is EnvComponent => !!c && typeof c === "object" && typeof (c as EnvComponent).key === "string" && typeof (c as EnvComponent).command === "string")
            .filter((c) => COMPONENT_KEY.test(c.key) && c.key !== "be" && c.key !== "fe")
            .map((c) => ({ key: c.key, label: typeof c.label === "string" && c.label.trim() ? c.label.trim() : c.key, command: c.command, autoStart: c.autoStart === true }));
    } catch {
        return [];
    }
};

// tasks.base_branch: NULL (the env's base branch in every repository), one branch name (every repository starts from
// and targets it — a task stacked on another task's branch), or a JSON object {"<repo dir>": "<branch>"} for a
// multi-repo env whose repositories start from different branches (stacked on a parent that touched only one repo).
export type BaseBranches = Record<string, string>;

export const parseBaseBranch = (raw: string | null | undefined): string | BaseBranches | null => {
    const t = raw?.trim();
    if (!t) return null;
    if (!t.startsWith("{")) return t;
    try {
        const o = JSON.parse(t) as unknown;
        if (!o || typeof o !== "object" || Array.isArray(o)) return null;
        const out: BaseBranches = {};
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) if (typeof v === "string" && v.trim()) out[k] = v.trim();
        return Object.keys(out).length ? out : null;
    } catch {
        return null;
    }
};

// The base of one repository ("" = the single repository) given the stored value and the env default.
export const baseBranchFor = (raw: string | null | undefined, repo: string, envBase: string): string => {
    const b = parseBaseBranch(raw);
    if (!b) return envBase;
    if (typeof b === "string") return b;
    return b[repo]?.trim() || envBase;
};

// What to store for a human-given base (a string for every repo, or a per-repo map): entries equal to the env default
// are dropped, one shared value collapses to a plain string, nothing left = NULL.
// A branch name as typed or pasted by a human: the UI's "⎇ " prefix, "origin/" and surrounding whitespace are not part of it
// (INV-134, 2026-09-21: a base pasted from the task header as "⎇ stepanb/…" failed worktree creation).
export const cleanBranchName = (s: string): string => s.trim().replace(/^⎇\s*/, "").replace(/^origin\//, "").trim();

export const normalizeBaseBranch = (given: string | BaseBranches | null | undefined, repos: string[], envBase: string): string | null => {
    if (given == null) return null;
    if (typeof given === "string") {
        const t = cleanBranchName(given);
        return t && t !== envBase ? t : null;
    }
    const keys = repos.length ? repos : [""];
    const map: BaseBranches = {};
    for (const k of keys) {
        const v = cleanBranchName(given[k] ?? "");
        if (v && v !== envBase) map[k] = v;
    }
    const values = [...new Set(Object.values(map))];
    if (values.length === 0) return null;
    if (values.length === 1 && Object.keys(map).length === keys.length) return values[0]!;
    return JSON.stringify(map);
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
    // The branch this task's work is based on and its PR targets; null = the env's base_branch. Another task's branch
    // for a stacked PR; the PR poller rewrites it when GitHub retargets the PR after that base is merged.
    base_branch: string | null;
    // One-shot: the human asked (from User Review's "Request changes" or "Return to a stage…") to skip the browser QA
    // stages on the way back to User Review this pass; advance() consumes it there.
    skip_qa: number;
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
    // The commit Stagehand itself last pushed to origin for this repository (null before any push, or when the push
    // came from elsewhere). When origin still sits on it, every remote commit is Stagehand's own and a rewritten local
    // history may replace them with a force-push under lease.
    pushed_sha: string | null;
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
    model: string | null;
    shard: string | null;
    group_id: string | null;
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
    // JSON MessageAnchor when the message belongs to a diff-line thread; NULL for plain chat.
    anchor: string | null;
    // JSON SharedFile[] — files the human attached to this message (paths under the task dir's shared/); NULL when none.
    files: string | null;
    // NULL for chat; "instruction" = the human told the agent to do something (Chat → Do), "instruction_result" = its report.
    kind: MessageKind | null;
}

export type MessageKind = "instruction" | "instruction_result";

// A file the human handed to the agent from the app (Chat, Do, an answer): saved under <taskDir>/shared/ and named to
// the agent by that path. `file` is relative to the task dir, like a ticket attachment's.
export interface SharedFile {
    name: string;
    file: string;
    mime: string | null;
    size: number;
}

// A diff line a chat message is attached to: the file, which side of the diff, the line number there and the line's
// text (lines move as the branch evolves; the text is what the UI matches on to place the thread later).
export interface MessageAnchor {
    path: string;
    side: "new" | "old";
    line: number;
    snippet: string;
    // Set when the thread hangs under a GitHub PR comment instead of a diff line (the PR comments tab): the comment's
    // repository directory, PR number, GitHub comment id, author and link. `path`/`line` then hold the comment's own
    // position when it has one ("" / 0 for a review verdict or a general comment) and `snippet` the comment text.
    prComment?: { repo: string; number: number; id: number; author: string; url: string } | undefined;
}

// A free-form interactive `claude` session the human opens from the Sessions page: an env (its config dir, env vars,
// checkout — optionally its own worktree), an AI account, an optional model. Lives in a tmux session so it survives the
// browser tab; claude's own session id is fixed up-front so the conversation can be resumed after the pane is closed.
export interface SessionRow {
    id: string;
    name: string;
    env_id: string;
    account_id: string | null;
    model: string | null;
    cwd: string;
    worktree_path: string | null;
    branch: string | null;
    claude_session_id: string;
    tmux: string;
    created_at: string;
    // NULL until claude has been launched once (the first launch uses --session-id, every later one --resume).
    opened_at: string | null;
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
-- runs and usage are history: their account_id is a plain id, not a foreign key, so an AI account can be deleted
-- and its past runs and costs stay (the usage report labels them "deleted account").
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    stage TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    account_id TEXT NOT NULL,
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
    pushed_sha TEXT,
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
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    env_id TEXT NOT NULL REFERENCES envs(id),
    account_id TEXT REFERENCES accounts(id),
    model TEXT,
    cwd TEXT NOT NULL,
    worktree_path TEXT,
    branch TEXT,
    claude_session_id TEXT NOT NULL,
    tmux TEXT NOT NULL,
    created_at TEXT NOT NULL,
    opened_at TEXT
);
CREATE TABLE IF NOT EXISTS prompter_sessions (
    id TEXT PRIMARY KEY,
    claude_session_id TEXT NOT NULL,
    model TEXT,
    account_id TEXT,
    created_at TEXT NOT NULL,
    last_at TEXT NOT NULL,
    pinged_at TEXT NOT NULL,
    closed_at TEXT,
    turns INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prompter_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES prompter_sessions(id),
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    path TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prompter_messages_session ON prompter_messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS resource_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    task_id TEXT,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    rss_mb INTEGER
);
CREATE TABLE IF NOT EXISTS resource_pins (
    resource_id TEXT PRIMARY KEY,
    pinned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    ticket_id TEXT,
    at TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, at);
`;

// One row per change of a task's (stage, status) — the timing analytics read how long a task sat where (working,
// waiting for the human, waiting for GitHub, rate-limited). No foreign key: rows outlive the task, with its ticket id.
export interface TaskEventRow {
    id: string;
    task_id: string;
    ticket_id: string | null;
    at: string;
    stage: string;
    status: string;
}

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
    // The --model the run was started with (null = the account's default); stage/rerun/operation models (config).
    ["runs.model", `ALTER TABLE runs ADD COLUMN model TEXT`],
    // A QA pass split into parallel shards: which scenarios this run drove, and the pass dispatch it belongs to.
    ["runs.shard", `ALTER TABLE runs ADD COLUMN shard TEXT`],
    ["runs.group_id", `ALTER TABLE runs ADD COLUMN group_id TEXT`],
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
    ["accounts.chrome_clone_qa", `ALTER TABLE accounts ADD COLUMN chrome_clone_qa INTEGER NOT NULL DEFAULT 0`],
    ["envs.chrome_browser_name", `ALTER TABLE envs ADD COLUMN chrome_browser_name TEXT`],
    ["config_dirs.login_email", `ALTER TABLE config_dirs ADD COLUMN login_email TEXT`],
    ["config_dirs.login_ok", `ALTER TABLE config_dirs ADD COLUMN login_ok INTEGER`],
    ["config_dirs.chrome_browsers", `ALTER TABLE config_dirs ADD COLUMN chrome_browsers TEXT`],
    ["tasks.notes", `ALTER TABLE tasks ADD COLUMN notes TEXT`],
    ["tasks.extra_tickets", `ALTER TABLE tasks ADD COLUMN extra_tickets TEXT`],
    ["envs.cleanup_command", `ALTER TABLE envs ADD COLUMN cleanup_command TEXT`],
    ["envs.check_command", `ALTER TABLE envs ADD COLUMN check_command TEXT`],
    ["envs.components", `ALTER TABLE envs ADD COLUMN components TEXT`],
    ["envs.keep_services", `ALTER TABLE envs ADD COLUMN keep_services INTEGER NOT NULL DEFAULT 0`],
    ["envs.qa_browser", `ALTER TABLE envs ADD COLUMN qa_browser TEXT NOT NULL DEFAULT 'chrome'`],
    ["envs.review_checklist", `ALTER TABLE envs ADD COLUMN review_checklist TEXT`],
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
    // The commit Stagehand last pushed for the repository: origin still on it means nobody else pushed since.
    ["pr_state.pushed_sha", `ALTER TABLE pr_state ADD COLUMN pushed_sha TEXT`],
    ["envs.pr_templates", `ALTER TABLE envs ADD COLUMN pr_templates TEXT`],
    ["envs.pr_draft", `ALTER TABLE envs ADD COLUMN pr_draft INTEGER NOT NULL DEFAULT 0`],
    ["envs.depends_on_env_id", `ALTER TABLE envs ADD COLUMN depends_on_env_id TEXT REFERENCES envs(id)`],
    ["envs.rebase_command", `ALTER TABLE envs ADD COLUMN rebase_command TEXT`],
    // Prompter: a message sent while a turn ran is "queued" until the next turn takes it (editable until then).
    ["prompter_messages.state", `ALTER TABLE prompter_messages ADD COLUMN state TEXT NOT NULL DEFAULT 'sent'`],
    // Prompter: the chat's name in the session strip — the first message, trimmed.
    ["prompter_sessions.title", `ALTER TABLE prompter_sessions ADD COLUMN title TEXT`],
    // Free-form labels the human puts on a task: JSON [{text, color}] (color = CSS hex), shown in the list and the header.
    ["tasks.labels", `ALTER TABLE tasks ADD COLUMN labels TEXT`],
    // Per-task base branch (stacked PRs); null = the env's base_branch.
    ["tasks.base_branch", `ALTER TABLE tasks ADD COLUMN base_branch TEXT`],
    // One-shot "skip Manual QA (and QA baseline) this pass", set from Request changes / Return to a stage.
    ["tasks.skip_qa", `ALTER TABLE tasks ADD COLUMN skip_qa INTEGER NOT NULL DEFAULT 0`],
    // A BE/FE that never came up (start timeout, command exited, tmux session gone) — the row stays visible as failed
    // until it is stopped or restarted, so the human sees why and can hand it to the agent.
    ["services.failed_at", `ALTER TABLE services ADD COLUMN failed_at TEXT`],
    ["services.error", `ALTER TABLE services ADD COLUMN error TEXT`],
    // Rows Stagehand started on its own after the previous start's tmux session vanished (host/tmux restart, killed by
    // hand) — counted per task+kind to cap the automatic restarts.
    ["services.auto_restart", `ALTER TABLE services ADD COLUMN auto_restart INTEGER NOT NULL DEFAULT 0`],
    // A chat message tied to one diff line (path/side/line/snippet as JSON) — a question asked from Code changes.
    ["messages.anchor", `ALTER TABLE messages ADD COLUMN anchor TEXT`],
    // "instruction" / "instruction_result": a Chat message that told the agent to do something, and its report.
    ["messages.kind", `ALTER TABLE messages ADD COLUMN kind TEXT`],
    // Files the human attached to a Chat message / instruction / answer (JSON SharedFile[]), stored under the task dir's shared/.
    ["messages.files", `ALTER TABLE messages ADD COLUMN files TEXT`],
];

const hasColumn = (db: Database.Database, table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);

// True while the table still declares a foreign key to accounts (see the runs/usage rebuild in openDb).
const referencesAccounts = (db: Database.Database, table: string): boolean =>
    (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).some((f) => f.table === "accounts");

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

export type CoreServiceKind = "be" | "fe";
// "be" | "fe", or the key of one of the env's optional components (envs.components).
export type ServiceKind = string;
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
    failed_at: string | null;
    error: string | null;
    // 1 when Stagehand started this row itself after the previous one's tmux session vanished (see Services.probe).
    auto_restart: number;
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
            pushed_sha TEXT,
            approved_at TEXT,
            state TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (task_id, repo)
        )`);
        db.exec(`INSERT INTO pr_state (task_id, repo, number, url, checks_json, review_decision, merged_at, pushed_at, approved_at, updated_at)
                 SELECT task_id, '', number, url, checks_json, review_decision, merged_at, pushed_at, updated_at, updated_at FROM pr_state_old`);
        db.exec(`DROP TABLE pr_state_old`);
    }
    // runs.account_id and usage.account_id used to be foreign keys to accounts, which made deleting an AI account fail
    // with "FOREIGN KEY constraint failed" as soon as it had run anything. SQLite cannot drop a constraint in place:
    // rebuild each table once without it, carrying every row over (the tables have no children, so the drop is safe).
    // Foreign keys are off for the rebuild, as SQLite's table-rebuild procedure asks: the copy must not fail on a row
    // whose task is already gone, and the pragma only takes effect outside a transaction (openDb runs in none).
    const rebuild = referencesAccounts(db, "runs") || referencesAccounts(db, "usage");
    if (rebuild) db.pragma("foreign_keys = OFF");
    if (referencesAccounts(db, "runs")) {
        db.exec(`ALTER TABLE runs RENAME TO runs_old`);
        db.exec(`CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id),
            stage TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            account_id TEXT NOT NULL,
            pid INTEGER,
            started_at TEXT,
            finished_at TEXT,
            resume_at TEXT,
            error TEXT,
            result_json TEXT,
            cost_usd REAL,
            num_turns INTEGER,
            last_event TEXT,
            attempt INTEGER NOT NULL DEFAULT 1,
            model TEXT,
            shard TEXT,
            group_id TEXT
        )`);
        db.exec(`INSERT INTO runs (id, task_id, stage, kind, status, account_id, pid, started_at, finished_at, resume_at, error, result_json, cost_usd, num_turns, last_event, attempt, model, shard, group_id)
                 SELECT id, task_id, stage, kind, status, account_id, pid, started_at, finished_at, resume_at, error, result_json, cost_usd, num_turns, last_event, attempt, model, shard, group_id FROM runs_old`);
        db.exec(`DROP TABLE runs_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, started_at)`);
    }
    if (referencesAccounts(db, "usage")) {
        db.exec(`ALTER TABLE usage RENAME TO usage_old`);
        db.exec(`CREATE TABLE usage (
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
            turns INTEGER,
            ticket_id TEXT,
            task_title TEXT
        )`);
        db.exec(`INSERT INTO usage (id, at, account_id, env_id, task_id, run_id, kind, stage, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, turns, ticket_id, task_title)
                 SELECT id, at, account_id, env_id, task_id, run_id, kind, stage, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, turns, ticket_id, task_title FROM usage_old`);
        db.exec(`DROP TABLE usage_old`);
        db.exec(`CREATE INDEX IF NOT EXISTS usage_at ON usage(at)`);
        db.exec(`CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id)`);
    }
    if (rebuild) db.pragma("foreign_keys = ON");
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
