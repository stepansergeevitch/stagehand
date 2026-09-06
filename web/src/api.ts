export type Stage =
    | "research" | "design_proposal" | "qa_baseline" | "implementation" | "manual_qa" | "user_review"
    | "pr_creation_review" | "pr_waiting" | "pr_red" | "pr_green" | "pr_approved" | "done";

export type TaskStatus = "idle" | "queued" | "running" | "waiting_user" | "blocked" | "rate_limited" | "failed" | "done" | "stopped";

export interface Account {
    id: string; name: string; config_dir: string; email: string | null; org: string | null; plan: string | null;
    logged_in: number; chrome_capable: number | null; failover_enabled: number; failover_threshold: number;
    limits: Array<{ window: string; utilization: number; resetsAt: number }>;
}
export interface Env {
    id: string; name: string; path: string; base_branch: string; default_account_id: string | null; app_url: string | null; qa_script: string | null;
    be_command: string | null; fe_command: string | null; be_url_template: string | null; fe_url_template: string | null; be_port: number | null; fe_port: number | null;
    setup_command: string | null; repos: string | null; branch_prefix: string | null; ticket_source: "clickup" | "linear"; env_vars: string | null;
}
export interface Settings {
    clickupToken: string | null; clickupTeamId: string | null; linearApiKey: string | null;
    defaultModel: string | null; models: Array<{ value: string; label: string }>;
}
export interface Ticket {
    source: "clickup" | "linear"; id: string; url: string | null; title: string; status: string | null; description: string;
    acceptanceCriteria: string[]; parent: { id: string; title: string; description: string } | null; fetchedVia: "rest" | "mcp";
}
export interface Service { id: string; task_id: string; kind: "be" | "fe"; port: number; url: string; tmux: string; command: string; log_path: string; started_at: string; running: boolean }
export interface Task {
    id: string; env_id: string; ticket_id: string; title: string | null; source: "clickup" | "linear"; ticket_url: string | null; model: string | null; session_id: string; account_id: string | null;
    branch: string | null; worktree_path: string | null; stage: Stage; status: TaskStatus; status_line: string | null;
    pinned: number; created_at: string; updated_at: string;
}
export interface Run {
    id: string; task_id: string; stage: Stage; kind: string; status: string; account_id: string; started_at: string | null;
    finished_at: string | null; resume_at: string | null; error: string | null; result_json: string | null; cost_usd: number | null;
    num_turns: number | null; last_event: string | null; attempt: number;
}
export interface QaStep { action: string; assert: string; shot: boolean }
export interface QaScenario { id: string; title: string; url: string; persona: string; steps: QaStep[] }
export interface Design {
    classification: "bug" | "feature"; scope: { inScope: string[]; outOfScope: string[] };
    plan: Array<{ layer: string; changes: string[] }>; testPlan: Array<{ file: string; cases: string[] }>;
    qa: QaScenario[]; qaSkippedReason: string | null;
}
export interface QaPass {
    pass: "before" | "after";
    scenarios: Array<{ id: string; outcome: "pass" | "fail" | "blocked"; observation: string; shots: Array<{ step: number; file: string }> }>;
    blockers: string[];
}
export interface Impl {
    files: string[]; commits: string[]; tests: { backend: string | null; frontend: string | null };
    coverageNewLines: number | null; gates: { tests: boolean; typecheck: boolean }; notes: string;
}
export interface DiffLine { type: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number; deletions: number; hunks: DiffHunk[]; binary: boolean }
export interface LineComment { path: string; line: number; side: "new" | "old"; snippet: string; text: string }
export interface Review { id: string; stage: Stage; verdict: string; route_to: string | null; notes: string | null; comments: string | null; created_at: string }
export interface TaskDetail {
    task: Task; runs: Run[]; artifacts: Array<{ path: string; size: number }>;
    research: { classification: string; title: string; branchName: string; summary: string; affectedAreas: string[] } | null;
    design: Design | null; impl: Impl | null; qaBefore: QaPass | null; qaAfter: QaPass | null;
    pr: { title: string; body: string; base: string } | null;
    ticket: Ticket | null;
    reviews: Review[];
}

const j = async <T,>(res: Response): Promise<T> => {
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body;
};
const post = <T,>(url: string, body?: unknown): Promise<T> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => j<T>(r));

export const api = {
    accounts: () => fetch("/api/accounts").then((r) => j<Account[]>(r)),
    addAccount: (name: string, email?: string) => post<{ account: Account; terminal: string | null }>("/api/accounts", { name, email }),
    refreshAccount: (id: string, probe: boolean) => post<Account>(`/api/accounts/${id}/refresh?probe=${probe ? 1 : 0}`),
    loginAccount: (id: string) => post<{ terminal: string }>(`/api/accounts/${id}/login`),
    patchAccount: (id: string, body: { failover_enabled?: boolean; failover_threshold?: number }) =>
        fetch(`/api/accounts/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Account>(r)),
    envs: () => fetch("/api/envs").then((r) => j<Env[]>(r)),
    addEnv: (body: {
        name: string; path: string; baseBranch: string; defaultAccountId?: string; appUrl?: string; qaScript?: string;
        repos?: string[]; branchPrefix?: string; ticketSource: "clickup" | "linear"; envVars?: string;
    }) => post<Env>("/api/envs", body),
    patchEnv: (
        id: string,
        body: {
            name?: string; baseBranch?: string; defaultAccountId?: string | null; appUrl?: string | null; qaScript?: string | null;
            beCommand?: string | null; feCommand?: string | null; beUrlTemplate?: string | null; feUrlTemplate?: string | null; bePort?: number | null; fePort?: number | null;
            setupCommand?: string | null; repos?: string[] | null; branchPrefix?: string | null; ticketSource?: "clickup" | "linear"; envVars?: string | null;
        },
    ) =>
        fetch(`/api/envs/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<Env>(r)),
    tasks: (envId?: string) => fetch(`/api/tasks${envId ? `?env=${envId}` : ""}`).then((r) => j<Task[]>(r)),
    task: (id: string) => fetch(`/api/tasks/${id}`).then((r) => j<TaskDetail>(r)),
    createTask: (envId: string, ticket: string, accountId?: string, model?: string) => post<Task>("/api/tasks", { envId, ticket, accountId, model }),
    settings: () => fetch("/api/settings").then((r) => j<Settings>(r)),
    patchSettings: (body: Partial<Omit<Settings, "models">>) =>
        fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<{ ok: true }>(r)),
    review: (id: string, body: { verdict: "approve" | "changes"; routeTo?: "implementation" | "design_proposal"; notes?: string; comments?: LineComment[] }) =>
        post<Task>(`/api/tasks/${id}/review`, body),
    diff: (id: string) => fetch(`/api/tasks/${id}/diff`).then((r) => j<{ base: string; files: DiffFile[] }>(r)),
    stop: (id: string) => post<Task>(`/api/tasks/${id}/stop`),
    retry: (id: string) => post<Task>(`/api/tasks/${id}/retry`),
    rerun: (id: string, stage: Stage) => post<Task>(`/api/tasks/${id}/rerun`, { stage }),
    qaLogin: (id: string) => post<{ started: true }>(`/api/tasks/${id}/qa-login`),
    pin: (id: string) => post<Task>(`/api/tasks/${id}/pin`),
    setAccount: (id: string, accountId: string) => post<Task>(`/api/tasks/${id}/account`, { accountId }),
    terminal: (id: string) => post<{ terminal: string }>(`/api/tasks/${id}/terminal`),
    services: (id: string) => fetch(`/api/tasks/${id}/services`).then((r) => j<Service[]>(r)),
    startService: (id: string, kind: "be" | "fe") => post<Service>(`/api/tasks/${id}/services/${kind}/start`),
    stopService: (id: string, kind: "be" | "fe") => post<Service[]>(`/api/tasks/${id}/services/${kind}/stop`),
    serviceLog: (id: string, kind: "be" | "fe", lines = 120) => fetch(`/api/tasks/${id}/services/${kind}/log?lines=${lines}`).then((r) => r.text()),
    artifactUrl: (id: string, rel: string) => `/api/tasks/${id}/artifacts/${rel}`,
};

export const STAGE_LABEL: Record<Stage, string> = {
    research: "Research", design_proposal: "Design Proposal", qa_baseline: "QA baseline", implementation: "Implementation",
    manual_qa: "Manual QA", user_review: "User Review", pr_creation_review: "PR Creation Review", pr_waiting: "PR Waiting",
    pr_red: "PR Red", pr_green: "PR Green", pr_approved: "PR Approved", done: "Done",
};
export const STAGE_ORDER: Stage[] = [
    "research", "design_proposal", "qa_baseline", "implementation", "manual_qa", "user_review",
    "pr_creation_review", "pr_waiting", "pr_red", "pr_green", "pr_approved", "done",
];
