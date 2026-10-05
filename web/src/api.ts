export type Stage =
    | "research" | "design_proposal" | "qa_baseline" | "implementation" | "code_review" | "manual_qa" | "user_review"
    | "pr_creation_review" | "pr_waiting" | "pr_fix" | "pr_green" | "pr_approved" | "done";

export type TaskStatus = "idle" | "queued" | "running" | "waiting_user" | "blocked" | "rate_limited" | "failed" | "done" | "stopped";

// An AI provider login. `has_token` = long-lived OAuth token stored (works in any config dir); otherwise a legacy browser
// login that lives in `auth_dir` and only works when that dir is the environment's config dir.
export interface Account {
    id: string; name: string; provider: string; auth_dir: string; has_token: boolean; setting_up: boolean; email: string | null; org: string | null; plan: string | null;
    logged_in: number; failover_enabled: number; failover_threshold: number; default_model: string | null;
    // Browser stages need this account's claude.ai browser login (in browser_dir) and a Chrome profile whose extension is signed into it.
    login_ok: number | null; login_dir: string | null; chrome_capable: number | null; chrome_device_id: string | null; chrome_browser_name: string | null;
    // 1: every browser QA run copies the Chrome profile into a private Chrome window of its own (parallel browser QA).
    chrome_clone_qa: number;
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
    rules: string | null; cleanup_command: string | null; rebase_command?: string | null; migrate_command?: string | null; migrate_down_command?: string | null; memory_wings?: string | null; ci_autopilot?: number; test_command?: string | null; ci_autopilot_rules?: string | null; callback_ports?: string | null; prepare_command?: string | null; qa_session_command?: string | null; db_hosts_command?: string | null; allowed_db_hosts?: string | null; task_db?: string | null; qa_auto_fix?: string | null; check_command?: string | null; components?: string | null; keep_services?: number; qa_browser?: "chrome" | "gstack"; pr_templates?: string | null;
    // JSON ReviewChecklist: gstack categories switched off, points added, extra do-not-flag rules for Code Review; null = the full checklist.
    review_checklist?: string | null;
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
export interface ClaudeMdFile {
    id: string;
    label: string;
    path: string;
    scope: "config-dir" | "repo";
    exists: boolean;
    content: string;
}

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
// Timing (timing.ts on the server): run wall time by stage / operation / day, and per task how long it worked,
// waited for the human, waited for GitHub or sat rate-limited.
export interface TimingBucket { key: string; label: string; sub?: string; runs: number; totalMs: number; avgMs: number; medianMs: number; p90Ms: number; maxMs: number }
export interface TaskTiming {
    key: string; label: string; sub?: string; done: boolean; status: string | null; stage: string | null; createdAt: string | null;
    leadMs: number; agentMs: number; runs: number; workingMs: number; waitingHumanMs: number; waitingGithubMs: number; rateLimitedMs: number;
    stagesMs: Record<string, number>; tracked: boolean;
}
export interface TimingReport {
    since: string | null;
    totals: { runs: number; agentMs: number; operationsMs: number; tasks: number; doneTasks: number; avgLeadMs: number; medianLeadMs: number; workingMs: number; waitingHumanMs: number; waitingGithubMs: number; rateLimitedMs: number };
    byStage: TimingBucket[]; byOperation: TimingBucket[]; byStageState: TimingBucket[]; byTask: TaskTiming[]; byDay: TimingBucket[];
}
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
// Prompter, the in-app assistant: which token account runs it, its default model, when an idle chat ends.
export interface PrompterSettings { accountId: string | null; model: string; idleHours: number; purgeDays: number; farewell: boolean; maxTurns: number; seedFrom: string; seedWings: string[] }
// Which model a run gets: stageModels for a stage's first run on a task, stageRerunModels for every later run of it,
// operationModels for the side runs (PR fixes by cause, chat, Do, rebase, service fix, history edit). "" / null = fallback.
export type ModelStage = "research" | "design_proposal" | "qa_baseline" | "implementation" | "code_review" | "manual_qa" | "pr_creation_review" | "pr_fix";
export type ModelOperation = "pr_fix_ci" | "pr_fix_comments" | "chat" | "instruct" | "rebase" | "fix_service" | "git_edit";
// The resource registry (server/src/resources.ts): one row per thing Stagehand runs on the host, with its policy verdict.
export type ResourceKind = "service" | "dependency" | "run" | "terminal" | "session" | "login" | "browser" | "clone" | "worktree" | "database" | "orphan";
export interface Resource {
    id: string; kind: ResourceKind; label: string;
    owner: { type: "task" | "env" | "session" | "account" | "none"; id: string | null; name: string | null; stage?: string; status?: string };
    tmux: string | null; pid: number | null; port: number | null; path: string | null;
    rssMb: number; cpuPct: number; procs: number; top: string | null;
    startedAt: string | null; ageMs: number; idleMs: number | null; diskMb: number | null;
    pinned: boolean;
    policy: { verdict: "keep" | "stop"; reason: string; dueAt: string | null };
}
export interface ResourcePolicies {
    enabled: boolean; idleServiceMinutes: number; doneServiceMinutes: number; settleMinutes: number; maxSessionMb: number; terminalIdleHours: number; sessionIdleHours: number; loginMinutes: number; orphanMinutes: number; maxDevServerTasks: number; minAvailableMb: number; maxSwapMb: number;
}
export interface ResourceEvent { id: number; at: string; resource_id: string; kind: string; label: string; task_id: string | null; action: string; reason: string; rss_mb: number | null }
export interface ResourceSnapshot {
    at: string;
    host: { totalMb: number; availableMb: number; usedMb: number; compressedMb: number; swapUsedMb: number; swapTotalMb: number; pressure: "ok" | "warn" | "critical"; pressureReason: string };
    // The volume holding Stagehand's data; absent from an older server.
    disk?: { totalMb: number; freeMb: number } | null;
    stagehand: { rssMb: number; procs: number; devServerTasks: number; runs: number; browsers: number; terminals: number };
    policies: ResourcePolicies;
    resources: Resource[];
    events: ResourceEvent[];
}
export interface Settings {
    clickupToken: string | null; clickupTeamId: string | null; linearApiKey: string | null; typesafeApiKey: string | null;
    defaultModel: string | null; models: Array<{ value: string; label: string }>;
    resources?: ResourcePolicies;
    // When the model list was last fetched from the Models API (null = the built-in fallback list), and why the last
    // fetch failed; absent from an older server.
    modelsFetchedAt?: string | null; modelsError?: string | null;
    stageModels?: Partial<Record<ModelStage, string | null>>;
    // The Code Review stage after Implementation (gstack's checklist); absent from an older server.
    codeReview?: boolean;
    stageRerunModels?: Partial<Record<ModelStage, string | null>>;
    operationModels?: Partial<Record<ModelOperation, string | null>>;
    notifications: Notifications;
    desktopNotifier: string;
    // Absent from a server older than this UI.
    prompter?: PrompterSettings;
}
export interface PrompterSession { id: string; claude_session_id: string; model: string | null; account_id: string | null; created_at: string; last_at: string; pinged_at: string; closed_at: string | null; turns: number; title: string | null; busy?: boolean }
// state "queued": sent while a turn was running; goes out with the next turn and can be taken back into the input until then.
export interface PrompterMessage { id: string; session_id: string; role: "user" | "assistant" | "system"; text: string; path: string | null; created_at: string; state: "sent" | "queued" }
export interface PrompterStatus { home: string; configDir: string; account: string | null; model: string; open: number; seeded: { at: string; total: number; copied: number } | null; ready: boolean; reason: string | null }
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
// "stopped" is reported for the env's shared dependency only (kind "dependency", listed even while it is down).
export type ServiceState = "stopped" | "starting" | "running" | "failed";
// An optional component of an env (envs.components): an extra per-task service beside the BE/FE, without a port.
export interface EnvComponent { key: string; label: string; command: string; autoStart: boolean }
// The Code Review checklist of an env (envs.review_checklist), mirrored from server/src/review-checklist.ts.
export type ReviewPass = "critical" | "informational";
export interface ReviewCategoryDef { key: string; title: string; pass: ReviewPass; detail: string }
export interface ReviewPoint { key: string; title: string; pass: ReviewPass; detail: string }
export interface ReviewChecklist { disabled: string[]; custom: ReviewPoint[]; doNotFlag: string[] }
// The CI autopilot's list per env: built-in kinds switched off, and the env's own allow / deny rules.
export const AUTOPILOT_KINDS = [
    { key: "own_migration", title: "Migrations of this branch", detail: "a migration conflict, or a migration the branch added that fails to apply" },
    { key: "own_test", title: "Tests of this branch", detail: "a test the branch added or changed fails" },
    { key: "affected_test", title: "Tests this branch broke", detail: "a test the branch did not touch fails because of it, and passes on base (a query budget, a snapshot)" },
    { key: "own_lint", title: "Lint on this branch's lines", detail: "lint or format errors on lines the branch added or changed — not elsewhere in a touched file" },
] as const;
export interface AutopilotRules { disabled: string[]; custom: Array<{ key: string; title: string; verdict: "allow" | "deny"; detail: string }> }
export const autopilotRulesOf = (env: Pick<Env, "ci_autopilot_rules"> | undefined): AutopilotRules => {
    try {
        const v = env?.ci_autopilot_rules ? (JSON.parse(env.ci_autopilot_rules) as Partial<AutopilotRules>) : null;
        return { disabled: Array.isArray(v?.disabled) ? v.disabled : [], custom: Array.isArray(v?.custom) ? v.custom.map((r) => ({ key: r.key, title: r.title, verdict: r.verdict === "allow" ? "allow" : "deny", detail: r.detail ?? "" })) : [] };
    } catch {
        return { disabled: [], custom: [] };
    }
};
export const reviewChecklistOf = (env: Pick<Env, "review_checklist"> | undefined): ReviewChecklist => {
    try {
        const v = env?.review_checklist ? (JSON.parse(env.review_checklist) as Partial<ReviewChecklist>) : null;
        return {
            disabled: Array.isArray(v?.disabled) ? v.disabled.filter((k): k is string => typeof k === "string") : [],
            custom: Array.isArray(v?.custom) ? v.custom.filter((p): p is ReviewPoint => !!p && typeof p.title === "string").map((p) => ({ key: p.key ?? "", title: p.title, pass: p.pass === "critical" ? "critical" : "informational", detail: p.detail ?? "" })) : [],
            doNotFlag: Array.isArray(v?.doNotFlag) ? v.doNotFlag.filter((x): x is string => typeof x === "string") : [],
        };
    } catch {
        return { disabled: [], custom: [], doNotFlag: [] };
    }
};
export const componentsOf = (env: Pick<Env, "components"> | undefined): EnvComponent[] => {
    try {
        const v: unknown = env?.components ? JSON.parse(env.components) : [];
        return Array.isArray(v) ? v.filter((c): c is EnvComponent => !!c && typeof c === "object" && typeof (c as EnvComponent).key === "string").map((c) => ({ key: c.key, label: c.label?.trim() ? c.label : c.key, command: c.command ?? "", autoStart: c.autoStart === true })) : [];
    } catch { return []; }
};
export interface Service {
    id: string; task_id: string; kind: string; port: number; url: string; tmux: string; command: string; log_path: string; started_at: string;
    running: boolean; state: ServiceState; failed_at: string | null; error: string | null;
    // Set on the shared dependency's entry only: "<env name> (shared)", one instance for every task of the env.
    label?: string; shared?: boolean;
}
// The diff line a chat message hangs on (asked from Code changes); stored as JSON on the message.
// `prComment` marks a thread under a GitHub PR comment (PR comments tab) instead of a diff line.
export interface MessageAnchor { path: string; side: "new" | "old"; line: number; snippet: string; prComment?: { repo: string; number: number; id: number; author: string; url: string } }
export type MessageKind = "instruction" | "instruction_result";
// A file the human attached to a message / instruction / answer: saved under the task dir's shared/, served by artifactUrl.
export interface SharedFile { name: string; file: string; mime: string | null; size: number }
export interface Message { id: string; task_id: string; role: "user" | "agent"; text: string; created_at: string; anchor?: string | null; kind?: MessageKind | null; files?: string | null }
export const filesOf = (m: Pick<Message, "files">): SharedFile[] => {
    try {
        const v: unknown = m.files ? JSON.parse(m.files) : null;
        return Array.isArray(v) ? (v as SharedFile[]) : [];
    } catch { return []; }
};
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
    branch: string | null; base_branch: string | null; skip_qa?: number; worktree_path: string | null; stage: Stage; status: TaskStatus; status_line: string | null;
    pinned: number; notes: string | null; extra_tickets: string | null; labels?: string | null; product_owner_id?: string | null; ci_autopilot?: number | null; created_at: string; updated_at: string;
}
// Product Owners: one per project of the product (a Linear project, a ClickUp epic).
export type PoPhase = "context" | "design" | "tickets" | "approved" | "live";
export interface ProductOwner {
    id: string; title: string; slug: string; source: "linear" | "clickup"; scope_kind: "project" | "epic" | "env"; scope_id: string; scope_url: string | null;
    team_id: string | null; phase: PoPhase; status: "idle" | "running" | "failed"; status_line: string | null; account_id: string | null; created_at: string; updated_at: string;
    issues_refreshed_at?: string | null; issues_error?: string | null; env_id: string;
    tasks?: number; created?: number; tickets?: number; ticketsDone?: number; progress?: number | null;
}
export interface PoMessage { id: string; po_id: string; role: "user" | "agent" | "system"; text: string; created_at: string }
export interface PoArtifact { id: string; po_id: string; kind: "upload" | "text" | "linear" | "notion" | "clickup" | "url"; title: string; source_url: string | null; file: string; mime: string | null; size: number | null; created_at: string; description?: string | null; text_file?: string | null; chunks?: number | null }
export interface PoTicket { key: string; type: "epic" | "story" | "task" | "bug"; title: string; parent: string | null; summary: string; description: string; acceptanceCriteria: string[]; estimate: number | null; dependsOn: string[]; labels: string[]; existing?: string | null }
// An issue of the PO's project as the last refresh saw it.
export interface PoIssue {
    identifier: string; remoteId: string; url: string; title: string; status: string | null; description: string; labels: string[];
    assignee: string | null; priority: string | null; estimate: number | null; parent: string | null;
    comments: Array<{ id: string; author: string; at: string; body: string }>;
}
export interface PoTicketLink { key: string; remote_id: string; identifier: string | null; url: string | null }
export interface PoDetail {
    po: ProductOwner; running: boolean; context: string; design: string | null; tickets: { tickets: PoTicket[] } | null; ticketsError: string | null;
    proposal: string | null; messages: PoMessage[]; artifacts: PoArtifact[]; links: PoTicketLink[]; revisions: Array<{ file: string; name: string; at: string }>;
    issues: PoIssue[]; refreshingIssues: boolean;
    tasks: Array<{ id: string; ticket_id: string; title: string | null; stage: Stage; status: TaskStatus; env_id: string }>;
    questions: PoQuestion[]; askingQuestions: string[]; events: PoJournalEvent[]; corrections: PoCorrection[];
}
// The PO's outstanding questions: it keeps the list; the human discusses each and confirms the suggested resolution.
export interface PoQuestion {
    id: string; key: string; question: string; detail: string; status: "open" | "proposed" | "resolved" | "dropped"; resolution: string | null;
    thread: Array<{ role: "user" | "po"; text: string; at: string }>; event_id: string | null; created_at: string; updated_at: string; resolved_at: string | null;
}
// What reached the PO and what its turn changed.
export interface PoJournalEvent {
    id: string; kind: string; title: string; body: string; status: "pending" | "waiting" | "processing" | "done" | "unread" | "failed"; brief: string | null; error: string | null;
    changes: { context?: string[]; design?: string[]; tickets?: string[]; revisions?: Record<string, string> } | null;
    memory: Array<{ tool: string; input: string }>; refs: { artifacts?: string[]; question?: string; turn?: string }; retryable: boolean;
    created_at: string; processed_at: string | null; linked: { questions: string[]; corrections: number };
}
// A change the PO suggests after an event: a new description for an existing ticket, or a change to a task's design.
export interface PoCorrection {
    id: string; kind: "ticket" | "task"; target: string; title: string; body: string; before: string | null; after: string | null;
    status: "open" | "sent" | "discarded" | "applied" | "withdrawn"; event_id: string | null; created_at: string; updated_at: string; diff?: string[];
}
export type PoEvent = { poId: string; kind: "updated" } | { poId: string; kind: "text"; text: string } | { poId: string; kind: "activity"; text: string } | { poId: string; kind: "message"; message: PoMessage };
export interface PalaceHit { text: string; wing: string; room: string; similarity?: number; source_file?: string }
export interface PoReview { running: boolean; status: string | null; error: string | null; at: string | null; text: string | null }
// The PO's review of a design proposal: a verdict and graded comments the human picks and discusses.
export interface PoReviewComment {
    id: string; severity: "high" | "medium" | "low"; area: "product" | "scope" | "acceptance" | "qa" | "question"; title: string; body: string; laterTicket: string | null;
    include?: boolean; withdrawn: boolean; note: string | null; sentAt: string | null; thread: Array<{ role: "user" | "po"; text: string; at: string }>;
}
export interface PoDesignReview { running: boolean; status: string | null; error: string | null; at: string | null; asking: string | null; review: { verdict: "approve" | "changes"; summary: string; comments: PoReviewComment[]; sentAt: string | null } | null }
// The PR comments the current fix round addressed, the round's commits, and the replies picked for after the push.
export interface PrFixReplies {
    at: string;
    repos: Record<string, { number: number; prUrl: string; headBefore: string; comments: Array<{ id: number; kind: "review" | "line" | "general"; author: string; url: string; body: string; path?: string; line?: number | null }> }>;
    replies: Array<{ repo: string; commentId: number; sha: string; posted?: string | null; error?: string | null }>;
    commits: Record<string, Array<{ sha: string; subject: string }>>;
}
// Task databases (server task-db.ts): the env's config and what exists.
export interface TaskDbConfig {
    enabled: boolean;
    template: string;
    namePattern: string;
    create: string;
    drop: string;
    connect: string;
    list: string;
    sharedNames: string[];
}
export interface TaskDbRow {
    task_id: string;
    env_id: string;
    name: string;
    template: string;
    status: "creating" | "ready" | "failed";
    error: string | null;
    created_at: string;
    updated_at: string;
}
export interface TaskDbInfo {
    row: TaskDbRow | null;
    active: boolean;
    template: string | null;
    sizeMb: number | null;
}
export interface EnvDbOverview {
    active: boolean;
    template: { name: string; sizeMb: number | null; worktree: string | null } | null;
    taskDbs: Array<TaskDbRow & { ticketId: string | null; sizeMb: number | null }>;
    shared: Array<{ taskId: string; ticketId: string; stage: Stage; status: string }>;
    orphans: Array<{ name: string; sizeMb: number | null }>;
    listedAt: string;
    listError: string | null;
}
export const taskDbConfigOf = (env: { task_db?: string | null }): TaskDbConfig => {
    const empty: TaskDbConfig = { enabled: false, template: "", namePattern: "", create: "", drop: "", connect: "", list: "", sharedNames: [] };
    try {
        return env.task_db ? { ...empty, ...(JSON.parse(env.task_db) as Partial<TaskDbConfig>) } : empty;
    } catch {
        return empty;
    }
};

// The CI autopilot of a task (server ci-autopilot.ts): its rounds, from the triage to the push.
export interface AutopilotFailure {
    check: string; kind: "own_migration" | "own_test" | "affected_test" | "own_lint" | "custom" | "other"; rule?: string | null; what: string; tests: string[]; locations: string[]; evidence: string;
    verdict: "allow" | "deny"; reason: string; allowed: boolean; why: string; keep: string[];
}
export interface AutopilotRound {
    id: string; repo: string; prNumber: number; headSha: string; at: string;
    phase: "triage" | "fixing" | "reviewing" | "addressing" | "pushing" | "pushed" | "denied" | "failed" | "stopped";
    triage?: { summary: string }; verified?: AutopilotFailure[]; review?: { summary: string; findings: Array<{ severity: string; confidence: number; file: string; line?: number | null; title: string; detail: string }> };
    pushed?: Record<string, string>; error?: string; endedAt?: string;
}
export interface CiAutopilot { on: boolean; busy: boolean; consecutive: number; stopped: string | null; rounds: AutopilotRound[] }
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
    // The --model the run started with; null = the account's default (absent from a server older than this UI).
    model?: string | null;
    // A QA pass split into parallel runs: which scenarios this run drove ("S2", "api", "S1+S3"), and its pass group.
    shard?: string | null;
    group_id?: string | null;
}
export interface QaStep { action: string; assert: string; shot: boolean }
export interface QaScenario { id: string; kind?: "browser" | "api"; title: string; url: string; persona: string; teardown?: string[]; seed?: string[]; steps: QaStep[]; baseline?: boolean }
export interface Design {
    classification: "bug" | "feature"; affectedRepos?: string[]; scope: { inScope: string[]; outOfScope: string[] };
    plan: Array<{ layer: string; changes: string[] }>; testPlan: Array<{ file: string; cases: string[] }>;
    qa: QaScenario[]; qaSkippedReason: string | null;
}
export type QaAutoFixScope = "off" | "seeds" | "seeds+steps" | "seeds+steps+asserts";
// A correction applied to a scenario in design.json (qa/changes.json): who approved it and the scenario before/after.
export interface QaChange {
    id: string;
    at: string;
    scenario: string;
    kind: "step" | "seed" | "teardown" | "assert" | "scenario";
    index: number;
    before: unknown;
    after: unknown;
    by: "human" | "jev";
    question: string;
    reason?: string;
    jev?: { legit: number; weakens: number; kind: string };
    revertedAt?: string;
}
export interface QaPass {
    pass: "before" | "after";
    // `jev`: Jev's 0–100 grade of the runner's observation against the asserts (Manual QA only; pass needs 85+).
    scenarios: Array<{ id: string; outcome: "pass" | "fail" | "blocked" | "needs_human"; observation: string; shots: Array<{ step: number; file: string }>; log?: string; jev?: { grade: number; verdict: "pass" | "fail"; runner: string }; superseded?: string }>;
    blockers: string[];
}
export interface Impl {
    files: string[]; commits: string[]; tests: { backend: string | null; frontend: string | null };
    coverageNewLines: number | null; gates: { tests: boolean; typecheck: boolean }; notes: string;
}
export interface DiffLine { type: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
// `collapsed`: a generated or very large file whose hunks were left out of the response — fetch it alone (`file`) to see them.
export interface DiffFile { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; hunks: DiffHunk[]; binary: boolean; collapsed?: boolean }
export interface DiffGroup { label: string; shas: string[]; files: DiffFile[] }
// baseDrift: sub-repos ("" = the single repo) whose origin/<base> is no longer an ancestor of HEAD — the base was
// rewritten under the branch, so "all changes" would show the base's own commits; absent for session diffs.
export interface DiffResponse { base: string; filtered: boolean; baseDrift?: string[]; groups: DiffGroup[]; files: DiffFile[] }
export interface BranchCommit { sha: string; short: string; subject: string; author: string; at: string; repo: string }
export interface LineComment { path: string; line: number; side: "new" | "old"; snippet: string; text: string }
export interface MyTicket { id: string; title: string; priority: number | null; priorityLabel: string; status: string; url: string | null; group: string }
export interface Review { id: string; stage: Stage; verdict: string; route_to: string | null; notes: string | null; comments: string | null; created_at: string }
export interface ReviewFinding {
    id: string; severity: "P0" | "P1" | "P2" | "P3"; confidence: number; category?: string; file: string; line?: number | null;
    title: string; detail?: string; quote?: string; status: "fixed" | "open" | "suppressed"; commit?: string | null;
}
export interface ReviewResult { summary: string; findings: ReviewFinding[] }
export interface TaskDetail {
    task: Task; onBase?: boolean; runs: Run[]; artifacts: Array<{ path: string; size: number }>;
    // Raw research.json as written by the agent — optional fields may be missing when the file predates them or the agent skipped them.
    research: { classification: string; title: string; branchName: string; summary: string; affectedAreas?: string[] } | null;
    design: Design | null; impl: Impl | null; qaBefore: QaPass | null; qaAfter: QaPass | null;
    // Earlier Manual QA attempts (oldest first) that failed and were auto-returned to Implementation before qaAfter.
    qaHistory?: Array<{ attempt: number; data: QaPass | null }>;
    // One drafted PR per repository (repo "" for a single-repo env); base is shared.
    pr: PrDraft | null;
    prFix: { summary: string } | null;
    // review.json of the Code Review stage (absent from an older server).
    review?: ReviewResult | null;
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
export interface PrDraftEntry { repo: string; title: string; body: string; base?: string; stackedOn?: { number: number; url: string; title: string } | null; stackNote?: string | null }
// `legacy`: pr.json predates per-repo drafts and was fanned out to every repository — redraft before trusting it.
export interface PrDraft { base: string; drafts: PrDraftEntry[]; legacy?: boolean }
export interface PrState {
    repo: string; number: number | null; url: string | null; checks_json: string | null; review_decision: string | null; merged_at: string | null;
    updated_at: string; pushed_at: string | null; pushed_sha: string | null; approved_at: string | null; state: string | null;
}
// How a repository is named in the UI: its directory, or "repo" for a single-repo env.
export const repoName = (repo: string): string => repo || "repo";
// The same colour for the same repository everywhere it gets a tab (Pull request, PR Creation Review, Code changes),
// picked by its position in whichever repo list the caller has.
export const REPO_COLORS = ["accent", "wait", "ok", "warn"] as const;
export const repoColorClass = (repo: string, repos: string[]): string => REPO_COLORS[Math.max(0, repos.indexOf(repo)) % REPO_COLORS.length]!;
// The env's sub-repository directories ([] for a single-repo project); env.repos is a JSON array like ["backend","frontend"].
// tasks.base_branch as stored: null, one branch for every repository, or a JSON map {repoDir: branch} for a multi-repo
// env whose repositories start from different branches.
export const parseBaseBranch = (raw: string | null | undefined): string | Record<string, string> | null => {
    const t = raw?.trim();
    if (!t) return null;
    if (!t.startsWith("{")) return t;
    try {
        const o = JSON.parse(t) as unknown;
        return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, string>) : null;
    } catch {
        return null;
    }
};
// The base of each repository of the env ("" = the single repo), env default filled in.
export const taskBases = (task: Pick<Task, "base_branch">, env: Pick<Env, "repos" | "base_branch"> | undefined): Record<string, string> => {
    const repos = envRepos(env);
    const keys = repos.length ? repos : [""];
    const b = parseBaseBranch(task.base_branch);
    const fallback = env?.base_branch ?? "";
    return Object.fromEntries(keys.map((k) => [k, typeof b === "string" ? b : (b?.[k]?.trim() || fallback)]));
};
// "dev", or "backend: x · frontend: dev" when repositories differ; null when every repo is on the env default.
export const baseLabel = (task: Pick<Task, "base_branch">, env: Pick<Env, "repos" | "base_branch"> | undefined): string | null => {
    const bases = taskBases(task, env);
    const values = Object.values(bases);
    if (env && values.every((v) => v === env.base_branch)) return null;
    const distinct = [...new Set(values)];
    return distinct.length <= 1 ? (distinct[0] ?? null) : Object.entries(bases).map(([r, b]) => `${r || "repo"}: ${b}`).join(" · ");
};

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

// A dead or restarting backend answers through the dev proxy with an HTML/text page: say so instead of surfacing the
// browser's JSON parse error (Safari: "The string did not match the expected pattern").
const j = async <T,>(res: Response): Promise<T> => {
    let body: (T & { error?: string }) | null = null;
    try {
        body = (await res.json()) as T & { error?: string };
    } catch {
        throw new Error(res.ok ? "the server sent no JSON" : `the server is not reachable (HTTP ${res.status}) — it may be restarting; try again in a few seconds`);
    }
    if (!res.ok) throw new Error(body?.error ?? res.statusText);
    return body as T;
};
const diffQuery = (filter?: { shas: string[] } | { uncommitted: true }, file?: string): string => {
    const q = new URLSearchParams();
    if (filter) "uncommitted" in filter ? q.set("scope", "uncommitted") : q.set("commits", filter.shas.join(","));
    if (file) q.set("file", file);
    return q.toString();
};
const post = <T,>(url: string, body?: unknown): Promise<T> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => j<T>(r));

// One multipart upload per file into the task dir's shared/; the descriptors go on the message that follows.
const uploadFileTo = (url: string, f: File): Promise<SharedFile> => {
    const fd = new FormData();
    fd.append("file", f, f.name);
    return fetch(url, { method: "POST", body: fd }).then((r) => j<SharedFile>(r));
};
const uploadFiles = async (taskId: string, files: File[]): Promise<SharedFile[]> => {
    const out: SharedFile[] = [];
    for (const f of files) out.push(await uploadFileTo(`/api/tasks/${taskId}/files`, f));
    return out;
};
// Prompter has no task: its files live under the Prompter home, per session.
const uploadPrompterFiles = async (sessionId: string, files: File[]): Promise<SharedFile[]> => {
    const out: SharedFile[] = [];
    for (const f of files) out.push(await uploadFileTo(`/api/prompter/sessions/${sessionId}/files`, f));
    return out;
};
const withFiles = (body: Record<string, unknown>, files: SharedFile[] | undefined): Record<string, unknown> => (files?.length ? { ...body, files } : body);

export const api = {
    productContext: (env: string) => fetch(`/api/product/context?${new URLSearchParams({ env })}`).then((r) => j<{ text: string }>(r)),
    setProductContext: (env: string, text: string) => fetch("/api/product/context", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ env, text }) }).then((r) => j<{ text: string }>(r)),
    // One wing (a PO's), or the memory of an environment (its product wing and its POs' wings).
    palaceSearch: (q: string, scope: { wing?: string; env?: string }) => fetch(`/api/product/search?${new URLSearchParams({ q, ...(scope.wing ? { wing: scope.wing } : {}), ...(scope.env ? { env: scope.env } : {}) })}`).then((r) => j<{ results: PalaceHit[] }>(r)),
    palaceStatus: () => fetch("/api/product/palace").then((r) => j<{ home: string; total: number; wings: Record<string, Record<string, number>> }>(r)),
    productOwners: () => fetch("/api/product-owners").then((r) => j<ProductOwner[]>(r)),
    createProductOwner: (url: string, envId: string, start = true) => post<ProductOwner>("/api/product-owners", { url, envId, start }),
    createEnvProductOwner: (envId: string) => post<ProductOwner>("/api/product-owners", { kind: "env", envId }),
    startProductOwner: (id: string) => post<{ ok: true }>(`/api/product-owners/${id}/start`),
    productOwner: (id: string) => fetch(`/api/product-owners/${id}`).then((r) => j<PoDetail>(r)),
    deleteProductOwner: (id: string) => fetch(`/api/product-owners/${id}`, { method: "DELETE" }).then((r) => j<{ ok: true }>(r)),
    poSend: (id: string, text: string) => post<{ started: true }>(`/api/product-owners/${id}/messages`, { text }),
    poStop: (id: string) => post<{ ok: true }>(`/api/product-owners/${id}/stop`),
    poSetContext: (id: string, text: string) => fetch(`/api/product-owners/${id}/context`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).then((r) => j<{ ok: true }>(r)),
    poSetTickets: (id: string, tickets: PoTicket[]) => fetch(`/api/product-owners/${id}/tickets`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tickets }) }).then((r) => j<{ ok: true }>(r)),
    poFetch: (id: string, url: string) => post<PoArtifact>(`/api/product-owners/${id}/artifacts/fetch`, { url }),
    poPaste: (id: string, title: string, text: string, tell: boolean) => post<PoArtifact>(`/api/product-owners/${id}/artifacts/text`, { title, text, tell }),
    poUpload: (id: string, f: File) => {
        const fd = new FormData();
        fd.append("file", f, f.name);
        return fetch(`/api/product-owners/${id}/artifacts`, { method: "POST", body: fd }).then((r) => j<PoArtifact>(r));
    },
    poRemoveArtifact: (id: string, aid: string) => fetch(`/api/product-owners/${id}/artifacts/${aid}`, { method: "DELETE" }).then((r) => j<{ ok: true }>(r)),
    poFileUrl: (id: string, file: string) => `/api/product-owners/${id}/files/${file.split("/").map(encodeURIComponent).join("/")}`,
    poFileText: (id: string, file: string) => fetch(`/api/product-owners/${id}/files/${file.split("/").map(encodeURIComponent).join("/")}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    poRevision: (id: string, name: string) => fetch(`/api/product-owners/${id}/revisions/${encodeURIComponent(name)}`).then((r) => j<{ text: string }>(r)),
    poApproveDesign: (id: string) => post<{ ok: true }>(`/api/product-owners/${id}/approve-design`),
    poApproveTickets: (id: string) => post<{ created: number; skipped: number }>(`/api/product-owners/${id}/approve-tickets`),
    poAskQuestion: (id: string, q: string, text: string) => post<{ ok: true }>(`/api/product-owners/${id}/questions/${q}/ask`, { text }),
    poConfirmQuestion: (id: string, q: string, resolution?: string) => post<{ ok: true }>(`/api/product-owners/${id}/questions/${q}/confirm`, resolution ? { resolution } : {}),
    poReadEvent: (id: string, eventId: string) => post<{ ok: true }>(`/api/product-owners/${id}/events/${eventId}/read`),
    poSendCorrections: (id: string, ids: string[]) => post<{ ok: true }>(`/api/product-owners/${id}/corrections/send`, { ids }),
    poApplyCorrection: (id: string, cid: string) => post<{ ok: true }>(`/api/product-owners/${id}/corrections/${cid}/apply`),
    poCorrectionsStatus: (id: string, ids: string[], status: "discarded" | "applied") => post<{ ok: true }>(`/api/product-owners/${id}/corrections/status`, { ids, status }),
    poRefreshIssues: (id: string) => post<{ total: number; added: number; changed: number; removed: number; briefed: boolean }>(`/api/product-owners/${id}/refresh-issues`),
    poSetPhase: (id: string, phase: PoPhase) => post<{ ok: true }>(`/api/product-owners/${id}/phase`, { phase }),
    poAcceptProposal: (id: string) => post<{ ok: true }>(`/api/product-owners/${id}/proposal/accept`),
    poRejectProposal: (id: string) => post<{ ok: true }>(`/api/product-owners/${id}/proposal/reject`),
    prFixReplies: (taskId: string) => fetch(`/api/tasks/${taskId}/pr-fix-replies`).then((r) => j<PrFixReplies | null>(r)),
    setPrFixReplies: (taskId: string, replies: Array<{ repo: string; commentId: number; sha: string }>) => fetch(`/api/tasks/${taskId}/pr-fix-replies`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ replies }) }).then((r) => j<PrFixReplies>(r)),
    poBrief: (taskId: string) => fetch(`/api/tasks/${taskId}/po-brief`).then((r) => j<PoReview>(r)),
    startPoBrief: (taskId: string) => post<PoReview>(`/api/tasks/${taskId}/po-brief`),
    poReview: (taskId: string) => fetch(`/api/tasks/${taskId}/po-review`).then((r) => j<PoDesignReview>(r)),
    startPoReview: (taskId: string) => post<PoDesignReview>(`/api/tasks/${taskId}/po-review`),
    patchPoReviewComment: (taskId: string, cid: string, patch: { include?: boolean; note?: string | null }) => fetch(`/api/tasks/${taskId}/po-review/comments/${encodeURIComponent(cid)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then((r) => j<PoDesignReview>(r)),
    askPoReviewComment: (taskId: string, cid: string, text: string) => post<PoDesignReview>(`/api/tasks/${taskId}/po-review/comments/${encodeURIComponent(cid)}/ask`, { text }),
    sendPoReview: (taskId: string) => post<Task>(`/api/tasks/${taskId}/po-review/send`),
    setTaskProductOwner: (taskId: string, productOwnerId: string | null) => fetch(`/api/tasks/${taskId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ productOwnerId }) }).then((r) => j<Task>(r)),
    notion: () => fetch("/api/integrations/notion").then((r) => j<{ configured: boolean; token: string | null }>(r)),
    setNotion: (token: string | null) => fetch("/api/integrations/notion", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).then((r) => j<{ configured: boolean; token: string | null }>(r)),
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
    testAccountClone: (id: string) => post<{ ok: boolean; detail: string }>(`/api/accounts/${id}/clone-test`),
    patchAccount: (id: string, body: { name?: string; failover_enabled?: boolean; failover_threshold?: number; chromeDeviceId?: string | null; chromeCloneQa?: boolean }) =>
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
            qaBrowser?: "chrome" | "gstack"; qaAutoFix?: QaAutoFixScope;
            reviewChecklist?: ReviewChecklist | null;
            cleanupCommand?: string | null; rebaseCommand?: string | null; migrateCommand?: string | null; migrateDownCommand?: string | null; memoryWings?: string[] | null; ciAutopilot?: boolean; testCommand?: string | null; ciAutopilotRules?: AutopilotRules | null; prepareCommand?: string | null; qaSessionCommand?: string | null; dbHostsCommand?: string | null; allowedDbHosts?: string[] | null; taskDb?: TaskDbConfig | null; callbackPorts?: Array<{ port: number; relay: boolean }> | null; checkCommand?: string | null; components?: EnvComponent[]; keepServices?: boolean; prTemplates?: Record<string, string | null>; prDraft?: boolean; dependsOnEnvId?: string | null;
        },
    ) =>
        fetch(`/api/envs/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Env>(r)),
    envRules: (id: string) => fetch(`/api/envs/${id}/rules`).then((r) => j<EnvRules>(r)),
    qaChanges: (taskId: string) => fetch(`/api/tasks/${taskId}/qa-changes`).then((r) => j<{ changes: QaChange[] }>(r)),
    revertQaChange: (taskId: string, changeId: string) => fetch(`/api/tasks/${taskId}/qa-changes/${changeId}/revert`, { method: "POST" }).then((r) => j<{ change: QaChange }>(r)),
    envClaudeMd: (id: string) => fetch(`/api/envs/${id}/claude-md`).then((r) => j<{ files: ClaudeMdFile[] }>(r)),
    saveClaudeMd: (id: string, fileId: string, content: string) =>
        fetch(`/api/envs/${id}/claude-md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fileId, content }) }).then((r) => j<{ file: ClaudeMdFile }>(r)),
    reviewCategories: () => fetch("/api/review-categories").then((r) => j<ReviewCategoryDef[]>(r)),
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
    createTasks: (body: { envId: string; tickets: string[]; mode: "each" | "batch"; accountId?: string; model?: string; notes?: string; baseBranch?: string | Record<string, string>; productOwnerId?: string | null }) => post<{ tasks: Task[] }>("/api/tasks", body),
    // Remote branch names of one repository of an env ("" = the single repo), for the base-branch pickers.
    branches: (envId: string, repo = "") => fetch(`/api/envs/${envId}/branches?repo=${encodeURIComponent(repo)}`).then((r) => j<{ branches: string[] }>(r)),
    labelSuggestions: () => fetch("/api/labels").then((r) => j<Array<TaskLabel & { count: number }>>(r)),
    ciAutopilot: (id: string) => fetch(`/api/tasks/${id}/ci-autopilot`).then((r) => j<CiAutopilot>(r)),
    taskDb: (id: string) => fetch(`/api/tasks/${id}/db`).then((r) => j<TaskDbInfo>(r)),
    recreateTaskDb: (id: string) => post<TaskDbRow>(`/api/tasks/${id}/db/recreate`),
    envDbs: (envId: string, refresh = false) => fetch(`/api/envs/${envId}/dbs${refresh ? "?refresh=1" : ""}`).then((r) => j<EnvDbOverview>(r)),
    refreshTemplate: (envId: string) => post<EnvDbOverview>(`/api/envs/${envId}/dbs/refresh-template`),
    dropEnvDb: (envId: string, name: string) => post<EnvDbOverview>(`/api/envs/${envId}/dbs/drop`, { name }),
    patchTask: (id: string, body: { notes?: string | null; labels?: TaskLabel[]; baseBranch?: string | Record<string, string> | null; files?: SharedFile[]; ciAutopilot?: boolean | null }) =>
        fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Task>(r)),
    returnTo: (id: string, body: { stage: Stage; notes?: string; comments?: LineComment[]; skipQa?: boolean; files?: SharedFile[] }) => post<Task>(`/api/tasks/${id}/return`, body),
    patchPrDraft: (id: string, body: { repo: string; title?: string; body?: string; base?: string }) =>
        fetch(`/api/tasks/${id}/pr-draft`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<PrDraft>(r)),
    cleanup: (id: string, force = false) => post<{ done: string[]; skipped: string[] }>(`/api/tasks/${id}/cleanup${force ? "?force=1" : ""}`),
    deleteTask: (id: string, keepWorktree = false, force = false) =>
        fetch(`/api/tasks/${id}?${new URLSearchParams({ ...(keepWorktree ? { worktree: "keep" } : {}), ...(force ? { force: "1" } : {}) })}`, { method: "DELETE" }).then((r) => j<{ deleted: string }>(r)),
    settings: () => fetch("/api/settings").then((r) => j<Settings>(r)),
    // Fetches the model list from the Models API again; answers like settings().
    refreshModels: () => post<Settings>("/api/models/refresh"),
    usage: (days: number) => fetch(`/api/usage?days=${days}`).then((r) => j<UsageReport>(r)),
    resources: (refresh = false) => fetch(`/api/resources${refresh ? "?refresh=1" : ""}`).then((r) => j<ResourceSnapshot>(r)),
    stopResource: (id: string) => post<{ ok: boolean }>("/api/resources/stop", { id }),
    pinResource: (id: string, pinned: boolean) => post<{ ok: boolean }>("/api/resources/pin", { id, pinned }),
    sweepResources: () => post<{ stopped: number }>("/api/resources/sweep"),
    timing: (days: number) => fetch(`/api/timing?days=${days}`).then((r) => j<TimingReport>(r)),
    taskUsage: (id: string) => fetch(`/api/tasks/${id}/usage`).then((r) => j<TaskUsage>(r)),
    taskSession: (id: string) => fetch(`/api/tasks/${id}/session`).then((r) => j<{ sessionId: string; transcriptMb: number | null; path: string | null; maxMb: number }>(r)),
    rotateSession: (id: string) => post<{ previous: string; next: string; transcriptMb: number | null }>(`/api/tasks/${id}/session/rotate`),
    patchSettings: (body: Partial<Omit<Settings, "models" | "notifications" | "prompter">> & { notifications?: Partial<Notifications>; prompter?: Partial<Omit<PrompterSettings, "seedWings">> }) =>
        fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<{ ok: true }>(r)),
    // Prompter, the in-app assistant.
    prompterStatus: () => fetch("/api/prompter/status").then((r) => j<PrompterStatus>(r)),
    prompterSessions: () => fetch("/api/prompter/sessions").then((r) => j<PrompterSession[]>(r)),
    prompterSeed: () => post<{ ok: boolean; detail: string }>("/api/prompter/seed"),
    prompterDescribe: (path: string) => fetch(`/api/prompter/describe?path=${encodeURIComponent(path)}`).then((r) => j<{ summary: string; context: string }>(r)),
    prompterCreate: (model: string | null) => post<PrompterSession>("/api/prompter/sessions", { model }),
    prompterMessages: (id: string) => fetch(`/api/prompter/sessions/${id}/messages`).then((r) => j<{ session: PrompterSession; busy: boolean; messages: PrompterMessage[] }>(r)),
    prompterSend: (id: string, text: string, path: string, files?: SharedFile[]) => post<{ ok: true; message: PrompterMessage; queued: boolean }>(`/api/prompter/sessions/${id}/messages`, withFiles({ text, path }, files)),
    prompterUploadFiles: uploadPrompterFiles,
    prompterUnqueue: (id: string, messageId: string) => fetch(`/api/prompter/sessions/${id}/messages/${messageId}`, { method: "DELETE" }).then((r) => j<{ ok: true }>(r)),
    prompterPing: (id: string) => post<{ ok: true }>(`/api/prompter/sessions/${id}/ping`),
    prompterStop: (id: string) => post<{ stopped: boolean }>(`/api/prompter/sessions/${id}/stop`),
    prompterClose: (id: string, farewell = true) => fetch(`/api/prompter/sessions/${id}?farewell=${farewell ? 1 : 0}`, { method: "DELETE", keepalive: true }).then((r) => j<{ ok: true }>(r)),
    restartServer: (force = false) => post<{ ok: boolean; detail: string }>("/api/server/restart", { force }),
    testNotification: () => post<{ macos: boolean; ntfy: boolean | null; error?: string }>("/api/notifications/test"),
    testJev: () => post<{ ok: true; model: string; ms: number; inputTokens: number; summary: string } | { ok: false; error: string }>("/api/jev/test"),
    review: (id: string, body: { verdict: "approve" | "changes"; repo?: string; routeTo?: "implementation" | "design_proposal"; notes?: string; comments?: LineComment[]; skipQa?: boolean; files?: SharedFile[] }) =>
        post<Task>(`/api/tasks/${id}/review`, body),
    // filter: a set of commit shas (contiguous runs become one group each) or "uncommitted"; none = everything vs the base.
    // `file`: only that path, with its hunks even when it would normally be collapsed.
    diff: (id: string, filter?: { shas: string[] } | { uncommitted: true }, file?: string) =>
        fetch(`/api/tasks/${id}/diff?${diffQuery(filter, file)}`).then((r) => j<DiffResponse>(r)),
    commits: (id: string) => fetch(`/api/tasks/${id}/commits`).then((r) => j<{ commits: BranchCommit[]; uncommitted: boolean; dirty?: string[] }>(r)),
    // Reword resolves once the (fast, conflict-free) rewrite is done. Remove only resolves once the agent run has
    // *started* — it can take a while and may hit conflicts; the outcome lands in Chat.
    rewordCommit: (id: string, sha: string, repo: string, message: string) => post<{ newSha: string }>(`/api/tasks/${id}/commits/${sha}/reword`, { repo, message }),
    removeCommit: (id: string, sha: string, repo: string, note?: string, files?: SharedFile[]) => post<{ started: true }>(`/api/tasks/${id}/commits/${sha}/remove`, withFiles({ repo, ...(note ? { note } : {}) }, files)),
    forcePush: (id: string, repo: string, force = false) => post<{ ok: true; result: string }>(`/api/tasks/${id}/commits/force-push`, { repo, force }),
    prComments: (id: string, repo: string) => fetch(`/api/tasks/${id}/pr-comments?repo=${encodeURIComponent(repo)}`).then((r) => j<PrComments | null>(r)),
    resolvePrComment: (id: string, repo: string, commentId: number, resolved: boolean) => post<PrComments | null>(`/api/tasks/${id}/pr-comments/${commentId}/resolve`, { repo, resolved }),
    myTickets: (envId: string) => fetch(`/api/envs/${envId}/my-tickets`).then((r) => j<{ source: "clickup" | "linear"; tickets: MyTicket[]; error?: string }>(r)),
    stop: (id: string) => post<Task>(`/api/tasks/${id}/stop`),
    retry: (id: string) => post<Task>(`/api/tasks/${id}/retry`),
    rerun: (id: string, stage: Stage) => post<Task>(`/api/tasks/${id}/rerun`, { stage }),
    skipManualQa: (id: string) => post<Task>(`/api/tasks/${id}/skip-manual-qa`),
    qaLogin: (id: string) => post<{ started: true }>(`/api/tasks/${id}/qa-login`),
    relaunchChrome: (id: string) => post<Task>(`/api/tasks/${id}/relaunch-chrome`),
    fixCi: (id: string, repo: string) => post<{ started: true }>(`/api/tasks/${id}/fix-ci`, { repo }),
    // `repos`: only these repository directories; omitted = every repository of the task.
    rebase: (id: string, repos?: string[]) => post<{ started: true }>(`/api/tasks/${id}/rebase`, repos?.length ? { repos } : {}),
    refreshPr: (id: string) => post<{ task: Task; prStates: PrState[] }>(`/api/tasks/${id}/pr/refresh`),
    createApprovedPrs: (id: string) => post<{ ok: true; done: string[]; task: Task; prStates: PrState[] }>(`/api/tasks/${id}/pr/create`),
    mergePr: (id: string, body: { repo: string; method: MergeMethod; deleteBranch: boolean }) => post<{ ok: true; result: string; task: Task }>(`/api/tasks/${id}/pr/merge`, body),
    fixComments: (id: string, repo: string, commentIds: number[]) => post<{ started: true }>(`/api/tasks/${id}/fix-comments`, { repo, commentIds }),
    // Line comments left on Code changes at a PR stage → a PR-fix round (nothing posted to GitHub).
    fixLocalComments: (id: string, body: { notes?: string; comments: LineComment[] }) => post<{ started: true }>(`/api/tasks/${id}/fix-local-comments`, body),
    // The agent's take on picked comments, answered in Chat — nothing committed, no PR round.
    askComments: (id: string, repo: string, commentIds: number[], question?: string) => post<Message>(`/api/tasks/${id}/ask-comments`, { repo, commentIds, ...(question ? { question } : {}) }),
    // Batched PR jobs in one agent run (rebase first, then failing CI, picked comments, instructions).
    prJobs: (id: string, spec: { rebase?: { repos?: string[] } | null; fixCi?: { repos?: string[] } | null; comments?: Array<{ repo: string; ids: number[] }>; instructions?: string; files?: SharedFile[] }) =>
        post<{ started: boolean; note: string }>(`/api/tasks/${id}/pr-jobs`, spec),
    fetchTicket: (id: string) => post<Ticket>(`/api/tasks/${id}/fetch-ticket`),
    openApp: (id: string) => post<{ opened: string; profile: string }>(`/api/tasks/${id}/open-app`),
    pin: (id: string) => post<Task>(`/api/tasks/${id}/pin`),
    setAccount: (id: string, accountId: string) => post<Task>(`/api/tasks/${id}/account`, { accountId }),
    terminal: (id: string) => post<{ terminal: string }>(`/api/tasks/${id}/terminal`),
    services: (id: string) => fetch(`/api/tasks/${id}/services`).then((r) => j<Service[]>(r)),
    startService: (id: string, kind: string) => post<Service>(`/api/tasks/${id}/services/${kind}/start`),
    stopService: (id: string, kind: string) => post<Service[]>(`/api/tasks/${id}/services/${kind}/stop`),
    serviceLog: (id: string, kind: string, lines = 120) => fetch(`/api/tasks/${id}/services/${kind}/log?lines=${lines}`).then((r) => r.text()),
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
    sessionDiff: (id: string, filter?: { shas: string[] } | { uncommitted: true }, file?: string) =>
        fetch(`/api/sessions/${id}/diff?${diffQuery(filter, file)}`).then((r) => j<DiffResponse>(r)),
    sessionCommits: (id: string) => fetch(`/api/sessions/${id}/commits`).then((r) => j<{ commits: BranchCommit[]; uncommitted: boolean; dirty?: string[] }>(r)),
    artifactUrl: (id: string, rel: string) => `/api/tasks/${id}/artifacts/${rel}`,
    messages: (id: string) => fetch(`/api/tasks/${id}/messages`).then((r) => j<Message[]>(r)),
    uploadFiles,
    answerQuestions: (id: string, roundId: string, answers: Record<string, string>, files?: SharedFile[]) => post<Task>(`/api/tasks/${id}/questions/${roundId}/answer`, withFiles({ answers }, files)),
    // With an anchor the question is about one diff line; the reply carries the same anchor (a thread under that line).
    sendMessage: (id: string, text: string, anchor?: MessageAnchor, files?: SharedFile[]) => post<Message>(`/api/tasks/${id}/messages`, withFiles({ text, ...(anchor ? { anchor } : {}) }, files)),
    // Chat → Do: returns the human's message at once; the agent's report arrives as a later message when the run ends.
    instruct: (id: string, text: string, files?: SharedFile[]) => post<Message>(`/api/tasks/${id}/instructions`, withFiles({ text }, files)),
};

// A CircleCI job gated behind a manual "Approve" click (deploy/db-reset gates) sits pending forever until a human
// clicks through — it is not CI verifying the change, so it must not count against "checks passed" or block PR Green.
// Mirrors server/src/engine.ts's isApprovalGateCheck.
export const isApprovalGateCheck = (c: { name?: string; context?: string }): boolean => /_hold$|reset_.*_db$/i.test(c.name ?? c.context ?? "");

export const STAGE_LABEL: Record<Stage, string> = {
    research: "Research", design_proposal: "Design Proposal", qa_baseline: "QA baseline", implementation: "Implementation",
    code_review: "Code Review", manual_qa: "Manual QA", user_review: "User Review", pr_creation_review: "PR Creation Review", pr_waiting: "PR Waiting",
    pr_fix: "PR Fix", pr_green: "PR Green", pr_approved: "PR Approved", done: "Done",
};
export const STAGE_ORDER: Stage[] = [
    "research", "design_proposal", "qa_baseline", "implementation", "code_review", "manual_qa", "user_review",
    "pr_creation_review", "pr_waiting", "pr_fix", "pr_green", "pr_approved", "done",
];
