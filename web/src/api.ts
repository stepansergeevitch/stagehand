export type Stage =
    | "research" | "design_proposal" | "qa_baseline" | "implementation" | "manual_qa" | "user_review"
    | "pr_creation_review" | "pr_waiting" | "pr_fix" | "pr_green" | "pr_approved" | "done";

export type TaskStatus = "idle" | "queued" | "running" | "waiting_user" | "blocked" | "rate_limited" | "failed" | "done" | "stopped";

// An AI provider login. `has_token` = long-lived OAuth token stored (works in any config dir); otherwise a legacy browser
// login that lives in `auth_dir` and only works when that dir is the environment's config dir.
export interface Account {
    id: string; name: string; provider: string; auth_dir: string; has_token: boolean; setting_up: boolean; email: string | null; org: string | null; plan: string | null;
    logged_in: number; failover_enabled: number; failover_threshold: number; default_model: string | null;
    // Browser stages need this account's claude.ai browser login (in browser_dir) and a Chrome profile whose extension is signed into it.
    login_ok: number | null; login_dir: string | null; chrome_capable: number | null; chrome_device_id: string | null; chrome_browser_name: string | null;
    browsers: ChromeBrowser[]; browser_dir: string;
    // `expired`: the window's reset instant has passed and nothing reported since — the utilisation is unknown, not this number.
    limits: Array<{ window: string; utilization: number; resetsAt: number; updatedAt: string; expired: boolean }>;
    refreshing_limits: boolean;
    // Tokens of every kind and estimated cost since local midnight / over the last 7 days (from the usage table).
    usage: { today: { tokens: number; cost: number }; week: { tokens: number; cost: number } };
    // Subscription accounts: how many estimated dollars one full window holds, learned from runs (empty until a run moved a window).
    windows: Array<{ window: string; usdPerWindow: number; samples: number }>;
}
export interface Readiness { envId: string; envName: string; configDir: string; run: string[]; browser: string[]; warnings: string[] }
export const accountBrowserReady = (a: Account): boolean => a.login_ok === 1 && a.chrome_capable === 1;
export const accountUsableWith = (a: Account, configDirPath: string): boolean => a.logged_in === 1 && (a.has_token || a.auth_dir === configDirPath);
// The env's account priority list (ids); falls back to the single default account.
export const accountOrderOf = (env: Pick<Env, "account_order" | "default_account_id">): string[] => {
    try {
        const v: unknown = env.account_order ? JSON.parse(env.account_order) : null;
        if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    } catch { /* fall through */ }
    return env.default_account_id ? [env.default_account_id] : [];
};

export interface ConfigDirContents {
    exists: boolean; skills: string[]; agents: string[]; commands: string[]; hooks: string[]; plugins: number; mcpServers: string[]; hasClaudeMd: boolean; hasSettings: boolean;
}
export interface ChromeBrowser { deviceId: string; name: string; profile?: string; account?: string | null; profileDir?: string; browser?: string }
// The Chrome profile name when Stagehand could match it, else the extension's own label ("Browser 1").
export const chromeBrowserLabel = (b: ChromeBrowser): string => b.profile ?? b.name;
export interface ConfigDir {
    id: string; name: string; path: string; rules: string | null; created_at: string;
    contents: ConfigDirContents; envs: string[]; usable_accounts: string[];
}
export interface ConfigDirRules { rules: Rules; defaults: Rules; guardHook: string }

// "claude-opus-5" → "Opus 5" using the settings model list; unknown ids are shown as-is.
export const modelLabel = (id: string | null | undefined, models: Array<{ value: string; label: string }> | undefined): string | null => {
    if (!id) return null;
    const long = id.endsWith("[1m]"); // e.g. claude-opus-5[1m] = the 1M-context variant
    const base = long ? id.slice(0, -4) : id;
    const hit = models?.find((m) => m.label.includes(`(${base})`) || m.value === base);
    return `${hit ? hit.label.replace(/\s*\(.*\)$/, "") : base}${long ? " · 1M context" : ""}`;
};
export interface Env {
    id: string; name: string; path: string; base_branch: string; default_account_id: string | null; account_order: string | null; config_dir_id: string | null;
    chrome_device_id: string | null; chrome_browser_name: string | null; qa_seed_hints: string | null; app_url: string | null; qa_script: string | null;
    be_command: string | null; fe_command: string | null; be_url_template: string | null; fe_url_template: string | null; be_port: number | null; fe_port: number | null;
    setup_command: string | null; repos: string | null; branch_prefix: string | null; ticket_source: "clickup" | "linear"; env_vars: string | null;
    rules: string | null; cleanup_command: string | null; pr_templates?: string | null;
    // Open every PR this env creates as a GitHub draft (the human marks it ready for review).
    pr_draft?: number;
    // Another env whose BE this one needs reachable to work (started once, shared across every task of this env).
    depends_on_env_id?: string | null;
}
export interface EnvDependencyStatus {
    configured: boolean;
    dependencyEnvName?: string;
    running?: boolean;
    port?: number | null;
    url?: string | null;
    startedAt?: string | null;
}
export interface Rules {
    commitPattern: string; commitForbid: string[]; commitHint: string; branchPattern: string; branchHint: string;
    allowCommit: boolean; allowPush: boolean; allowPrCreate: boolean; prRules: string; prTemplatePath: string | null; automationHandles: string[];
}
export type PrComment =
    | { kind: "review"; id: number; author: string; state: string; body: string; at: string; url: string }
    | { kind: "line"; id: number; author: string; path: string; line: number | null; side: "old" | "new"; outdated: boolean; body: string; at: string; url: string; replyTo: number | null; snippet: string; threadId: string | null; resolved: boolean }
    | { kind: "general"; id: number; author: string; body: string; at: string; url: string };
// `repo` = GitHub owner/name, `repoDir` = the task's sub-repo directory ("" for a single-repo env).
export interface PrComments { number: number; repo: string; repoDir: string; human: PrComment[]; automation: PrComment[]; fetchedAt: string }
export interface TaskManager { source: "clickup" | "linear"; label: string; configured: boolean; token: string | null; teamId: string | null; envs: string[] }
export interface EnvRules {
    rules: Rules; prTemplates: Array<{ dir: string; path: string | null; detected: string | null; source: "env" | "dir" | "detected" | "none"; missing: string | null; overridden: boolean }>;
    configDir: { id: string; name: string; path: string }; usableAccounts: string[]; browserAccounts: string[];
}
export interface UsageBucket {
    key: string; label: string; sub?: string; runs: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; turns: number; durationMs: number;
    // Subscription accounts: this bucket's cost as a fraction of the account's 5-hour / 7-day window (null = not calibrated yet).
    fiveHour?: number | null; sevenDay?: number | null;
}
export interface WindowShare { accountId: string; accountName: string; window: string; usdPerWindow: number; samples: number }
export interface UsageReport {
    since: string | null; totals: Omit<UsageBucket, "key" | "label">;
    byEnv: UsageBucket[]; byAccount: UsageBucket[]; byTask: UsageBucket[]; byStage: UsageBucket[]; byModel: UsageBucket[]; byDay: UsageBucket[];
    shares: WindowShare[];
}
export interface TaskUsageRow {
    key: string; accountId: string | null; at: string; stage: string | null; kind: string; status: string | null; attempt: number | null; models: string[];
    turns: number | null; durationMs: number | null; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
}
export interface TaskUsage {
    rows: TaskUsageRow[];
    totals: { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; turns: number; durationMs: number; runs: number };
    byStage: UsageBucket[];
    byAccount: Array<{ accountId: string; accountName: string; cost: number; fiveHour: number | null; sevenDay: number | null }>;
    shares: WindowShare[];
}
// Cost → "% of the account's window" using the calibration list; null when unknown.
export const windowPct = (shares: WindowShare[], accountId: string | null, window: string, cost: number): number | null => {
    const s = accountId ? shares.find((x) => x.accountId === accountId && x.window === window) : undefined;
    return s && s.usdPerWindow > 0 ? (cost / s.usdPerWindow) * 100 : null;
};
export const pct = (v: number | null | undefined): string => (v == null ? "—" : v >= 10 ? `${Math.round(v)}%` : v >= 1 ? `${v.toFixed(1)}%` : `${v.toFixed(2)}%`);
export interface Notifications { macos: boolean; ntfyServer: string; ntfyTopic: string | null; ntfyToken: string | null; baseUrl: string | null; localBaseUrl: string }
export interface Settings {
    clickupToken: string | null; clickupTeamId: string | null; linearApiKey: string | null;
    defaultModel: string | null; models: Array<{ value: string; label: string }>;
    notifications: Notifications;
    desktopNotifier: string;
}
export interface Ticket {
    source: "clickup" | "linear"; id: string; url: string | null; title: string; status: string | null; description: string;
    acceptanceCriteria: string[]; parent: { id: string; title: string; description: string } | null;
    // Optional: tickets fetched before this field existed have no comments key in their stored ticket.json — re-fetch to get them.
    comments?: Array<{ author: string; body: string; at: string }>;
    // Files attached to the ticket or embedded in its text; `file` is the artifact path once downloaded (null + error otherwise).
    attachments?: TicketAttachment[];
    fetchedVia: "rest" | "mcp";
}
export interface TicketAttachment { name: string; url: string; mime: string | null; file: string | null; size: number | null; error: string | null; origin: "attachment" | "description" | "comment" }
// `state`: starting until the port answers; failed once its command exited, its tmux session vanished, or the start
// budget ran out — `error` says which. A failed row stays until Stop, Retry, or Fix with agent.
export type ServiceState = "starting" | "running" | "failed";
export interface Service {
    id: string; task_id: string; kind: "be" | "fe"; port: number; url: string; tmux: string; command: string; log_path: string; started_at: string;
    running: boolean; state: ServiceState; failed_at: string | null; error: string | null;
}
// The diff line a chat message hangs on (asked from Code changes); stored as JSON on the message.
export interface MessageAnchor { path: string; side: "new" | "old"; line: number; snippet: string }
export interface Message { id: string; task_id: string; role: "user" | "agent"; text: string; created_at: string; anchor?: string | null }
export const anchorOf = (m: Pick<Message, "anchor">): MessageAnchor | null => {
    try {
        const v: unknown = m.anchor ? JSON.parse(m.anchor) : null;
        return v && typeof v === "object" && typeof (v as MessageAnchor).path === "string" ? (v as MessageAnchor) : null;
    } catch { return null; }
};
// A free-form claude session from the Sessions page (a tmux pane; `alive` = the pane exists right now).
export interface Session {
    id: string; name: string; env_id: string; env_name: string; account_id: string | null; account_name: string | null; model: string | null;
    cwd: string; worktree_path: string | null; branch: string | null; claude_session_id: string; tmux: string; created_at: string; opened_at: string | null; alive: boolean;
}
export interface AgentQuestion { id: string; text: string; context: string; options: string[] }
export interface QuestionRound { id: string; run_id: string | null; stage: Stage; questions: AgentQuestion[]; answers: Record<string, string> | null; created_at: string; answered_at: string | null }
export const pendingQuestions = (d: Pick<TaskDetail, "questions">): QuestionRound | undefined => d.questions?.find((q) => q.answers === null);
export interface Task {
    id: string; env_id: string; ticket_id: string; title: string | null; source: "clickup" | "linear"; ticket_url: string | null; model: string | null; session_id: string; account_id: string | null;
    branch: string | null; worktree_path: string | null; stage: Stage; status: TaskStatus; status_line: string | null;
    pinned: number; notes: string | null; extra_tickets: string | null; labels?: string | null; created_at: string; updated_at: string;
}
export interface TaskLabel { text: string; color: string }
export const labelsOf = (t: Pick<Task, "labels">): TaskLabel[] => {
    try {
        const v: unknown = t.labels ? JSON.parse(t.labels) : [];
        return Array.isArray(v) ? v.filter((x): x is TaskLabel => !!x && typeof x === "object" && typeof (x as TaskLabel).text === "string" && typeof (x as TaskLabel).color === "string") : [];
    } catch { return []; }
};
export const extraTicketIds = (t: Pick<Task, "extra_tickets">): string[] => {
    try {
        const v: unknown = t.extra_tickets ? JSON.parse(t.extra_tickets) : [];
        return Array.isArray(v) ? v.map((x: { id?: unknown }) => (typeof x?.id === "string" ? x.id : null)).filter((x): x is string => !!x) : [];
    } catch { return []; }
};
export const taskLabel = (t: Pick<Task, "ticket_id" | "extra_tickets">): string => { const x = extraTicketIds(t); return x.length ? `${t.ticket_id} +${x.length}` : t.ticket_id; };
export interface Run {
    id: string; task_id: string; stage: Stage; kind: string; status: string; account_id: string; started_at: string | null;
    finished_at: string | null; resume_at: string | null; error: string | null; result_json: string | null; cost_usd: number | null;
    num_turns: number | null; last_event: string | null; attempt: number;
}
export interface QaStep { action: string; assert: string; shot: boolean }
export interface QaScenario { id: string; title: string; url: string; persona: string; seed?: string[]; steps: QaStep[] }
export interface Design {
    classification: "bug" | "feature"; affectedRepos?: string[]; scope: { inScope: string[]; outOfScope: string[] };
    plan: Array<{ layer: string; changes: string[] }>; testPlan: Array<{ file: string; cases: string[] }>;
    qa: QaScenario[]; qaSkippedReason: string | null;
}
export interface QaPass {
    pass: "before" | "after";
    scenarios: Array<{ id: string; outcome: "pass" | "fail" | "blocked" | "needs_human"; observation: string; shots: Array<{ step: number; file: string }> }>;
    blockers: string[];
}
export interface Impl {
    files: string[]; commits: string[]; tests: { backend: string | null; frontend: string | null };
    coverageNewLines: number | null; gates: { tests: boolean; typecheck: boolean }; notes: string;
}
export interface DiffLine { type: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; hunks: DiffHunk[]; binary: boolean }
export interface DiffGroup { label: string; shas: string[]; files: DiffFile[] }
export interface DiffResponse { base: string; filtered: boolean; groups: DiffGroup[]; files: DiffFile[] }
export interface BranchCommit { sha: string; short: string; subject: string; author: string; at: string; repo: string }
export interface LineComment { path: string; line: number; side: "new" | "old"; snippet: string; text: string }
export interface MyTicket { id: string; title: string; priority: number | null; priorityLabel: string; status: string; url: string | null; group: string }
export interface Review { id: string; stage: Stage; verdict: string; route_to: string | null; notes: string | null; comments: string | null; created_at: string }
export interface TaskDetail {
    task: Task; runs: Run[]; artifacts: Array<{ path: string; size: number }>;
    // Raw research.json as written by the agent — optional fields may be missing when the file predates them or the agent skipped them.
    research: { classification: string; title: string; branchName: string; summary: string; affectedAreas?: string[] } | null;
    design: Design | null; impl: Impl | null; qaBefore: QaPass | null; qaAfter: QaPass | null;
    // Earlier Manual QA attempts (oldest first) that failed and were auto-returned to Implementation before qaAfter.
    qaHistory?: Array<{ attempt: number; data: QaPass | null }>;
    // One drafted PR per repository (repo "" for a single-repo env); base is shared.
    pr: PrDraft | null;
    prFix: { summary: string } | null;
    ticket: Ticket | null;
    // Every stored ticket of the task (one, or several for a batch task), in order.
    // Optional (not `?:`ed as "may be absent forever" but as "may be briefly absent right after a server upgrade" —
    // the dev server hot-reloads new frontend code instantly while the backend only picks up new fields on restart;
    // marking recently-added fields optional here makes every access site use `?.`, so that transient skew is a
    // type error to leave unguarded rather than a runtime crash).
    tickets?: Ticket[];
    messages?: Message[];
    // Rounds of questions the agent asked mid-stage; a round with answers === null is what the task is waiting on.
    questions?: QuestionRound[];
    reviews: Review[];
    // One row per repository's PR; empty until a draft is approved or a PR is found by branch. Optional for the
    // dev-server skew window (see `tickets`).
    prStates?: PrState[];
}
export interface PrDraftEntry { repo: string; title: string; body: string }
// `legacy`: pr.json predates per-repo drafts and was fanned out to every repository — redraft before trusting it.
export interface PrDraft { base: string; drafts: PrDraftEntry[]; legacy?: boolean }
export interface PrState {
    repo: string; number: number | null; url: string | null; checks_json: string | null; review_decision: string | null; merged_at: string | null;
    updated_at: string; pushed_at: string | null; approved_at: string | null; state: string | null;
}
// How a repository is named in the UI: its directory, or "repo" for a single-repo env.
export const repoName = (repo: string): string => repo || "repo";
// The same colour for the same repository everywhere it gets a tab (Pull request, PR Creation Review, Code changes),
// picked by its position in whichever repo list the caller has.
export const REPO_COLORS = ["accent", "wait", "ok", "warn"] as const;
export const repoColorClass = (repo: string, repos: string[]): string => REPO_COLORS[Math.max(0, repos.indexOf(repo)) % REPO_COLORS.length]!;
// The env's sub-repository directories ([] for a single-repo project); env.repos is a JSON array like ["backend","frontend"].
export const envRepos = (env: Pick<Env, "repos"> | undefined): string[] => {
    try {
        const v: unknown = env?.repos ? JSON.parse(env.repos) : [];
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
};
export const prStateOf = (d: Pick<TaskDetail, "prStates">, repo: string): PrState | undefined => d.prStates?.find((r) => r.repo === repo);
// The repositories a task opens PRs in: the drafted ones, else the ones with a PR row, else none known yet.
export const prRepos = (d: Pick<TaskDetail, "pr" | "prStates">): string[] => {
    const fromDraft = d.pr?.drafts.map((x) => x.repo) ?? [];
    const fromRows = (d.prStates ?? []).map((r) => r.repo);
    return [...new Set([...fromDraft, ...fromRows])];
};
export type MergeMethod = "squash" | "merge" | "rebase";
// One entry of `gh pr view --json statusCheckRollup`: a CheckRun (name/status/conclusion/detailsUrl) or a StatusContext (context/state/targetUrl).
export interface PrCheck { name?: string; context?: string; conclusion?: string | null; state?: string; status?: string; startedAt?: string; completedAt?: string; detailsUrl?: string; targetUrl?: string; workflowName?: string }
export const parseChecks = (json: string | null | undefined): PrCheck[] => {
    try {
        return json ? (JSON.parse(json) as PrCheck[]) : [];
    } catch {
        return [];
    }
};
// A cancelled check (superseded by a newer push, stopped by hand) is not a failure of the change — its own outcome,
// counted neither as passing nor as blocking.
export const checkOutcome = (c: PrCheck): "pass" | "fail" | "pending" | "cancelled" => {
    const st = c.conclusion ?? c.state ?? "";
    if (/SUCCESS|NEUTRAL|SKIPPED/i.test(st)) return "pass";
    if (/CANCELLED/i.test(st)) return "cancelled";
    if (/FAILURE|ERROR|TIMED_OUT|ACTION_REQUIRED|STALE/i.test(st)) return "fail";
    return "pending";
};

const j = async <T,>(res: Response): Promise<T> => {
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body;
};
const post = <T,>(url: string, body?: unknown): Promise<T> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => j<T>(r));

export const api = {
    accounts: () => fetch("/api/accounts").then((r) => j<Account[]>(r)),
    addAccount: (name: string, email?: string) => post<{ account: Account; terminal: string }>("/api/accounts", { name, email }),
    refreshAccount: (id: string) => post<{ ok: boolean; detail: string; account: Account }>(`/api/accounts/${id}/refresh`),
    setupToken: (id: string) => post<{ terminal: string }>(`/api/accounts/${id}/setup-token`),
    loginAccount: (id: string) => post<{ terminal: string; dir: string }>(`/api/accounts/${id}/login`),
    probeAccountChrome: (id: string) => post<{ ok: boolean; detail: string; account: Account }>(`/api/accounts/${id}/probe-chrome`),
    configDirs: () => fetch("/api/config-dirs").then((r) => j<ConfigDir[]>(r)),
    addConfigDir: (name: string, path: string) => post<ConfigDir>("/api/config-dirs", { name, path }),
    patchConfigDir: (id: string, body: { name?: string; rules?: Partial<Rules> }) =>
        fetch(`/api/config-dirs/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<ConfigDir>(r)),
    deleteConfigDir: (id: string) => fetch(`/api/config-dirs/${id}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
    configDirRules: (id: string) => fetch(`/api/config-dirs/${id}/rules`).then((r) => j<ConfigDirRules>(r)),
    patchAccount: (id: string, body: { name?: string; failover_enabled?: boolean; failover_threshold?: number; chromeDeviceId?: string | null }) =>
        fetch(`/api/accounts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Account>(r)),
    envs: () => fetch("/api/envs").then((r) => j<Env[]>(r)),
    addEnv: (body: {
        name: string; path: string; baseBranch: string; defaultAccountId?: string; accountOrder?: string[]; configDirId?: string; appUrl?: string; qaScript?: string;
        repos?: string[]; branchPrefix?: string; ticketSource: "clickup" | "linear"; envVars?: string; prDraft?: boolean;
    }) => post<Env>("/api/envs", body),
    patchEnv: (
        id: string,
        body: {
            name?: string; baseBranch?: string; defaultAccountId?: string | null; accountOrder?: string[]; configDirId?: string | null;
            chromeDeviceId?: string | null; chromeBrowserName?: string | null; qaSeedHints?: string | null; appUrl?: string | null; qaScript?: string | null;
            beCommand?: string | null; feCommand?: string | null; beUrlTemplate?: string | null; feUrlTemplate?: string | null; bePort?: number | null; fePort?: number | null;
            setupCommand?: string | null; repos?: string[] | null; branchPrefix?: string | null; ticketSource?: "clickup" | "linear"; envVars?: string | null;
            cleanupCommand?: string | null; prTemplates?: Record<string, string | null>; prDraft?: boolean; dependsOnEnvId?: string | null;
        },
    ) =>
        fetch(`/api/envs/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Env>(r)),
    envRules: (id: string) => fetch(`/api/envs/${id}/rules`).then((r) => j<EnvRules>(r)),
    envDependency: (id: string) => fetch(`/api/envs/${id}/dependency`).then((r) => j<EnvDependencyStatus>(r)),
    readiness: () => fetch("/api/readiness").then((r) => j<Readiness[]>(r)),
    refreshLimits: (id: string) => post<{ ok: boolean; detail: string }>(`/api/accounts/${id}/refresh-limits`),
    deleteEnv: (id: string) => fetch(`/api/envs/${id}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
    deleteAccount: (id: string) => fetch(`/api/accounts/${id}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
    taskManagers: () => fetch("/api/task-managers").then((r) => j<TaskManager[]>(r)),
    patchTaskManager: (source: "clickup" | "linear", body: { token?: string | null; teamId?: string | null }) =>
        fetch(`/api/task-managers/${source}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<TaskManager>(r)),
    testTaskManager: (source: "clickup" | "linear") => post<{ ok: boolean; count?: number; sample?: string[]; error?: string }>(`/api/task-managers/${source}/test`),
    tasks: (envId?: string) => fetch(`/api/tasks${envId ? `?env=${envId}` : ""}`).then((r) => j<Task[]>(r)),
    task: (id: string) => fetch(`/api/tasks/${id}`).then((r) => j<TaskDetail>(r)),
    // mode "each": one task per ticket; "batch": one task covering every ticket.
    createTasks: (body: { envId: string; tickets: string[]; mode: "each" | "batch"; accountId?: string; model?: string; notes?: string }) => post<{ tasks: Task[] }>("/api/tasks", body),
    labelSuggestions: () => fetch("/api/labels").then((r) => j<Array<TaskLabel & { count: number }>>(r)),
    patchTask: (id: string, body: { notes?: string | null; labels?: TaskLabel[] }) =>
        fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Task>(r)),
    returnTo: (id: string, body: { stage: Stage; notes?: string; comments?: LineComment[] }) => post<Task>(`/api/tasks/${id}/return`, body),
    patchPrDraft: (id: string, body: { repo: string; title?: string; body?: string; base?: string }) =>
        fetch(`/api/tasks/${id}/pr-draft`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<PrDraft>(r)),
    cleanup: (id: string, force = false) => post<{ done: string[]; skipped: string[] }>(`/api/tasks/${id}/cleanup${force ? "?force=1" : ""}`),
    deleteTask: (id: string, keepWorktree = false, force = false) =>
        fetch(`/api/tasks/${id}?${new URLSearchParams({ ...(keepWorktree ? { worktree: "keep" } : {}), ...(force ? { force: "1" } : {}) })}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
    settings: () => fetch("/api/settings").then((r) => j<Settings>(r)),
    usage: (days: number) => fetch(`/api/usage?days=${days}`).then((r) => j<UsageReport>(r)),
    taskUsage: (id: string) => fetch(`/api/tasks/${id}/usage`).then((r) => j<TaskUsage>(r)),
    patchSettings: (body: Partial<Omit<Settings, "models" | "notifications">> & { notifications?: Partial<Notifications> }) =>
        fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<{ ok: true }>(r)),
    testNotification: () => post<{ macos: boolean; ntfy: boolean | null; error?: string }>("/api/notifications/test"),
    review: (id: string, body: { verdict: "approve" | "changes"; repo?: string; routeTo?: "implementation" | "design_proposal"; notes?: string; comments?: LineComment[] }) =>
        post<Task>(`/api/tasks/${id}/review`, body),
    // filter: a set of commit shas (contiguous runs become one group each) or "uncommitted"; none = everything vs the base.
    diff: (id: string, filter?: { shas: string[] } | { uncommitted: true }) =>
        fetch(`/api/tasks/${id}/diff${filter ? ("uncommitted" in filter ? "?scope=uncommitted" : `?commits=${filter.shas.join(",")}`) : ""}`).then((r) => j<DiffResponse>(r)),
    commits: (id: string) => fetch(`/api/tasks/${id}/commits`).then((r) => j<{ commits: BranchCommit[]; uncommitted: boolean }>(r)),
    // Reword resolves once the (fast, conflict-free) rewrite is done. Remove only resolves once the agent run has
    // *started* — it can take a while and may hit conflicts; the outcome lands in Chat.
    rewordCommit: (id: string, sha: string, repo: string, message: string) => post<{ newSha: string }>(`/api/tasks/${id}/commits/${sha}/reword`, { repo, message }),
    removeCommit: (id: string, sha: string, repo: string, note?: string) => post<{ started: true }>(`/api/tasks/${id}/commits/${sha}/remove`, { repo, ...(note ? { note } : {}) }),
    forcePush: (id: string, repo: string, force = false) => post<{ ok: true; result: string }>(`/api/tasks/${id}/commits/force-push`, { repo, force }),
    prComments: (id: string, repo: string) => fetch(`/api/tasks/${id}/pr-comments?repo=${encodeURIComponent(repo)}`).then((r) => j<PrComments | null>(r)),
    resolvePrComment: (id: string, repo: string, commentId: number, resolved: boolean) => post<PrComments | null>(`/api/tasks/${id}/pr-comments/${commentId}/resolve`, { repo, resolved }),
    myTickets: (envId: string) => fetch(`/api/envs/${envId}/my-tickets`).then((r) => j<{ source: "clickup" | "linear"; tickets: MyTicket[]; error?: string }>(r)),
    stop: (id: string) => post<Task>(`/api/tasks/${id}/stop`),
    retry: (id: string) => post<Task>(`/api/tasks/${id}/retry`),
    rerun: (id: string, stage: Stage) => post<Task>(`/api/tasks/${id}/rerun`, { stage }),
    qaLogin: (id: string) => post<{ started: true }>(`/api/tasks/${id}/qa-login`),
    fixCi: (id: string, repo: string) => post<{ started: true }>(`/api/tasks/${id}/fix-ci`, { repo }),
    refreshPr: (id: string) => post<{ task: Task; prStates: PrState[] }>(`/api/tasks/${id}/pr/refresh`),
    createApprovedPrs: (id: string) => post<{ ok: true; done: string[]; task: Task; prStates: PrState[] }>(`/api/tasks/${id}/pr/create`),
    mergePr: (id: string, body: { repo: string; method: MergeMethod; deleteBranch: boolean }) => post<{ ok: true; result: string; task: Task }>(`/api/tasks/${id}/pr/merge`, body),
    fixComments: (id: string, repo: string, commentIds: number[]) => post<{ started: true }>(`/api/tasks/${id}/fix-comments`, { repo, commentIds }),
    fetchTicket: (id: string) => post<Ticket>(`/api/tasks/${id}/fetch-ticket`),
    openApp: (id: string) => post<{ opened: string; profile: string }>(`/api/tasks/${id}/open-app`),
    pin: (id: string) => post<Task>(`/api/tasks/${id}/pin`),
    setAccount: (id: string, accountId: string) => post<Task>(`/api/tasks/${id}/account`, { accountId }),
    terminal: (id: string) => post<{ terminal: string }>(`/api/tasks/${id}/terminal`),
    services: (id: string) => fetch(`/api/tasks/${id}/services`).then((r) => j<Service[]>(r)),
    startService: (id: string, kind: "be" | "fe") => post<Service>(`/api/tasks/${id}/services/${kind}/start`),
    stopService: (id: string, kind: "be" | "fe") => post<Service[]>(`/api/tasks/${id}/services/${kind}/stop`),
    serviceLog: (id: string, kind: "be" | "fe", lines = 120) => fetch(`/api/tasks/${id}/services/${kind}/log?lines=${lines}`).then((r) => r.text()),
    // Resolves once the agent run has started; its outcome and the automatic restart's result land in Chat.
    fixService: (id: string, kind: "be" | "fe") => post<{ started: true }>(`/api/tasks/${id}/services/${kind}/fix`),
    sessions: () => fetch("/api/sessions").then((r) => j<Session[]>(r)),
    createSession: (body: { envId: string; accountId?: string | null; model?: string | null; name?: string; branch?: string | null }) => post<Session>("/api/sessions", body),
    openSession: (id: string) => post<Session>(`/api/sessions/${id}/open`),
    closeSession: (id: string) => post<Session[]>(`/api/sessions/${id}/close`),
    renameSession: (id: string, name: string) =>
        fetch(`/api/sessions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => j<Session>(r)),
    deleteSession: (id: string, removeWorktree: boolean, force = false) =>
        fetch(`/api/sessions/${id}?${new URLSearchParams({ ...(removeWorktree ? { worktree: "remove" } : {}), ...(force ? { force: "1" } : {}) })}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
    sessionDiff: (id: string, filter?: { shas: string[] } | { uncommitted: true }) =>
        fetch(`/api/sessions/${id}/diff${filter ? ("uncommitted" in filter ? "?scope=uncommitted" : `?commits=${filter.shas.join(",")}`) : ""}`).then((r) => j<DiffResponse>(r)),
    sessionCommits: (id: string) => fetch(`/api/sessions/${id}/commits`).then((r) => j<{ commits: BranchCommit[]; uncommitted: boolean }>(r)),
    artifactUrl: (id: string, rel: string) => `/api/tasks/${id}/artifacts/${rel}`,
    messages: (id: string) => fetch(`/api/tasks/${id}/messages`).then((r) => j<Message[]>(r)),
    answerQuestions: (id: string, roundId: string, answers: Record<string, string>) => post<Task>(`/api/tasks/${id}/questions/${roundId}/answer`, { answers }),
    // With an anchor the question is about one diff line; the reply carries the same anchor (a thread under that line).
    sendMessage: (id: string, text: string, anchor?: MessageAnchor) => post<Message>(`/api/tasks/${id}/messages`, { text, ...(anchor ? { anchor } : {}) }),
};

// A CircleCI job gated behind a manual "Approve" click (deploy/db-reset gates) sits pending forever until a human
// clicks through — it is not CI verifying the change, so it must not count against "checks passed" or block PR Green.
// Mirrors server/src/engine.ts's isApprovalGateCheck.
export const isApprovalGateCheck = (c: { name?: string; context?: string }): boolean => /_hold$|reset_.*_db$/i.test(c.name ?? c.context ?? "");

export const STAGE_LABEL: Record<Stage, string> = {
    research: "Research", design_proposal: "Design Proposal", qa_baseline: "QA baseline", implementation: "Implementation",
    manual_qa: "Manual QA", user_review: "User Review", pr_creation_review: "PR Creation Review", pr_waiting: "PR Waiting",
    pr_fix: "PR Fix", pr_green: "PR Green", pr_approved: "PR Approved", done: "Done",
};
export const STAGE_ORDER: Stage[] = [
    "research", "design_proposal", "qa_baseline", "implementation", "manual_qa", "user_review",
    "pr_creation_review", "pr_waiting", "pr_fix", "pr_green", "pr_approved", "done",
];
