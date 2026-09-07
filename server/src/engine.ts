import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { accountBrowserReady, accountOrderOf, accountUsableWith, now, parseEnvVars, type AccountRow, type ConfigDirRow, type DB, type EnvRow, type RunRow, type Stage, type TaskRow, type TaskStatus } from "./db.js";
import { ResultEvent, startClaude, type ActivityEvent, type ClaudeRun, type RateLimitInfo, type RunOutcome } from "./claude/runner.js";
import { authEnv, browserDirFor, mirrorConfigDir } from "./claude/accounts.js";
import { backfillUsage, recordUsage } from "./usage.js";
import { notify, taskLink, type Notice } from "./notify.js";
import { createWorktree, envRepos, removeWorktreeAndBranch, repoPaths, runWorktreeSetup, worktreeDiff, type DiffFile } from "./git.js";
import { materializeRules, prTemplates, rulesOf } from "./rules.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type { Services } from "./services.js";
import { fetchTicket, fetchTicketRest, parseTicketRef, renderTicketForPrompt, Ticket } from "./tickets.js";
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

export type PrComment =
    | { kind: "review"; id: number; author: string; state: string; body: string; at: string; url: string }
    | { kind: "line"; id: number; author: string; path: string; line: number | null; side: "old" | "new"; outdated: boolean; body: string; at: string; url: string; replyTo: number | null; snippet: string }
    | { kind: "general"; id: number; author: string; body: string; at: string; url: string };
export interface PrComments {
    number: number;
    repo: string;
    human: PrComment[];
    automation: PrComment[];
    fetchedAt: string;
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
    // Browser stages: the orchestrator has already executed the scenarios' `shell:` seed steps for this dispatch.
    seedsDone?: boolean;
}

const FIVE_HOUR = "five_hour";
// Task states in which nothing happens until a human acts (or, for rate limits, until the window resets).
const NEEDS_HUMAN: ReadonlySet<TaskStatus> = new Set(["waiting_user", "blocked", "failed", "rate_limited"]);

// Required `## ` sections of design.md, in order (numbering optional); mirrored in prompts/design.md.
export const DESIGN_SECTIONS = ["Classification", "How it works today", "Problem", "Change", "Risks and edge cases", "Tests", "QA"] as const;
export const DESIGN_MAX_WORDS = 700;

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
        const n = backfillUsage(this.db, this.cfg.dataDir);
        if (n) console.log(`[stagehand] usage backfilled for ${n} run(s)`);
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
        const cd = this.configDirOf(env);
        const account = this.pickAccount(task, STAGE_DEFS.research, env, cd);
        this.setTaskStatus(taskId, "running", "fetching ticket");
        const onResult = (raw: unknown): void => {
            const parsed = ResultEvent.safeParse(raw);
            if (parsed.success) recordUsage(this.db, { accountId: account?.id ?? null, envId: env.id, taskId, runId: null, kind: "ticket-fetch", stage: null }, parsed.data);
        };
        void fetchTicket(ref, this.cfg, cd.path, env.path, this.taskDir(taskId), { ...parseEnvVars(env.env_vars), ...authEnv(account) }, onResult)
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

    // Stores the raw ticket for a task that has none (created before a token existed); REST only, no agent run.
    async fetchTicketNow(taskId: string): Promise<Ticket> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const ticket = await fetchTicketRest({ source: task.source as "clickup" | "linear", id: task.ticket_id, url: task.ticket_url }, this.cfg, this.taskDir(taskId));
        this.db.prepare(`UPDATE tasks SET title = COALESCE(title, ?), ticket_url = COALESCE(ticket_url, ?), updated_at = ? WHERE id = ?`).run(ticket.title, ticket.url, now(), taskId);
        this.emit("task", this.getTask(taskId));
        return ticket;
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
        this.pollPrs();
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

    // The Claude config dir every agent in this environment runs with; the server's own dir when none is set.
    configDirOf(env: EnvRow): ConfigDirRow {
        const row = env.config_dir_id ? (this.db.prepare(`SELECT * FROM config_dirs WHERE id = ?`).get(env.config_dir_id) as ConfigDirRow | undefined) : undefined;
        return row ?? { id: "", name: "server default", path: this.cfg.mainConfigDir, chrome_capable: null, rules: null, login_email: null, login_ok: null, chrome_browsers: null, created_at: "" };
    }

    // Accounts that can drive a run in this config dir: any with a token, or a legacy login living in that very dir.
    usableAccounts(configDirPath: string): AccountRow[] {
        const all = this.db.prepare(`SELECT * FROM accounts WHERE logged_in = 1 ORDER BY created_at`).all() as AccountRow[];
        return all.filter((a) => accountUsableWith(a, configDirPath));
    }

    // Browser stages cannot use an account token (Claude Code disables the Chrome bridge for token sessions). They run under
    // an account's browser login, in that account's browser dir with the env's config dir mirrored in, and follow the env's
    // priority list like any other stage: the first Chrome-ready account that is not exhausted wins.
    chromeContext(
        env: EnvRow,
        cd: ConfigDirRow,
        task: TaskRow,
    ): { ok: true; account: AccountRow; configDir: string; extraEnv: Record<string, string> } | { ok: false; reason: string; exhausted?: { account: AccountRow; resetsAt: number } } {
        const all = this.db.prepare(`SELECT * FROM accounts ORDER BY created_at`).all() as AccountRow[];
        const ordered = accountOrderOf(env).map((id) => all.find((a) => a.id === id)).filter((a): a is AccountRow => !!a);
        const ready = (ordered.length ? ordered : all).filter(accountBrowserReady);
        if (ready.length === 0) return { ok: false, reason: "no AI account has a Chrome-paired browser login — AI accounts → Log in (browser), then Probe Chrome" };
        const pool = ready.filter((a) => this.browserDir(a, cd) !== null);
        if (pool.length === 0) {
            return { ok: false, reason: `${ready.map((a) => a.name).join(", ")} can drive Chrome only from ${ready.map((a) => a.login_dir).join(", ")}, not for config dir ${cd.name} — AI accounts → Log in (browser) (into the Stagehand browser dir), then Probe Chrome` };
        }
        const current = task.account_id ? pool.find((a) => a.id === task.account_id) : undefined;
        const account = (current && !this.exhausted(current.id) ? current : undefined) ?? pool.find((a) => !this.exhausted(a.id));
        if (!account) {
            const first = pool[0]!;
            const u = this.utilization(first.id);
            return { ok: false, reason: `${pool.map((a) => a.name).join(", ")} ${pool.length > 1 ? "are all" : "is"} at the 5-hour cap`, ...(u ? { exhausted: { account: first, resetsAt: u.resetsAt } } : {}) };
        }
        const dir = this.browserDir(account, cd)!;
        return { ok: true, account, configDir: dir, extraEnv: {} };
    }

    // The config dir a browser stage runs in for this account: the env's dir itself when the account's browser login lives
    // there; else the account's Stagehand-owned browser dir (login required there) with the env's dir mirrored in; else null.
    browserDir(account: AccountRow, cd: ConfigDirRow): string | null {
        if (account.login_dir === cd.path) return cd.path;
        const own = browserDirFor(this.cfg, account);
        if (account.login_dir !== own) return null;
        mirrorConfigDir(this.cfg, cd.path, own);
        return own;
    }

    // Accounts that could run browser stages for this env, in priority order (for the UI and the open-app button).
    browserAccounts(env: EnvRow): AccountRow[] {
        const all = this.db.prepare(`SELECT * FROM accounts ORDER BY created_at`).all() as AccountRow[];
        const ordered = accountOrderOf(env).map((id) => all.find((a) => a.id === id)).filter((a): a is AccountRow => !!a);
        return (ordered.length ? ordered : all).filter(accountBrowserReady);
    }

    // The app URL browser stages and login prompts point at: the env's template with this task's own BE/FE filled in.
    appUrlFor(task: TaskRow, env: EnvRow): string {
        const be = this.services.get(task.id, "be");
        const fe = this.services.get(task.id, "fe");
        return (env.app_url ?? (fe ? "{{feUrl}}" : "https://localhost:3000")).replace(/\{\{feUrl\}\}/g, fe?.url ?? "").replace(/\{\{beUrl\}\}/g, be?.url ?? "");
    }

    private chromeSelectStep(account: AccountRow | null): string {
        return account?.chrome_device_id
            ? `Before any other browser tool, load mcp__claude-in-chrome__select_browser with ToolSearch and call it with deviceId "${account.chrome_device_id}" (Chrome profile "${account.chrome_browser_name ?? account.chrome_device_id}"). Never call switch_browser or AskUserQuestion.`
            : "Never call switch_browser or AskUserQuestion; use whichever browser is already paired.";
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
            .run(id, env.id, ref.id, ref.source, ref.url, model ?? this.cfg.defaultModel, sessionId, accountId ?? accountOrderOf(env)[0] ?? null, ts, ts);
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
        const cd = this.configDirOf(env);
        const chrome = this.chromeContext(env, cd, task);
        if (!chrome.ok) {
            this.setTaskStatus(taskId, "blocked", chrome.reason);
            throw new Error(chrome.reason);
        }
        const account = chrome.account;
        const appUrl = this.appUrlFor(task, env);
        const where = account.chrome_browser_name ? `Chrome profile "${account.chrome_browser_name}"` : "the automation Chrome window";
        this.setTaskStatus(taskId, "blocked", `waiting for you to log in at ${appUrl} in ${where}`);
        // One turn to open the page, ONE Bash loop to wait (osascript reads the live tab titles/URLs) — not a model turn per poll.
        const prompt =
            `${this.chromeSelectStep(account)} Load the browser tools with one ToolSearch (tabs_context_mcp, tabs_create_mcp, navigate). Create a new tab and navigate to ${appUrl}/. ` +
            `A human will log in in this window — you must NOT type any credentials. Then run this Bash command in the FOREGROUND (pass timeout 100000; never run it in the background) and wait for it; it polls the tab for 90 seconds. If it prints WAITING, run the exact same command again — up to 6 times in total — until it prints LOGGED_IN:\n` +
            `osascript -e 'tell application "Google Chrome" to activate'; for i in $(seq 1 9); do t=$(osascript -e 'tell application "Google Chrome" to get {title, URL} of active tab of front window' 2>/dev/null); ` +
            // Origin-override hack (deal alt-port): Auth0 sends the browser back to the allowed origin; re-open the same query on the real app URL.
            `case "$t" in *auth0.com*|*"Welcome"*|*"Log in"*|*"Sign in"*|*"login"*) sleep 10;; *"${appUrl}"*) echo LOGGED_IN; exit 0;; ` +
            `*"localhost:3000/?code="*) u=$(osascript -e 'tell application "Google Chrome" to get URL of active tab of front window'); q=\${u#*localhost:3000/}; osascript -e "tell application \\"Google Chrome\\" to set URL of active tab of front window to \\"${appUrl}/$q\\""; sleep 8;; ` +
            `*) sleep 10;; esac; done; echo WAITING\n` +
            `Reply with exactly one line: LOGGED_IN if a run printed LOGGED_IN, TIMEOUT if all 6 runs printed WAITING, or FAILED <reason> if the browser tools or the command did not work.`;
        const run = startClaude({
            prompt,
            cwd: task.worktree_path ?? env.path,
            configDir: chrome.configDir,
            extraEnv: { ...parseEnvVars(env.env_vars), ...chrome.extraEnv },
            chrome: true,
            maxTurns: 20,
            model: this.cfg.stageModels.helper ?? "sonnet",
            allowedTools: ["Bash"],
        });
        const outcome = await run.done;
        if (outcome.result) recordUsage(this.db, { accountId: account.id, envId: env.id, taskId, runId: null, kind: "qa-login", stage: null }, outcome.result);
        const text = outcome.result?.result ?? "";
        if (/LOGGED_IN/.test(text)) {
            this.setTaskStatus(taskId, "idle", "logged in — re-running the blocked stage");
            this.rerun(taskId, task.stage);
            return "logged_in";
        }
        this.setTaskStatus(taskId, "blocked", /TIMEOUT/.test(text) ? `login window timed out — open ${appUrl} in ${where}, log in, then retry (or click Log in for QA again)` : `login helper failed: ${text.slice(0, 120)} — open ${appUrl} in ${where} and log in yourself, then retry`);
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
        if (task.stage === "pr_creation_review") {
            void this.createPr(taskId);
            return;
        }
        this.advance(taskId, next);
    }

    // ---------- pull requests ----------

    private prCheckouts(task: TaskRow, env: EnvRow): string[] {
        const wt = task.worktree_path ?? env.path;
        const subs = envRepos(env);
        return subs.length ? subs.map((d) => join(wt, d)) : [wt];
    }

    private async git(cwd: string, args: string[], env: EnvRow): Promise<string> {
        const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, ...parseEnvVars(env.env_vars) }, maxBuffer: 4 * 1024 * 1024 });
        return stdout.trim();
    }

    private async gh(cwd: string, args: string[], env: EnvRow): Promise<string> {
        const { stdout } = await execFileAsync("gh", args, { cwd, env: { ...process.env, ...parseEnvVars(env.env_vars) }, maxBuffer: 4 * 1024 * 1024 });
        return stdout.trim();
    }

    // After the human approves the draft: push (if allowed) and open the PR (if allowed); otherwise tell the human what to do.
    // The poller then tracks the PR by head branch, so a PR the human opens by hand is picked up the same way.
    private async createPr(taskId: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task?.branch) return;
        const env = this.env(task.env_id);
        const rules = rulesOf(this.configDirOf(env));
        const draft = this.readArtifactJson<{ title: string; body: string; base: string }>(taskId, "pr.json");
        const checkouts = this.prCheckouts(task, env);
        const created: string[] = [];
        const manual: string[] = [];
        for (const cwd of checkouts) {
            const ahead = await this.git(cwd, ["log", "--oneline", `origin/${env.base_branch}..HEAD`], env).catch(() => "");
            if (!ahead) continue;
            const label = checkouts.length > 1 ? `${cwd.slice((task.worktree_path ?? env.path).length + 1)}: ` : "";
            if (!rules.allowPush) {
                manual.push(`${label}push \`${task.branch}\``);
                continue;
            }
            this.setTaskStatus(taskId, "running", `PR Creation Review · pushing ${task.branch}`);
            try {
                await this.git(cwd, ["push", "-u", "origin", task.branch], env);
            } catch (e) {
                this.setTaskStatus(taskId, "failed", `push failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
                return;
            }
            if (!rules.allowPrCreate || !draft) {
                manual.push(`${label}open the PR from \`${task.branch}\``);
                continue;
            }
            try {
                const url = await this.gh(cwd, ["pr", "create", "--base", draft.base || env.base_branch, "--head", task.branch, "--title", draft.title, "--body", draft.body], env);
                created.push(url);
                const number = Number(url.split("/").pop());
                this.db
                    .prepare(`INSERT INTO pr_state (task_id, number, url, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET number = excluded.number, url = excluded.url, updated_at = excluded.updated_at`)
                    .run(taskId, Number.isFinite(number) ? number : null, url, now());
            } catch (e) {
                this.setTaskStatus(taskId, "failed", `gh pr create failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
                return;
            }
        }
        this.setStage(taskId, "pr_waiting");
        if (manual.length) this.setTaskStatus(taskId, "idle", `PR Waiting · this env forbids it for agents — please ${manual.join(", ")}; Stagehand will pick the PR up by branch name`);
        else this.setTaskStatus(taskId, "idle", `PR Waiting · ${created.join(" ")}`);
    }

    // Everything said on the GitHub PR: review summaries, line comments and general comments, split into human vs automation by the env's handle list.
    async prComments(taskId: string): Promise<PrComments | null> {
        const task = this.getTask(taskId);
        if (!task) return null;
        const state = this.db.prepare(`SELECT number FROM pr_state WHERE task_id = ?`).get(taskId) as { number: number | null } | undefined;
        if (!state?.number) return null;
        const cached = this.prCommentsCache.get(taskId);
        if (cached && Date.now() - cached.at < 60_000) return cached.data;
        const env = this.env(task.env_id);
        const cwd = this.prCheckouts(task, env)[0]!;
        const repo = (JSON.parse(await this.gh(cwd, ["repo", "view", "--json", "nameWithOwner"], env)) as { nameWithOwner: string }).nameWithOwner;
        const n = state.number;
        const [reviewsRaw, lineRaw, generalRaw] = await Promise.all([
            this.gh(cwd, ["api", `repos/${repo}/pulls/${n}/reviews`, "--paginate"], env),
            this.gh(cwd, ["api", `repos/${repo}/pulls/${n}/comments`, "--paginate"], env),
            this.gh(cwd, ["api", `repos/${repo}/issues/${n}/comments`, "--paginate"], env),
        ]);
        const parse = <T,>(raw: string): T[] => {
            // --paginate concatenates JSON arrays; make it one array.
            try {
                return JSON.parse(`[${raw.replace(/\]\s*\[/g, ",").replace(/^\[|\]$/g, "")}]`) as T[];
            } catch {
                return [];
            }
        };
        type GhUser = { login: string };
        const reviews = parse<{ id: number; user: GhUser; state: string; body: string; submitted_at: string; html_url: string }>(reviewsRaw)
            .filter((r) => r.body?.trim() || r.state !== "COMMENTED")
            .map((r) => ({ kind: "review" as const, id: r.id, author: r.user.login, state: r.state, body: r.body ?? "", at: r.submitted_at, url: r.html_url }));
        const lines = parse<{ id: number; user: GhUser; path: string; line: number | null; original_line: number | null; side: string; body: string; created_at: string; html_url: string; in_reply_to_id?: number; diff_hunk?: string }>(lineRaw).map((c) => ({
            kind: "line" as const,
            id: c.id,
            author: c.user.login,
            path: c.path,
            line: c.line ?? c.original_line ?? null,
            side: c.side === "LEFT" ? ("old" as const) : ("new" as const),
            outdated: c.line === null,
            body: c.body,
            at: c.created_at,
            url: c.html_url,
            replyTo: c.in_reply_to_id ?? null,
            snippet: (c.diff_hunk ?? "").split("\n").pop()?.replace(/^[+\- ]/, "") ?? "",
        }));
        const general = parse<{ id: number; user: GhUser; body: string; created_at: string; html_url: string }>(generalRaw).map((c) => ({
            kind: "general" as const,
            id: c.id,
            author: c.user.login,
            body: c.body,
            at: c.created_at,
            url: c.html_url,
        }));
        const bots = new Set(rulesOf(this.configDirOf(env)).automationHandles.map((h) => h.toLowerCase()));
        const isBot = (login: string) => bots.has(login.toLowerCase()) || /\[bot\]$/i.test(login);
        const all = [...reviews, ...lines, ...general];
        const data: PrComments = {
            number: n,
            repo,
            human: all.filter((c) => !isBot(c.author)),
            automation: all.filter((c) => isBot(c.author)),
            fetchedAt: now(),
        };
        this.prCommentsCache.set(taskId, { at: Date.now(), data });
        return data;
    }
    private prCommentsCache = new Map<string, { at: number; data: PrComments }>();

    // Every few ticks: look the PR up (by stored number or by head branch) and move the task through pr_waiting → pr_green → pr_approved → done.
    private pollCounter = 0;
    private pollPrs(): void {
        if (++this.pollCounter % 8 !== 0) return; // scheduler ticks every 15 s → every 2 min
        const tasks = this.db.prepare(`SELECT * FROM tasks WHERE stage IN ('pr_waiting','pr_green','pr_approved') AND status = 'idle'`).all() as TaskRow[];
        for (const task of tasks) void this.pollPr(task).catch((e: unknown) => console.warn(`[stagehand] PR poll ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }

    private async pollPr(task: TaskRow): Promise<void> {
        if (!task.branch) return;
        const env = this.env(task.env_id);
        const cwd = this.prCheckouts(task, env)[0]!;
        const state = this.db.prepare(`SELECT * FROM pr_state WHERE task_id = ?`).get(task.id) as { number: number | null; url: string | null } | undefined;
        let number = state?.number ?? null;
        if (!number) {
            const list = JSON.parse(await this.gh(cwd, ["pr", "list", "--head", task.branch, "--state", "all", "--json", "number,url", "--limit", "1"], env)) as Array<{ number: number; url: string }>;
            if (!list[0]) return;
            number = list[0].number;
            this.db
                .prepare(`INSERT INTO pr_state (task_id, number, url, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET number = excluded.number, url = excluded.url, updated_at = excluded.updated_at`)
                .run(task.id, number, list[0].url, now());
        }
        const pr = JSON.parse(await this.gh(cwd, ["pr", "view", String(number), "--json", "url,state,mergedAt,reviewDecision,statusCheckRollup"], env)) as {
            url: string;
            state: string;
            mergedAt: string | null;
            reviewDecision: string;
            statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string }>;
        };
        const checks = pr.statusCheckRollup ?? [];
        const failed = checks.filter((c) => /FAILURE|ERROR|CANCELLED|TIMED_OUT/i.test(c.conclusion ?? c.state ?? ""));
        const pending = checks.filter((c) => !c.conclusion && !/SUCCESS|FAILURE|ERROR/i.test(c.state ?? "") && (c.status ?? "") !== "COMPLETED");
        this.db
            .prepare(`UPDATE pr_state SET url = ?, checks_json = ?, review_decision = ?, merged_at = ?, updated_at = ? WHERE task_id = ?`)
            .run(pr.url, JSON.stringify(checks), pr.reviewDecision ?? null, pr.mergedAt ?? null, now(), task.id);
        if (pr.mergedAt) {
            this.setStage(task.id, "done");
            this.setTaskStatus(task.id, "done", `merged · ${pr.url}`);
            return;
        }
        if (pr.state === "CLOSED") {
            this.setTaskStatus(task.id, "stopped", `PR closed without merge · ${pr.url}`);
            return;
        }
        if (failed.length) {
            const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_red'`).get(task.id) as { n: number };
            if (rounds.n >= 3) {
                this.setTaskStatus(task.id, "blocked", `PR Red · ${failed.length} check(s) failing after 3 fix rounds · ${pr.url}`);
                return;
            }
            this.setStage(task.id, "pr_red");
            const names = failed.map((c) => c.name ?? c.context ?? "check").join(", ");
            this.dispatch(task.id, "pr_red", {
                attempt: rounds.n + 1,
                extraVars: { failureOutput: `Failing checks: ${names}. Read their logs with \`gh pr checks ${number}\` and \`gh run view --log-failed <run-id>\` before changing anything.` },
            });
            return;
        }
        if (pending.length) {
            this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`PR Waiting · ${pending.length} check(s) running · ${pr.url}`, now(), task.id);
            return;
        }
        if (pr.reviewDecision === "APPROVED") {
            if (task.stage !== "pr_approved") this.setStage(task.id, "pr_approved");
            this.setTaskStatus(task.id, "idle", `PR Approved · waiting for merge · ${pr.url}`);
            return;
        }
        if (task.stage !== "pr_green") this.setStage(task.id, "pr_green");
        this.setTaskStatus(task.id, "idle", `PR Green · checks passed, waiting for review · ${pr.url}`);
    }

    // ---------- stage machine ----------

    private setStage(taskId: string, stage: Stage): void {
        this.db.prepare(`UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?`).run(stage, now(), taskId);
    }

    private setTaskStatus(taskId: string, status: TaskStatus, line?: string): void {
        const prev = this.getTask(taskId);
        this.db
            .prepare(`UPDATE tasks SET status = ?, status_line = COALESCE(?, status_line), updated_at = ? WHERE id = ?`)
            .run(status, line ?? null, now(), taskId);
        const next = this.getTask(taskId);
        this.emit("task", next);
        if (next && prev && NEEDS_HUMAN.has(status) && (prev.status !== status || prev.status_line !== next.status_line)) this.notifyNeedsHuman(next);
    }

    // One push per distinct (task, status, line) within ten minutes: the human learns once that a task waits on them.
    private readonly notified = new Map<string, number>();
    private notifyNeedsHuman(task: TaskRow): void {
        const key = `${task.id}|${task.status}|${task.status_line ?? ""}`;
        const last = this.notified.get(key) ?? 0;
        if (Date.now() - last < 10 * 60_000) return;
        this.notified.set(key, Date.now());
        const label = STAGE_DEFS[task.stage]?.label ?? task.stage;
        const priority: Notice["priority"] = task.status === "blocked" || task.status === "failed" ? "high" : task.status === "rate_limited" ? "low" : "default";
        const verb = task.status === "waiting_user" ? "needs your review" : task.status === "blocked" ? "is blocked" : task.status === "failed" ? "failed" : "is rate-limited";
        void notify(this.cfg, {
            title: `${task.ticket_id} ${verb} · ${label}`,
            message: task.status_line ?? label,
            priority,
            tags: [task.status === "waiting_user" ? "eyes" : task.status === "failed" ? "x" : task.status === "blocked" ? "no_entry" : "hourglass"],
            ...(taskLink(this.cfg, task.id) ? { url: taskLink(this.cfg, task.id)! } : {}),
        });
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

    // An account is exhausted while its 5-hour window is at the pre-flight limit (the reset time is known, so it comes back on its own).
    private exhausted(accountId: string): boolean {
        const u = this.utilization(accountId);
        return !!u && u.utilization >= this.cfg.preflightUtilizationLimit;
    }

    // The env's accounts in priority order (those that can run in its config dir); with no list, every usable account.
    private accountCandidates(env: EnvRow, cd: ConfigDirRow): AccountRow[] {
        const usable = this.usableAccounts(cd.path);
        const ordered = accountOrderOf(env).map((id) => usable.find((a) => a.id === id)).filter((a): a is AccountRow => !!a);
        return ordered.length ? ordered : usable;
    }

    // First candidate that is not exhausted; the task's current account keeps the run only while it is still fresh.
    // When every candidate is exhausted the first one is returned and dispatch parks the task until its window resets.
    // Chrome is a property of the config dir, not the account, so it is checked by the caller.
    private pickAccount(task: TaskRow, _def: StageDef, env: EnvRow, cd: ConfigDirRow): AccountRow | null {
        const candidates = this.accountCandidates(env, cd);
        const current = task.account_id ? candidates.find((a) => a.id === task.account_id) : undefined;
        if (current && !this.exhausted(current.id)) return current;
        return candidates.find((a) => !this.exhausted(a.id)) ?? current ?? candidates[0] ?? null;
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
            ...((): Record<string, string> => {
                const r = rulesOf(this.configDirOf(env));
                const templates = prTemplates(env, r);
                return {
                    commitRule: r.allowCommit
                        ? `Commit in small steps; every message must match \`${r.commitPattern}\` — ${r.commitHint}${r.commitForbid.length ? ` Never include ${r.commitForbid.map((f) => `\`${f}\``).join(", ")}.` : ""}`
                        : "Commits are NOT allowed in this environment: leave your changes uncommitted (staging is fine) and say so in your notes; the human commits.",
                    branchRule: `${r.branchHint} Must match \`${r.branchPattern}\`.`,
                    prRules: r.prRules,
                    prTemplate: templates.map((t) => `${t.dir === "." ? "" : `${t.dir}: `}${t.path ?? "none — no template in this repo; write the description only"}`).join("; "),
                };
            })(),
            worktree: task.worktree_path ?? env.path,
            branch: task.branch ?? "",
            taskDir,
            reviewerNotes: opts.notes ?? "",
            attempt: String(opts.attempt ?? 1),
            maxTurns: String(def.maxTurns ?? 100),
            seedHints: env.qa_seed_hints?.trim() ? env.qa_seed_hints.trim() : "(none configured for this environment — inspect the repo's configs/ and models to find the local database and API)",
            seedReport: "(no shell seeds were run)",
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
            const appUrl = this.appUrlFor(task, env);
            vars["appUrl"] = appUrl;
            vars["chromeSelect"] = this.chromeSelectStep(this.browserAccounts(env).find((a) => a.id === task.account_id) ?? this.browserAccounts(env)[0] ?? null);
            vars["firstUrl"] = scenarios[0]?.url ?? "/";
            const logs = [be ? `BE log: ${be.log_path}` : null, fe ? `FE log: ${fe.log_path}` : null].filter(Boolean).join("; ");
            vars["qaSetup"] = env.qa_script
                ? `0. Bring the app up first by running this from the worktree with Bash: \`${env.qa_script}\`. If it exits non-zero, write every scenario as \`blocked\` with the script's last lines as the blocker and stop.`
                : `0. The app was started by the orchestrator from this task's worktree and should be serving at ${appUrl}${logs ? ` (${logs} — read them with Bash \`tail\` when something looks wrong)` : ""}; if it is not reachable, write every scenario as \`blocked\` with blocker "app not running at <url>" and stop.`;
            vars["scenarios"] = scenarios
                .map(
                    (s) =>
                        `### ${s.id} — ${s.title}\nStart: \`${s.url}\` · Persona: ${s.persona}\n` +
                        ((s.seed ?? []).length
                            ? `Seed:\n${((): string => {
                                  let afterUi = false;
                                  return (s.seed ?? [])
                                      .map((x, i) => {
                                          const shell = /^\s*(shell|sql)\s*:/i.test(x);
                                          if (!shell) afterUi = afterUi || /^\s*ui\s*:/i.test(x);
                                          const tag = shell ? (afterUi ? "run it yourself: ONE Bash call, exact command, after the ui steps" : "run by the orchestrator — see the seed report") : "do this yourself";
                                          return `- seed ${i + 1} (${tag}): ${x}`;
                                      })
                                      .join("\n");
                              })()}\n`
                            : "Seed: nothing beyond a logged-in user.\n") +
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
        const env = this.env(task.env_id);
        const cd = this.configDirOf(env);
        if (def.chrome && !cd.chrome_capable) {
            this.setTaskStatus(taskId, "blocked", `${def.label} · config dir ${cd.name} has no Chrome connection — probe it on the Config dirs page, then retry`);
            return;
        }
        if (def.chrome && !opts.seedsDone) {
            // Seed steps written as commands are run here, without an agent; only `ui:` steps reach the QA runner.
            this.setTaskStatus(taskId, "running", `${def.label} · seeding data`);
            void this.runShellSeeds(task, env, def)
                .then((report) => this.dispatch(taskId, stage, { ...opts, seedsDone: true, extraVars: { ...(opts.extraVars ?? {}), seedReport: report } }))
                .catch((e: unknown) => this.setTaskStatus(taskId, "blocked", `${def.label} · seeding failed: ${String((e as Error).message ?? e).slice(0, 160)}`));
            return;
        }
        const picked = this.pickAccount(task, def, env, cd);
        if (!picked) {
            this.setTaskStatus(taskId, "blocked", `no AI account can run in config dir ${cd.name} — set up a token on the AI accounts page`);
            return;
        }
        // Browser stages run under an account's browser login (no token), in that account's browser dir with the env's
        // config dir mirrored in; the env's priority list picks the account, so they fail over like any other stage.
        let account = picked;
        let runAuth: Record<string, string> = authEnv(picked);
        let runDir = cd.path;
        if (def.chrome) {
            const chrome = this.chromeContext(env, cd, task);
            if (!chrome.ok) {
                // Every Chrome-ready account is at its cap: park with a resume time rather than blocking (the list was already tried).
                if (chrome.exhausted) this.queueRateLimited(task, chrome.exhausted.account, chrome.exhausted.resetsAt, `${def.label} · ${chrome.reason}`, { failover: false });
                else this.setTaskStatus(taskId, "blocked", `${def.label} · ${chrome.reason}`);
                return;
            }
            account = chrome.account;
            runAuth = chrome.extraEnv;
            runDir = chrome.configDir;
            if (task.account_id !== account.id) this.db.prepare(`UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?`).run(account.id, now(), taskId);
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

        const rulesMat = materializeRules(rulesOf(cd), env, task.worktree_path, this.cfg.dataDir);
        const run = startClaude({
            prompt,
            cwd: task.worktree_path ?? env.path,
            configDir: runDir,
            extraEnv: { ...parseEnvVars(env.env_vars), ...runAuth },
            settingsPath: rulesMat.settingsPath,
            appendSystemPrompt: rulesMat.systemPrompt,
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

    // Executes every `shell:` seed step of every scenario from the worktree (env vars applied, 120 s each) and returns a
    // report for the prompt; failures are reported per step, never thrown. Output is kept in <taskDir>/qa/seed-<pass>.log.
    private async runShellSeeds(task: TaskRow, env: EnvRow, def: StageDef): Promise<string> {
        const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
        const pass = def.stage === "qa_baseline" ? "before" : "after";
        const logPath = join(this.taskDir(task.id), "qa", `seed-${pass}.log`);
        const lines: string[] = [];
        const log: string[] = [];
        for (const s of design?.qa ?? []) {
            // Shell steps that come after a ui step depend on what the ui step creates; the runner executes those itself.
            let afterUi = false;
            (s.seed ?? []).forEach((step, i) => {
                const m = /^\s*(shell|sql)\s*:\s*/i.exec(step);
                if (!m) {
                    afterUi = afterUi || /^\s*ui\s*:/i.test(step);
                    lines.push(`${s.id} seed ${i + 1}: left for you (${/^\s*ui\s*:/i.test(step) ? "ui" : "not a shell command"})`);
                    return;
                }
                if (afterUi) {
                    lines.push(`${s.id} seed ${i + 1}: run it yourself after the ui steps — ONE Bash call with the exact command from the scenario's seed list`);
                    return;
                }
                const cmd = step.slice(m[0].length);
                log.push(`### ${s.id} seed ${i + 1}\n$ ${cmd}`);
                try {
                    const out = execFileSync("bash", ["-lc", cmd], {
                        cwd: task.worktree_path ?? env.path,
                        env: { ...process.env, ...parseEnvVars(env.env_vars) },
                        timeout: 120_000,
                        maxBuffer: 4 * 1024 * 1024,
                        stdio: ["ignore", "pipe", "pipe"],
                    }).toString();
                    log.push(out.trim() || "(no output)");
                    lines.push(`${s.id} seed ${i + 1}: OK${out.trim() ? ` — ${out.trim().split("\n").slice(-1)[0]!.slice(0, 120)}` : ""}`);
                } catch (e) {
                    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
                    const tail = String(err.stderr ?? err.stdout ?? err.message ?? e).trim().split("\n").slice(-3).join(" ").slice(0, 300);
                    log.push(`FAILED: ${tail}`);
                    lines.push(`${s.id} seed ${i + 1}: FAILED — ${tail}`);
                }
            });
        }
        writeFileSync(logPath, `${log.join("\n\n")}\n`);
        return lines.length ? lines.join("\n") : "(no seed steps in the design)";
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

    private queueRateLimited(task: TaskRow, account: AccountRow, resetsAt: number, reason: string, opts: { failover?: boolean } = {}): void {
        const resumeAt = new Date(resetsAt * 1000 + 30_000).toISOString();
        const failover = opts.failover === false ? null : this.findFailover(account, task);
        if (failover) {
            this.db.prepare(`UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?`).run(failover.id, now(), task.id);
            this.setTaskStatus(task.id, "idle", `${reason} → failing over to ${failover.name}`);
            this.dispatch(task.id, task.stage, { notes: "You were interrupted by a rate limit. Continue from the current state of the task directory; do not redo finished work." });
            return;
        }
        const run = this.latestRun(task.id);
        if (run) this.db.prepare(`UPDATE runs SET resume_at = ? WHERE id = ?`).run(resumeAt, run.id);
        const local = new Date(resumeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
        this.setTaskStatus(task.id, "rate_limited", `${reason} · resumes at ${local}`);
        this.emit("task", this.getTask(task.id));
    }

    // Next account in the env's priority list that is not exhausted; null when the list has nobody else to offer.
    private findFailover(limited: AccountRow, task: TaskRow): AccountRow | null {
        const env = this.env(task.env_id);
        const candidates = this.accountCandidates(env, this.configDirOf(env)).filter((a) => a.id !== limited.id);
        return candidates.find((a) => !this.exhausted(a.id)) ?? null;
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
            if (outcome.result) recordUsage(this.db, { accountId: account.id, envId: task.env_id, taskId, runId, kind: "stage", stage: def.stage }, outcome.result);
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
            const stderrTail = outcome.stderr.trim().split("\n").slice(-3).join(" ").trim();
            const err =
                outcome.result?.result?.trim() ||
                (outcome.result?.subtype === "error_max_turns"
                    ? `stopped at the ${outcome.result.num_turns ?? "?"}-turn cap before writing ${def.outputFile ?? "its output"} — Retry resumes the session`
                    : outcome.result
                      ? `ended with ${outcome.result.subtype}`
                      : stderrTail || `exit ${outcome.exitCode}`);
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
        if (def.stage === "design_proposal") {
            const md = this.designMdProblems(taskId);
            if (md) return { ok: false, error: md };
        }
        return { ok: true, data: parsed.data };
    }

    // The proposal is for a human: a fixed section order and a hard word cap keep it dense. Violations go back to the agent
    // through the normal contract-retry path.
    private designMdProblems(taskId: string): string | null {
        const p = join(this.taskDir(taskId), "design.md");
        if (!existsSync(p)) return "design.md was not written";
        const md = readFileSync(p, "utf8");
        const problems: string[] = [];
        const headings = [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/^\d+[.)]\s*/, "").toLowerCase());
        for (const want of DESIGN_SECTIONS) if (!headings.some((h) => h.startsWith(want.toLowerCase()))) problems.push(`design.md is missing the section "## ${want}"`);
        const words = md.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
        if (words > DESIGN_MAX_WORDS) problems.push(`design.md is ${words} words; the cap is ${DESIGN_MAX_WORDS} — cut repetition, provenance remarks and prose around tables, keep every path:line`);
        if (/^\s*```json/m.test(md)) problems.push("design.md contains a JSON block — describe scenarios and plans in prose/tables; design.json carries the structure");
        if (/mempalace|research\.md|as research (found|showed)|per the ticket'?s? (own )?note/i.test(md)) problems.push("design.md refers to where facts came from (research.md, mempalace, ticket notes) — state the facts only");
        return problems.length ? problems.join("; ") : null;
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
                const env = this.env(task.env_id);
                const acc = this.browserAccounts(env).find((a) => a.id === task.account_id) ?? this.browserAccounts(env)[0];
                const where = acc?.chrome_browser_name ? `Chrome profile "${acc.chrome_browser_name}"` : "the automation Chrome window";
                this.setTaskStatus(taskId, "blocked", `${def.label} · log in at ${this.appUrlFor(task, env)} in ${where} — opening it for you`);
                // Start the login helper right away: it opens the app in the QA Chrome profile, waits for the human, and re-runs the stage.
                void this.qaLogin(taskId).catch((e: unknown) => console.warn(`[stagehand] auto login helper ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
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
