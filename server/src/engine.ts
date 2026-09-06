import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { now, parseEnvVars, type AccountRow, type DB, type EnvRow, type RunRow, type Stage, type TaskRow, type TaskStatus } from "./db.js";
import { startClaude, type ActivityEvent, type ClaudeRun, type RateLimitInfo, type RunOutcome } from "./claude/runner.js";
import { createWorktree, envRepos, removeWorktreeAndBranch, repoPaths, runWorktreeSetup, worktreeDiff, type DiffFile } from "./git.js";
import type { Services } from "./services.js";
import { fetchTicket, parseTicketRef, renderTicketForPrompt, Ticket } from "./tickets.js";
import { STAGE_DEFS, renderPrompt, type StageDef } from "./stages/registry.js";
import { DesignResult, QaPassResult, ResearchResult, type QaScenario } from "./stages/contracts.js";

// A comment anchored to one line of the review diff. `line` is the new-file line for add/context lines, the old-file line for deletions.
export interface LineComment {
    path: string;
    line: number;
    side: "new" | "old";
    snippet: string;
    text: string;
}

export interface ReviewInput {
    verdict: "approve" | "changes";
    routeTo?: "implementation" | "design_proposal" | undefined;
    notes?: string | undefined;
    comments?: LineComment[] | undefined;
}

// What the implementer sees: the general notes, then every line comment with its anchor and the quoted line.
const renderReviewNotes = (round: number, notes: string | undefined, comments: LineComment[]): string => {
    const parts: string[] = [`## Reviewer notes — review round ${round} (address every point)`];
    if (notes?.trim()) parts.push(notes.trim());
    if (comments.length) {
        parts.push("### Line comments (path:line refer to the current diff against the base branch; the quoted text is the line as it is now)");
        for (const c of comments) parts.push(`- \`${c.path}:${c.line}\` (${c.side === "old" ? "removed line" : "line"}) — \`${c.snippet.trim().slice(0, 160)}\`\n  → ${c.text.trim()}`);
    }
    parts.push("When done, list in impl.json `notes` each reviewer point and how you resolved it (or why not).");
    return parts.join("\n\n");
};

interface DispatchOpts {
    notes?: string;
    attempt?: number;
    extraVars?: Record<string, string>;
    servicesReady?: boolean;
}

const FIVE_HOUR = "five_hour";

// One paragraph for prompts: where the code lives and how the worktree is laid out.
const describeRepoLayout = (env: EnvRow, worktree: string | null): string => {
    const subs = envRepos(env);
    if (subs.length === 0) return `The project is a single git repository at ${env.path} (base branch \`${env.base_branch}\`).`;
    const list = subs.map((d) => `\`${d}/\``).join(", ");
    const wt = worktree ? ` The task worktree ${worktree} mirrors this layout: each of ${list} inside it is a separate checkout of the task branch.` : "";
    return `The project is a workspace at ${env.path} made of separate git repositories in ${list} (base branch \`${env.base_branch}\` in each); the workspace root itself is NOT a git repository — run git commands inside the repository directory you are changing.${wt}`;
};

export class Engine extends EventEmitter {
    private readonly active = new Map<string, ClaudeRun>();
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly db: DB,
        private readonly cfg: Config,
        private readonly services: Services,
    ) {
        super();
    }

    // ---------- lifecycle ----------

    startScheduler(): void {
        this.timer = setInterval(() => this.tick(), 15_000);
        this.recoverInterrupted();
    }

    stopScheduler(): void {
        if (this.timer) clearInterval(this.timer);
        for (const run of this.active.values()) run.kill();
    }

    private recoverInterrupted(): void {
        const stale = this.db.prepare(`SELECT * FROM runs WHERE status = 'running'`).all() as RunRow[];
        for (const run of stale) {
            // The claude child may have finished its work before the restart; if the stage's output already validates, complete it from disk.
            if (this.completeFromDisk(run.task_id, run.id, run.stage)) continue;
            this.db.prepare(`UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run("server restarted mid-run", now(), run.id);
            this.setTaskStatus(run.task_id, "failed", "run interrupted by server restart — retry to resume");
        }
        // Tasks still in the ticket-fetch phase have no run row; the fetch child died with the server.
        const fetching = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running'`).all() as TaskRow[];
        for (const t of fetching) {
            const active = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status = 'running'`).get(t.id) as { n: number };
            if (active.n === 0) this.setTaskStatus(t.id, "failed", "ticket fetch interrupted by server restart — retry");
        }
    }

    private fetchTicketThenResearch(taskId: string): void {
        const task = this.getTask(taskId);
        if (!task) return;
        const env = this.env(task.env_id);
        const ref = { source: task.source as "clickup" | "linear", id: task.ticket_id, url: task.ticket_url };
        const account = this.pickAccount(task, STAGE_DEFS.research);
        this.setTaskStatus(taskId, "running", "fetching ticket");
        void fetchTicket(ref, this.cfg, account?.config_dir ?? this.cfg.mainConfigDir, env.path, this.taskDir(taskId), parseEnvVars(env.env_vars))
            .then((ticket) => {
                this.db.prepare(`UPDATE tasks SET title = ?, ticket_url = COALESCE(ticket_url, ?), updated_at = ? WHERE id = ?`).run(ticket.title, ticket.url, now(), taskId);
                this.dispatch(taskId, "research");
            })
            .catch((e: unknown) => {
                const reason = String((e as Error).message ?? e).slice(0, 200);
                this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`ticket fetch failed (${reason}) — research will try the MCP itself`, now(), taskId);
                this.dispatch(taskId, "research");
            });
    }

    private completeFromDisk(taskId: string, runId: string, stage: Stage): boolean {
        const def = STAGE_DEFS[stage];
        if (!def.contract || !def.outputFile) return false;
        const validation = this.validateOutput(taskId, def);
        if (!validation.ok) return false;
        this.db
            .prepare(`UPDATE runs SET status = 'done', finished_at = COALESCE(finished_at, ?), error = NULL, result_json = ? WHERE id = ?`)
            .run(now(), JSON.stringify(validation.data), runId);
        this.afterStage(taskId, def, validation.data);
        return true;
    }

    private tick(): void {
        const due = this.db
            .prepare(`SELECT * FROM tasks WHERE status IN ('rate_limited', 'queued')`)
            .all() as TaskRow[];
        for (const task of due) {
            const run = this.latestRun(task.id);
            if (task.status === "rate_limited" && run?.resume_at && new Date(run.resume_at).getTime() > Date.now()) continue;
            this.dispatch(task.id, task.stage, { notes: "You were interrupted (rate limit or queue). Continue from the current state of the task directory; do not redo finished work." });
        }
    }

    // ---------- queries ----------

    taskDir(taskId: string): string {
        const dir = join(this.cfg.dataDir, "tasks", taskId);
        mkdirSync(join(dir, "qa"), { recursive: true });
        return dir;
    }

    getTask(id: string): TaskRow | undefined {
        return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    }

    listTasks(envId?: string): TaskRow[] {
        return envId
            ? (this.db.prepare(`SELECT * FROM tasks WHERE env_id = ? ORDER BY pinned DESC, updated_at DESC`).all(envId) as TaskRow[])
            : (this.db.prepare(`SELECT * FROM tasks ORDER BY pinned DESC, updated_at DESC`).all() as TaskRow[]);
    }

    listRuns(taskId: string): RunRow[] {
        return this.db.prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at`).all(taskId) as RunRow[];
    }

    latestRun(taskId: string): RunRow | undefined {
        return this.db.prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`).get(taskId) as RunRow | undefined;
    }

    artifacts(taskId: string): Array<{ path: string; size: number }> {
        const dir = this.taskDir(taskId);
        const out: Array<{ path: string; size: number }> = [];
        const walk = (d: string): void => {
            for (const name of readdirSync(d)) {
                const full = join(d, name);
                const st = statSync(full);
                if (st.isDirectory()) walk(full);
                else out.push({ path: relative(dir, full), size: st.size });
            }
        };
        walk(dir);
        return out;
    }

    readArtifactJson<T>(taskId: string, rel: string): T | null {
        const p = join(this.taskDir(taskId), rel);
        if (!existsSync(p)) return null;
        try {
            return JSON.parse(readFileSync(p, "utf8")) as T;
        } catch {
            return null;
        }
    }

    private env(id: string): EnvRow {
        const row = this.db.prepare(`SELECT * FROM envs WHERE id = ?`).get(id) as EnvRow | undefined;
        if (!row) throw new Error(`env ${id} not found`);
        return row;
    }

    private account(id: string): AccountRow | undefined {
        return this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
    }

    private utilization(accountId: string, window = FIVE_HOUR): { utilization: number; resetsAt: number } | null {
        const row = this.db.prepare(`SELECT utilization, resets_at FROM rate_limits WHERE account_id = ? AND window = ?`).get(accountId, window) as
            | { utilization: number; resets_at: number }
            | undefined;
        if (!row) return null;
        if (row.resets_at * 1000 < Date.now()) return { utilization: 0, resetsAt: row.resets_at };
        return { utilization: row.utilization, resetsAt: row.resets_at };
    }

    // ---------- task creation ----------

    createTask(envId: string, ticketInput: string, accountId?: string, model?: string): TaskRow {
        const env = this.env(envId);
        const ref = parseTicketRef(ticketInput, env.ticket_source);
        const id = randomUUID();
        const sessionId = randomUUID();
        const ts = now();
        this.db
            .prepare(
                `INSERT INTO tasks (id, env_id, ticket_id, source, ticket_url, model, session_id, account_id, stage, status, status_line, pinned, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'research', 'running', 'fetching ticket', 0, ?, ?)`,
            )
            .run(id, env.id, ref.id, ref.source, ref.url, model ?? this.cfg.defaultModel, sessionId, accountId ?? env.default_account_id, ts, ts);
        this.taskDir(id);
        const task = this.getTask(id)!;
        this.emit("task", task);
        this.fetchTicketThenResearch(id);
        return task;
    }

    // ---------- control ----------

    stop(taskId: string): void {
        const run = this.latestRun(taskId);
        if (run) this.active.get(run.id)?.kill();
        this.setTaskStatus(taskId, "stopped", "stopped by user");
    }

    retry(taskId: string): void {
        const task = this.getTask(taskId);
        if (!task) return;
        // A blocked stage (auth, app down, bridge) has a valid-but-useless output file; it must run again, not be "completed from disk".
        if (task.status === "blocked") {
            this.rerun(taskId, task.stage);
            return;
        }
        if (task.stage === "research" && !existsSync(join(this.taskDir(taskId), "ticket.json")) && !this.latestRun(taskId)) {
            this.fetchTicketThenResearch(taskId);
            return;
        }
        const last = this.latestRun(taskId);
        if (last && last.stage === task.stage && this.completeFromDisk(taskId, last.id, task.stage)) return;
        this.dispatch(taskId, task.stage, { notes: "Previous attempt did not complete. Continue from the current state of the task directory." });
    }

    // Opens the app in the automation Chrome profile and waits for a human to log in there. The profile persists,
    // so this is needed once per app session lifetime (core: 365 days; deal: the Auth0 tenant's session).
    async qaLogin(taskId: string): Promise<"logged_in" | "timeout" | "failed"> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const env = this.env(task.env_id);
        const account = this.pickAccount(task, STAGE_DEFS.manual_qa);
        if (!account) throw new Error("no account with Chrome connected");
        const be = this.services.get(taskId, "be");
        const fe = this.services.get(taskId, "fe");
        const appUrl = (env.app_url ?? (fe ? "{{feUrl}}" : "https://localhost:3000")).replace(/\{\{feUrl\}\}/g, fe?.url ?? "").replace(/\{\{beUrl\}\}/g, be?.url ?? "");
        this.setTaskStatus(taskId, "blocked", "waiting for you to log in in the automation Chrome window");
        // One turn to open the page, ONE Bash loop to wait (osascript reads the live tab titles/URLs) — not a model turn per poll.
        const prompt =
            `Load the browser tools with one ToolSearch (tabs_context_mcp, tabs_create_mcp, navigate). Create a new tab and navigate to ${appUrl}/. ` +
            `A human will log in in this window — you must NOT type any credentials. Then run this single Bash command and wait for it (it brings Chrome to the front and polls the tab titles for up to 10 minutes):\n` +
            `osascript -e 'tell application "Google Chrome" to activate'; for i in $(seq 1 60); do t=$(osascript -e 'tell application "Google Chrome" to get {title, URL} of active tab of front window' 2>/dev/null); ` +
            // Origin-override hack (deal alt-port): Auth0 sends the browser back to the allowed origin; re-open the same query on the real app URL.
            `case "$t" in *auth0.com*|*"Welcome"*|*"Log in"*|*"Sign in"*|*"login"*) sleep 10;; *"${appUrl}"*) echo LOGGED_IN; exit 0;; ` +
            `*"localhost:3000/?code="*) u=$(osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'); q=\${u#*localhost:3000/}; osascript -e "tell application \\"Google Chrome\\" to set URL of active tab of front window to \\"${appUrl}/$q\\""; sleep 8;; ` +
            `*) sleep 10;; esac; done; echo TIMEOUT\n` +
            `Reply with exactly one line: LOGGED_IN if the command printed LOGGED_IN, TIMEOUT if it printed TIMEOUT, or FAILED <reason> if the browser tools or the command did not work.`;
        const run = startClaude({
            prompt,
            cwd: task.worktree_path ?? env.path,
            configDir: account.config_dir,
            extraEnv: parseEnvVars(env.env_vars),
            chrome: true,
            maxTurns: 12,
            model: this.cfg.stageModels.helper ?? "sonnet",
            allowedTools: ["Bash"],
        });
        const outcome = await run.done;
        const text = outcome.result?.result ?? "";
        if (/LOGGED_IN/.test(text)) {
            this.setTaskStatus(taskId, "idle", "logged in — re-running the blocked stage");
            this.rerun(taskId, task.stage);
            return "logged_in";
        }
        this.setTaskStatus(taskId, "blocked", /TIMEOUT/.test(text) ? "login window timed out — click Log in for QA again" : `login helper failed: ${text.slice(0, 120)}`);
        return /TIMEOUT/.test(text) ? "timeout" : "failed";
    }

    rerun(taskId: string, stage: Stage): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        const def = STAGE_DEFS[stage];
        if (!def.prompt) throw new Error(`${def.label} has nothing to run`);
        if (def.outputFile) {
            const p = join(this.taskDir(taskId), def.outputFile);
            if (existsSync(p)) renameSync(p, `${p}.prev-${Date.now()}`);
        }
        this.setStage(taskId, stage);
        this.dispatch(taskId, stage, { notes: "This stage is being re-run on request. Do the work again from scratch for this stage; earlier stages' outputs in the task directory are still valid." });
    }

    async deleteTask(taskId: string, removeWorktree: boolean): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) return;
        const run = this.latestRun(taskId);
        if (run) this.active.get(run.id)?.kill();
        if (removeWorktree && task.worktree_path && task.branch) {
            const env = this.env(task.env_id);
            await removeWorktreeAndBranch(env, task.worktree_path, task.branch, parseEnvVars(env.env_vars)).catch(() => undefined);
        }
        rmSync(this.taskDir(taskId), { recursive: true, force: true });
        this.db.prepare(`DELETE FROM reviews WHERE task_id = ?`).run(taskId);
        this.db.prepare(`DELETE FROM pr_state WHERE task_id = ?`).run(taskId);
        this.db.prepare(`DELETE FROM runs WHERE task_id = ?`).run(taskId);
        this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
        this.emit("task", { ...task, status: "deleted" });
    }

    // Everything the task changed so far, for the review diff view.
    async diff(taskId: string): Promise<DiffFile[]> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path) return [];
        const env = this.env(task.env_id);
        return worktreeDiff(env, task.worktree_path, parseEnvVars(env.env_vars));
    }

    setAccount(taskId: string, accountId: string): void {
        this.db.prepare(`UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?`).run(accountId, now(), taskId);
        this.emit("task", this.getTask(taskId));
    }

    review(taskId: string, input: ReviewInput): void {
        const task = this.getTask(taskId);
        if (!task || task.status !== "waiting_user") throw new Error("task is not waiting for review");
        const comments = input.comments ?? [];
        const prior = this.db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND stage = ? AND verdict = 'changes'`).get(taskId, task.stage) as { n: number };
        this.db
            .prepare(`INSERT INTO reviews (id, task_id, stage, verdict, route_to, notes, comments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), taskId, task.stage, input.verdict, input.routeTo ?? null, input.notes ?? null, comments.length ? JSON.stringify(comments) : null, now());

        if (input.verdict === "changes") {
            const target: Stage = task.stage === "design_proposal" ? "design_proposal" : (input.routeTo ?? "implementation");
            this.setStage(taskId, target);
            const hasContent = !!input.notes?.trim() || comments.length > 0;
            this.dispatch(taskId, target, {
                notes: hasContent ? renderReviewNotes(prior.n + 1, input.notes, comments) : "The reviewer requested changes without notes; re-examine the work and improve it.",
            });
            return;
        }
        const next = STAGE_DEFS[task.stage].next;
        if (!next) return;
        this.advance(taskId, next);
    }

    // ---------- stage machine ----------

    private setStage(taskId: string, stage: Stage): void {
        this.db.prepare(`UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?`).run(stage, now(), taskId);
    }

    private setTaskStatus(taskId: string, status: TaskStatus, line?: string): void {
        this.db
            .prepare(`UPDATE tasks SET status = ?, status_line = COALESCE(?, status_line), updated_at = ? WHERE id = ?`)
            .run(status, line ?? null, now(), taskId);
        this.emit("task", this.getTask(taskId));
    }

    private advance(taskId: string, stage: Stage): void {
        const task = this.getTask(taskId)!;
        let target = stage;
        if (target === "qa_baseline" || target === "manual_qa") {
            const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
            if (!design || design.qa.length === 0) target = target === "qa_baseline" ? "implementation" : "user_review";
        }
        this.setStage(taskId, target);
        const def = STAGE_DEFS[target];
        if (def.kind === "terminal") {
            this.setTaskStatus(taskId, "done", "merged");
            return;
        }
        if (def.kind === "poll") {
            this.setTaskStatus(taskId, "idle", `${def.label} · waiting for GitHub`);
            return;
        }
        if (def.kind === "wait" && !def.prompt) {
            this.setTaskStatus(taskId, "waiting_user", `${def.label} · needs you`);
            return;
        }
        void task;
        this.dispatch(taskId, target);
    }

    private pickAccount(task: TaskRow, def: StageDef): AccountRow | null {
        const all = this.db.prepare(`SELECT * FROM accounts WHERE logged_in = 1`).all() as AccountRow[];
        const preferred = task.account_id ? this.account(task.account_id) : undefined;
        if (def.chrome) {
            if (preferred?.chrome_capable) return preferred;
            return all.find((a) => a.chrome_capable) ?? null;
        }
        return preferred ?? all[0] ?? null;
    }

    private runningCount(accountId: string): number {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE account_id = ? AND status = 'running'`).get(accountId) as { n: number };
        return row.n;
    }

    private promptVars(task: TaskRow, def: StageDef, opts: DispatchOpts): Record<string, string> {
        const env = this.env(task.env_id);
        const taskDir = this.taskDir(task.id);
        const ticketRaw = this.readArtifactJson<unknown>(task.id, "ticket.json");
        const ticketParsed = ticketRaw ? Ticket.safeParse(ticketRaw) : null;
        const vars: Record<string, string> = {
            ticketId: task.ticket_id,
            ticketIdUpper: task.ticket_id.toUpperCase(),
            ticketSource: task.source,
            ticketUrl: task.ticket_url ?? "",
            ticket: ticketParsed?.success
                ? renderTicketForPrompt(ticketParsed.data)
                : `(Stagehand could not fetch the ticket server-side. Fetch ${task.source} ticket ${task.ticket_id} yourself with the ${task.source} MCP tool — for ClickUp: mcp__clickup__clickup_get_task with detail_level "detailed", and its parent if any. If that fails too, write the output file with classification "feature", title "TICKET FETCH FAILED" and the error in summary.)`,
            envPath: env.path,
            baseBranch: env.base_branch,
            repoLayout: describeRepoLayout(env, task.worktree_path),
            worktree: task.worktree_path ?? env.path,
            branch: task.branch ?? "",
            taskDir,
            reviewerNotes: opts.notes ?? "",
            attempt: String(opts.attempt ?? 1),
            ...(opts.extraVars ?? {}),
        };
        if (def.stage === "qa_baseline" || def.stage === "manual_qa") {
            const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
            const scenarios: QaScenario[] = design?.qa ?? [];
            vars["pass"] = def.stage === "qa_baseline" ? "before" : "after";
            vars["passHint"] =
                def.stage === "qa_baseline"
                    ? " — the change is NOT implemented yet; expect asserts about new behaviour to fail. Record what the app does today."
                    : " — the change is implemented; every assert is expected to hold.";
            const be = this.services.get(task.id, "be");
            const fe = this.services.get(task.id, "fe");
            const appUrl = (env.app_url ?? (fe ? "{{feUrl}}" : "https://localhost:3000"))
                .replace(/\{\{feUrl\}\}/g, fe?.url ?? "")
                .replace(/\{\{beUrl\}\}/g, be?.url ?? "");
            vars["appUrl"] = appUrl;
            vars["firstUrl"] = scenarios[0]?.url ?? "/";
            const logs = [be ? `BE log: ${be.log_path}` : null, fe ? `FE log: ${fe.log_path}` : null].filter(Boolean).join("; ");
            vars["qaSetup"] = env.qa_script
                ? `0. Bring the app up first by running this from the worktree with Bash: \`${env.qa_script}\`. If it exits non-zero, write every scenario as \`blocked\` with the script's last lines as the blocker and stop.`
                : `0. The app was started by the orchestrator from this task's worktree and should be serving at ${appUrl}${logs ? ` (${logs} — read them with Bash \`tail\` when something looks wrong)` : ""}; if it is not reachable, write every scenario as \`blocked\` with blocker "app not running at <url>" and stop.`;
            vars["scenarios"] = scenarios
                .map(
                    (s) =>
                        `### ${s.id} — ${s.title}\nStart: \`${s.url}\` · Persona: ${s.persona}\n` +
                        s.steps.map((st, i) => `${i + 1}. ${st.action} → **assert:** ${st.assert}${st.shot ? " **[shot]**" : ""}`).join("\n"),
                )
                .join("\n\n");
        }
        return vars;
    }

    dispatch(taskId: string, stage: Stage, opts: DispatchOpts = {}): void {
        const task = this.getTask(taskId);
        if (!task) return;
        const def = STAGE_DEFS[stage];
        if (!def.prompt) return;
        if (def.chrome && !opts.servicesReady) {
            // Browser stages run against the task's own BE/FE when the env defines them; bring them up first, then dispatch for real.
            const env = this.env(task.env_id);
            if (env.be_command || env.fe_command) {
                this.setTaskStatus(taskId, "running", `${def.label} · starting BE/FE from the worktree`);
                void this.bringUpServices(task, env)
                    .then((ok) => {
                        if (ok) this.dispatch(taskId, stage, { ...opts, servicesReady: true });
                        else this.setTaskStatus(taskId, "blocked", `${def.label} · BE/FE did not come up — check the service logs, then retry`);
                    })
                    .catch((e: unknown) => this.setTaskStatus(taskId, "blocked", `${def.label} · ${String((e as Error).message ?? e).slice(0, 160)}`));
                return;
            }
        }
        const account = this.pickAccount(task, def);
        if (!account) {
            this.setTaskStatus(taskId, "blocked", def.chrome ? "no logged-in account with Chrome connected" : "no logged-in account");
            return;
        }
        const util = this.utilization(account.id);
        if (util && util.utilization >= this.cfg.preflightUtilizationLimit) {
            this.queueRateLimited(task, account, util.resetsAt, `pre-flight: ${account.name} at ${Math.round(util.utilization * 100)}% of 5h window`);
            return;
        }
        if (this.runningCount(account.id) >= this.cfg.maxConcurrentRunsPerAccount) {
            this.setTaskStatus(taskId, "idle", `queued · ${account.name} busy`);
            this.db.prepare(`UPDATE tasks SET status = 'queued' WHERE id = ?`).run(taskId);
            return;
        }

        const runId = randomUUID();
        const attempt = opts.attempt ?? 1;
        const fresh = def.freshSession === true;
        const priorRuns = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task-session'`).get(taskId) as { n: number };
        const vars = this.promptVars(task, def, opts);
        const prompt = renderPrompt(def.prompt, vars);
        const env = this.env(task.env_id);
        const eventLogPath = join(this.cfg.dataDir, "runs", `${runId}.ndjson`);

        this.db
            .prepare(
                `INSERT INTO runs (id, task_id, stage, kind, status, account_id, started_at, attempt)
                 VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
            )
            .run(runId, taskId, stage, fresh ? "fresh-session" : "task-session", account.id, now(), attempt);
        this.setTaskStatus(taskId, "running", `${def.label} · starting`);
        const stageModel = (this.cfg.stageModels as Record<string, string | null | undefined>)[def.stage];
        const explicitModel = task.model ?? stageModel ?? this.cfg.defaultModel ?? null;

        const run = startClaude({
            prompt,
            cwd: task.worktree_path ?? env.path,
            configDir: account.config_dir,
            extraEnv: parseEnvVars(env.env_vars),
            ...(fresh ? {} : priorRuns.n === 0 ? { sessionId: task.session_id, name: task.ticket_id } : { resume: task.session_id }),
            chrome: def.chrome === true,
            ...(explicitModel ? { model: explicitModel } : {}),
            ...(def.maxTurns ? { maxTurns: def.maxTurns } : {}),
            addDirs: [this.taskDir(taskId)],
            eventLogPath,
        });
        this.active.set(runId, run);
        this.db.prepare(`UPDATE runs SET pid = ? WHERE id = ?`).run(run.pid ?? null, runId);

        run.on("activity", (ev: ActivityEvent) => {
            // A run without --model tells us what this account's default really is.
            if (ev.kind === "init" && !explicitModel) {
                const model = (ev.raw as { model?: unknown }).model;
                if (typeof model === "string" && model) this.db.prepare(`UPDATE accounts SET default_model = ? WHERE id = ?`).run(model, account.id);
            }
            if (ev.kind === "tool_use" || ev.kind === "text") {
                this.db.prepare(`UPDATE runs SET last_event = ? WHERE id = ?`).run(ev.summary, runId);
                this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`${def.label} · ${ev.summary}`, now(), taskId);
                this.emit("activity", { taskId, runId, event: ev });
                this.emit("task", this.getTask(taskId));
            }
        });
        run.on("rate_limit", (info: RateLimitInfo) => this.recordRateLimit(account.id, info));

        void run.done.then((outcome) => {
            this.active.delete(runId);
            this.onRunClosed(taskId, runId, def, account, outcome, opts);
        });
    }

    private async bringUpServices(task: TaskRow, env: EnvRow): Promise<boolean> {
        if (env.be_command) {
            const be = await this.services.start(task, env, "be");
            if (!(await this.services.waitForPort(be.port, 180_000))) return false;
        }
        if (env.fe_command) {
            const fe = await this.services.start(task, env, "fe");
            if (!(await this.services.waitForPort(fe.port, 300_000))) return false;
        }
        this.emit("task", this.getTask(task.id));
        return true;
    }

    private recordRateLimit(accountId: string, info: RateLimitInfo): void {
        const windows = info.unifiedWindows ?? {};
        const upsert = this.db.prepare(
            `INSERT INTO rate_limits (account_id, window, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(account_id, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, updated_at = excluded.updated_at`,
        );
        for (const [name, w] of Object.entries(windows)) upsert.run(accountId, name, w.utilization, w.resetsAt, now());
        this.emit("rate_limit", { accountId, info });
    }

    private queueRateLimited(task: TaskRow, account: AccountRow, resetsAt: number, reason: string): void {
        const resumeAt = new Date(resetsAt * 1000 + 30_000).toISOString();
        const failover = this.findFailover(account, task);
        if (failover) {
            this.db.prepare(`UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?`).run(failover.id, now(), task.id);
            this.setTaskStatus(task.id, "idle", `${reason} → failing over to ${failover.name}`);
            this.dispatch(task.id, task.stage, { notes: "You were interrupted by a rate limit. Continue from the current state of the task directory; do not redo finished work." });
            return;
        }
        const run = this.latestRun(task.id);
        if (run) this.db.prepare(`UPDATE runs SET resume_at = ? WHERE id = ?`).run(resumeAt, run.id);
        const local = new Date(resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
        this.db.prepare(`UPDATE tasks SET status = 'rate_limited', status_line = ?, updated_at = ? WHERE id = ?`).run(`${reason} · resumes at ${local}`, now(), task.id);
        this.emit("task", this.getTask(task.id));
    }

    private findFailover(limited: AccountRow, task: TaskRow): AccountRow | null {
        if (!limited.failover_enabled) return null;
        const def = STAGE_DEFS[task.stage];
        const candidates = this.db.prepare(`SELECT * FROM accounts WHERE logged_in = 1 AND id != ?`).all(limited.id) as AccountRow[];
        for (const c of candidates) {
            if (def.chrome && !c.chrome_capable) continue;
            const u = this.utilization(c.id);
            if (!u || u.utilization < limited.failover_threshold) return c;
        }
        return null;
    }

    private onRunClosed(taskId: string, runId: string, def: StageDef, account: AccountRow, outcome: RunOutcome, opts: DispatchOpts): void {
        const task = this.getTask(taskId);
        if (!task) return;
        if (task.status === "stopped") {
            this.db.prepare(`UPDATE runs SET status = 'stopped', finished_at = ? WHERE id = ?`).run(now(), runId);
            return;
        }
        const finish = (status: RunRow["status"], error?: string, resultJson?: string): void => {
            this.db
                .prepare(`UPDATE runs SET status = ?, finished_at = ?, error = ?, result_json = ?, cost_usd = ?, num_turns = ? WHERE id = ?`)
                .run(status, now(), error ?? null, resultJson ?? null, outcome.result?.total_cost_usd ?? null, outcome.result?.num_turns ?? null, runId);
        };

        const limited = outcome.lastRateLimit && outcome.lastRateLimit.status !== "allowed";
        if (limited && outcome.lastRateLimit?.resetsAt) {
            finish("rate_limited", "rate limited");
            this.queueRateLimited(task, account, outcome.lastRateLimit.resetsAt, `rate limited on ${account.name}`);
            return;
        }
        if (!outcome.result || outcome.result.is_error || (outcome.exitCode ?? 1) !== 0) {
            // A run that wrote its output file and then died (typically max turns before the final "DONE") still did the work.
            if (def.contract && def.outputFile && this.outputWrittenDuringRun(taskId, def.outputFile, runId)) {
                const validation = this.validateOutput(taskId, def);
                if (validation.ok) {
                    finish("done", `ended with ${outcome.result?.subtype ?? `exit ${outcome.exitCode}`} after writing the output`, JSON.stringify(validation.data));
                    this.afterStage(taskId, def, validation.data);
                    return;
                }
            }
            const err = outcome.result?.result ?? outcome.stderr.trim().split("\n").slice(-3).join(" ") ?? `exit ${outcome.exitCode}`;
            finish("failed", err);
            this.setTaskStatus(taskId, "failed", `${def.label} · ${err.slice(0, 160)}`);
            return;
        }

        if (def.contract && def.outputFile) {
            const validation = this.validateOutput(taskId, def);
            if (!validation.ok) {
                const attempt = opts.attempt ?? 1;
                if (attempt < 2) {
                    finish("failed", `contract: ${validation.error}`);
                    this.dispatch(taskId, def.stage, {
                        attempt: attempt + 1,
                        notes:
                            `## Output contract violation (fix this and rewrite the file)\n\n${validation.error}\n\n` +
                            `Rewrite \`${this.taskDir(taskId)}/${def.outputFile}\` to match the contract exactly, then reply DONE.`,
                    });
                    return;
                }
                finish("failed", `contract: ${validation.error}`);
                this.setTaskStatus(taskId, "failed", `${def.label} · output contract failed twice`);
                return;
            }
            finish("done", undefined, JSON.stringify(validation.data));
            this.afterStage(taskId, def, validation.data);
            return;
        }
        finish("done");
        const next = def.next;
        if (next) this.advance(taskId, next);
    }

    // True when the stage's output file was (re)written after this run started — a stale file from an earlier pass doesn't count.
    private outputWrittenDuringRun(taskId: string, outputFile: string, runId: string): boolean {
        const run = this.db.prepare(`SELECT started_at FROM runs WHERE id = ?`).get(runId) as { started_at: string | null } | undefined;
        const path = join(this.taskDir(taskId), outputFile);
        if (!run?.started_at || !existsSync(path)) return false;
        return statSync(path).mtimeMs >= new Date(run.started_at).getTime() - 1000;
    }

    private validateOutput(taskId: string, def: StageDef): { ok: true; data: unknown } | { ok: false; error: string } {
        const path = join(this.taskDir(taskId), def.outputFile!);
        if (!existsSync(path)) return { ok: false, error: `${def.outputFile} was not written` };
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(path, "utf8"));
        } catch (e) {
            return { ok: false, error: `${def.outputFile} is not valid JSON: ${String(e)}` };
        }
        const parsed = def.contract!.safeParse(raw);
        if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
        return { ok: true, data: parsed.data };
    }

    private afterStage(taskId: string, def: StageDef, data: unknown): void {
        const task = this.getTask(taskId)!;
        if (def.stage === "research") {
            const r = ResearchResult.parse(data);
            const env = this.env(task.env_id);
            const wanted = r.repositoryPath ? r.repositoryPath.replace(/\/+$/, "") : null;
            const mine = [env.path, ...repoPaths(env)].map((p) => p.replace(/\/+$/, ""));
            if (wanted && !mine.includes(wanted)) {
                const other = this.db.prepare(`SELECT name FROM envs WHERE path = ?`).get(wanted) as { name: string } | undefined;
                this.setTaskStatus(
                    taskId,
                    "blocked",
                    `Research says this ticket's code lives in ${wanted}${other ? ` (env "${other.name}")` : ""}, not in this env — delete this task and recreate it there`,
                );
                return;
            }
            const prefix = env.branch_prefix ?? "";
            const branch = prefix && !r.branchName.startsWith(prefix) ? `${prefix}${r.branchName}` : r.branchName;
            this.db.prepare(`UPDATE tasks SET title = ?, branch = ?, updated_at = ? WHERE id = ?`).run(r.title, branch, now(), taskId);
            this.setTaskStatus(taskId, "running", "creating worktree");
            const envVars = parseEnvVars(env.env_vars);
            void createWorktree(env, branch, envVars)
                .then(async (wt) => {
                    this.db.prepare(`UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE id = ?`).run(wt.path, now(), taskId);
                    if (wt.reused) {
                        this.setTaskStatus(taskId, "running", `reusing existing worktree/branch with ${wt.existingCommits} commit(s) ahead of ${env.base_branch}`);
                    }
                    if (env.setup_command) {
                        this.setTaskStatus(taskId, "running", "running worktree setup");
                        await runWorktreeSetup(wt.path, env.path, env.setup_command, envVars);
                    }
                    this.advance(taskId, "design_proposal");
                })
                .catch((e: unknown) => this.setTaskStatus(taskId, "failed", `worktree: ${String(e).slice(0, 160)}`));
            return;
        }
        if (def.kind === "wait") {
            this.setTaskStatus(taskId, "waiting_user", `${def.label} · needs you`);
            return;
        }
        if (def.stage === "qa_baseline" || def.stage === "manual_qa") {
            const qa = QaPassResult.parse(data);
            // The Chrome bridge attaches unreliably on a fresh process (~1 in 3 misses); a bridge-level block is retried, a real block is not.
            const bridgeMiss = qa.blockers.some((b) => /extension|not connected/i.test(b)) && qa.scenarios.every((s) => s.outcome === "blocked");
            const attempt = this.latestRun(taskId)?.attempt ?? 1;
            if (bridgeMiss && attempt < 3) {
                this.dispatch(taskId, def.stage, { attempt: attempt + 1 });
                return;
            }
            const blockedByAuth = qa.blockers.some((b) => /auth0|log ?in/i.test(b));
            if (blockedByAuth) {
                this.setTaskStatus(taskId, "blocked", `${def.label} · log into Northspyre in the automation Chrome window, then retry`);
                return;
            }
            const failed = qa.scenarios.filter((s) => s.outcome === "fail").length;
            const needsHuman = qa.scenarios.filter((s) => s.outcome === "needs_human").length;
            if (def.stage === "manual_qa" && (failed > 0 || needsHuman > 0)) {
                const parts = [failed > 0 ? `${failed} scenario(s) failed` : null, needsHuman > 0 ? `${needsHuman} need your own check` : null].filter(Boolean);
                this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`Manual QA · ${parts.join(" · ")}`, now(), taskId);
            }
        }
        if (def.next) this.advance(taskId, def.next);
    }
}
