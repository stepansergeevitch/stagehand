import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { accountBrowserReady, accountOrderOf, accountUsableWith, chromeBrowserLabel, chromeBrowsersOf, extraTicketsOf, now, parseEnvVars, STAGES, type AccountRow, type ChromeBrowser, type ConfigDirRow, type DB, type EnvRow, type MessageRow, type PrStateRow, type QuestionRow, type RunRow, type Stage, type TaskLabel, type TaskRow, type TaskStatus } from "./db.js";
import { ResultEvent, startClaude, type ActivityEvent, type ClaudeRun, type RateLimitInfo, type RunOutcome } from "./claude/runner.js";
import { authEnv, browserDirFor, mirrorConfigDir, probeChrome } from "./claude/accounts.js";
import { closeChromeTabs, listChromeTabs, openInProfile, setChromeTabUrl } from "./chrome-profiles.js";
import { backfillCalibration, backfillUsage, calibrateWindows, recordUsage, stampTaskOnUsage } from "./usage.js";
import { localTaskLink, notify, taskLink, type Notice } from "./notify.js";
import { branchCommits, commitsDiff, createWorktree, envRepos, removeWorktreeAndBranch, repoPaths, runWorktreeSetup, uncommittedGroup, worktreeDiff, type BranchCommit, type DiffFile, type DiffGroup } from "./git.js";
import { materializeRules, prTemplates, rulesOf } from "./rules.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type { Services } from "./services.js";
import { extraTicketFile, fetchTicket, fetchTicketRest, parseTicketRef, renderTicketsForPrompt, Ticket, type TicketRef } from "./tickets.js";
import { killSession, taskSessionName } from "./tmux.js";
import { STAGE_DEFS, renderPrompt, type StageDef } from "./stages/registry.js";
import { DesignResult, ImplResult, PrDraft, PrFixResult, QaPassResult, QuestionsFile, ResearchResult, type AgentQuestion, type QaScenario } from "./stages/contracts.js";

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
    // `threadId` is the GraphQL review-thread node id (what resolve/unresolve take); `resolved` is the thread's state.
    | { kind: "line"; id: number; author: string; path: string; line: number | null; side: "old" | "new"; outdated: boolean; body: string; at: string; url: string; replyTo: number | null; snippet: string; threadId: string | null; resolved: boolean }
    | { kind: "general"; id: number; author: string; body: string; at: string; url: string };
export interface PrComments {
    number: number;
    // GitHub owner/name of the repository the PR lives in, and the task's sub-repo directory ("" for a single repo).
    repo: string;
    repoDir: string;
    human: PrComment[];
    automation: PrComment[];
    fetchedAt: string;
}

export interface ReviewInput {
    verdict: "approve" | "changes";
    // PR Creation Review only: which repository's draft the verdict is about ("" = the single repository).
    repo?: string | undefined;
    routeTo?: "implementation" | "design_proposal" | undefined;
    notes?: string | undefined;
    comments?: LineComment[] | undefined;
}

// Every archived Manual QA attempt so far (oldest first): { N, path } for qa/after-attempt-N.json. The CURRENT
// qa/after.json is not included — archive it first (see afterStage) if it should count as one of these.
const qaAttemptFiles = (taskDir: string): Array<{ n: number; path: string }> => {
    const dir = join(taskDir, "qa");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .map((f) => /^after-attempt-(\d+)\.json$/.exec(f))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ n: Number(m[1]), path: join(dir, m[0]) }))
        .sort((a, b) => a.n - b.n);
};

// What the implementer sees after Manual QA fails and gets auto-returned: this attempt's failures in full, plus a
// one-line-per-attempt trail of every earlier automatic fix cycle — so it never has to re-run QA itself just to
// rediscover what was already tried and what broke each time.
const renderQaFailureNotes = (taskDir: string, qa: QaPassResult, design: DesignResult | null, attemptNum: number): string => {
    const titleOf = (id: string): string => design?.qa.find((s) => s.id === id)?.title ?? id;
    const parts = [`## Manual QA failed — automatic fix attempt ${attemptNum} of ${MAX_AUTO_QA_RETURNS} (after this, it goes to the human's review regardless)`];
    const fails = qa.scenarios.filter((s) => s.outcome === "fail");
    if (fails.length) parts.push(fails.map((f) => `- \`${f.id}\` ${titleOf(f.id)} — ${f.observation}`).join("\n"));
    if (qa.blockers.length) parts.push(`Blockers: ${qa.blockers.join("; ")}`);
    const earlier = qaAttemptFiles(taskDir).filter((a) => a.n < attemptNum);
    if (earlier.length) {
        const lines = earlier.map((a) => {
            try {
                const data = JSON.parse(readFileSync(a.path, "utf8")) as QaPassResult;
                const failedIds = data.scenarios.filter((s) => s.outcome === "fail").map((s) => s.id);
                return `- Attempt ${a.n}: ${failedIds.length ? `failed ${failedIds.join(", ")}` : "no failures (blocked on something else)"}`;
            } catch {
                return `- Attempt ${a.n}: (could not read)`;
            }
        });
        parts.push(`### Earlier automatic attempts — for context, do not re-run Manual QA yourself to rediscover this\n${lines.join("\n")}`);
    }
    parts.push("Fix the code so these pass. Do not weaken or remove the failing assertions or the scenarios themselves.");
    return parts.join("\n\n");
};

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

// The block every stage prompt carries: how to hand a decision to the human without guessing or stopping silently.
const askHumanBlock = (taskDir: string): string =>
    [
        "## Asking the human (any stage)",
        "",
        "When only the human can decide something — an ambiguous requirement, two valid approaches with different scope or cost, a conflict between the ticket and the code, credentials or data you genuinely cannot create — do not guess and do not stop silently. Write `" + `${taskDir}/questions.json` + "`:",
        "",
        "```json",
        '{ "questions": [ { "id": "q1", "text": "<one clear question>", "context": "<why it matters, ≤ 40 words>", "options": ["<option A>", "<option B>"] } ] }',
        "```",
        "",
        "`options` and `context` are optional; put every open question in the one file (ask everything at once, 1–10 questions). Then reply with exactly one line: `NEED_INPUT` — and stop; do not write this stage's output file in that run. The answers come back at the top of your next instructions under \"Answers from the human\" — continue from where you stopped. Ask only when the answer changes what you build; otherwise take the sensible default and record it in your notes.",
    ].join("\n");

// Answers rendered as reviewer notes for the resumed run.
const renderAnswers = (questions: AgentQuestion[], answers: Record<string, string>): string => {
    const lines = questions.map((q) => `- **${q.id}** ${q.text}\n  → ${answers[q.id]?.trim() || "(no answer — decide yourself and note the decision)"}`);
    return `## Answers from the human to your questions (continue from where you stopped)\n\n${lines.join("\n")}`;
};

interface DispatchOpts {
    notes?: string;
    attempt?: number;
    extraVars?: Record<string, string>;
    servicesReady?: boolean;
    // Browser stages: the orchestrator has already executed the scenarios' `shell:` seed steps for this dispatch.
    seedsDone?: boolean;
    // Browser stages: a live probe just confirmed the Chrome extension answers for this dispatch — skip re-probing.
    chromeVerified?: boolean;
}

// CircleCI jobs gated behind a manual "Approve" click in the CircleCI UI (deploy/db-reset gates) sit forever in a
// pending/no-conclusion state until a human clicks through, independent of whether the actual test/build jobs passed.
// A PR is not less green for these — they are not CI verifying the change, they are a deploy gate — so they are
// excluded from both the "pending" and "failed" checks that gate PR Green/PR Fix. Convention: job names end in
// `_hold` (e.g. `deploy_hold`) or match `reset_*_db` (e.g. `reset_staging_db`).
const isApprovalGateCheck = (c: { name?: string; context?: string }): boolean => /_hold$|reset_.*_db$/i.test(c.name ?? c.context ?? "");
// A check GitHub cancelled (superseded by a newer push, stopped by hand, a concurrency-group replace) is not a failure
// of the change itself — treat it as neither passing nor failing, just not counted.
const isCancelledCheck = (c: { conclusion?: string; state?: string }): boolean => /CANCELLED/i.test(c.conclusion ?? c.state ?? "");
const isFailedCheck = (c: { conclusion?: string; state?: string }): boolean => !isCancelledCheck(c) && /FAILURE|ERROR|TIMED_OUT/i.test(c.conclusion ?? c.state ?? "");

// Naming a repository in status lines and errors: the sub-repo directory, or "the repository" for a single-repo env.
const repoLabel = (repo: string): string => repo || "the repository";
// "backend: " in front of a per-repo status fragment, only when the task spans several repositories.
const repoPrefix = (repo: string, repos: string[]): string => (repos.length > 1 && repo ? `${repo}: ` : "");
const repoScopeNote = (repo: string): string => (repo ? `Repository: \`${repo}/\` inside the worktree — every git and gh command below runs inside that directory.\n` : "");

const FIVE_HOUR = "five_hour";
// Task states in which nothing happens until a human acts (or, for rate limits, until the window resets).
const NEEDS_HUMAN: ReadonlySet<TaskStatus> = new Set(["waiting_user", "blocked", "failed", "rate_limited"]);

// Required `## ` sections of design.md, in order (numbering optional); mirrored in prompts/design.md. "A|B" = either title.
export const DESIGN_SECTIONS = ["Classification", "How it works today", "Problem", "Root cause|Approach", "Proposed changes", "Technical changes|Change", "Risks and edge cases", "Tests", "QA"] as const;
export const DESIGN_MAX_WORDS = 1100;
const PROPOSED_MAX_WORDS = 120;
// The explanation section (Root cause / Approach) is the one the reviewer relies on; a few lines is not an explanation.
const EXPLANATION_MIN_WORDS = 60;
const EXPLANATION_MAX_WORDS = 220;
// Sections 2–5 are for a product reader: behaviour and the part of the system, never paths, line numbers or identifiers.
const PROSE_SECTIONS = ["How it works today", "Problem", "Root cause", "Approach", "Proposed changes"] as const;
// A backticked span counts as code when it looks like one (path, identifier, call, constant); a plain word such as `archived` is a product term.
const CODE_REF = /`[^`\n]*(?:[./_(:\\]|[a-z][A-Z])[^`\n]*`|`[^`\n]{30,}`|\b[\w./-]+\.(py|ts|tsx|js|jsx|rs|go|java|kt|rb|sql|scss|css|json|ya?ml)\b|\b[\w./-]+:\d+\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z]\w+\(|\b[A-Z]+_[A-Z_]+\b/;
const LOGIN_POLL_MS = 3_000;
// A Manual QA run that still has failing scenarios goes straight back to Implementation with the failure detail as
// reviewer notes, instead of waiting for the human to notice at User Review. Capped so a genuinely stuck fix doesn't
// loop forever — after this many automatic returns, it falls through to User Review like a passing (or blocked/
// needs_human) run always has.
const MAX_AUTO_QA_RETURNS = 2;
const LOGIN_WAIT_MS = 15 * 60_000;
type ChromeTabLike = { url: string; title: string };
const tabKey = (t: { window: number; tab: number; url: string }): string => `${t.window}:${t.tab}:${t.url}`;

// The proposal is for a human: a fixed section order and a hard word cap keep it dense. Violations go back to the agent
// through the normal contract-retry path.
// `repos`: the workspace's sub-repository directories (multi-repo env) — Classification must then name the affected ones.
export const designMdProblems = (md: string, opts: { repos?: string[] } = {}): string | null => {
    const problems: string[] = [];
    const headings = [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/^\d+[.)]\s*/, "").toLowerCase());
    const has = (title: string): boolean => headings.some((h) => h.startsWith(title.toLowerCase()));
    for (const want of DESIGN_SECTIONS) {
        const alternatives = want.split("|");
        if (!alternatives.some(has)) problems.push(`design.md is missing the section "## ${alternatives.join('" or "## ')}"`);
    }
    const words = md.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
    if (words > DESIGN_MAX_WORDS) problems.push(`design.md is ${words} words; the cap is ${DESIGN_MAX_WORDS} — cut repetition, provenance remarks and prose around tables, keep every path:line`);
    if (/^\s*```json/m.test(md)) problems.push("design.md contains a JSON block — describe scenarios and plans in prose/tables; design.json carries the structure");
    const section = (name: string): string | null => {
        const m = new RegExp(`^##\\s+(?:\\d+[.)]\\s*)?${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im").exec(md);
        return m ? m[1]! : null;
    };
    const wordCount = (s: string): number => s.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
    const classification = section("Classification");
    const isBug = !!classification && /^\s*`?bug`?\b/im.test(classification);
    const isFeature = !!classification && /^\s*`?feature`?\b/im.test(classification);
    if (isBug && !has("Root cause")) problems.push("a bug needs the section `## 4. Root cause` (not Approach): the causal chain from trigger to wrong output, with path:line");
    if (isFeature && !has("Approach")) problems.push("a feature needs the section `## 4. Approach` (not Root cause): how it should be built, where it lives and why, the data flow, the key decisions");
    const explanation = section("Root cause") ?? section("Approach");
    if (explanation !== null) {
        const n = wordCount(explanation);
        const title = has("Root cause") ? "Root cause" : "Approach";
        if (n < EXPLANATION_MIN_WORDS) problems.push(`the ${title} section is ${n} words — it is the explanation the reviewer relies on: ${title === "Root cause" ? "walk the chain of behaviour (the action → what each part of the app does with it → the wrong outcome), the assumption behind it, and why the change removes the cause" : "say which part of the app takes on what and why there, how the data moves after the change, each design decision with the alternative rejected"} (${EXPLANATION_MIN_WORDS}–${EXPLANATION_MAX_WORDS} words)`);
        else if (n > EXPLANATION_MAX_WORDS) problems.push(`the ${title} section is ${n} words; keep it under ${EXPLANATION_MAX_WORDS} — one causal chain / one approach, no restating the Technical changes table`);
    }
    for (const name of PROSE_SECTIONS) {
        const body = section(name);
        if (body === null) continue;
        const hit = CODE_REF.exec(body);
        if (wordCount(body) >= 40 && !/\*\*[^*\n]+\*\*/.test(body)) problems.push(`the ${name} section has no bold at all — give every bullet a bold lead-in naming the part of the system or the case (**Frontend form** — …) and use \`###\` sub-headings in long sections; plain sentences in a row are hard to scan`);
        if (hit) problems.push(`the ${name} section contains code or a file reference (${hit[0].slice(0, 40)}) — write it in product words: what the app does or fails to do and which part of the system (the frontend form, the backend service, the loader) does it; paths, line numbers and identifiers belong in Technical changes`);
    }
    const repos = opts.repos ?? [];
    if (repos.length && classification !== null) {
        const m = /^\s*\**Repos?:?\**\s*(.+)$/im.exec(classification);
        if (!m) problems.push(`this is a multi-repository workspace (${repos.join(", ")}) — Classification needs a second line \`Repos: <dir>, <dir>\` naming the repositories the change touches`);
        else {
            const named = m[1]!.split(/[,;]|\band\b/).map((s) => s.replace(/[`*\s/]+/g, "")).filter(Boolean);
            const unknown = named.filter((n) => !repos.includes(n));
            if (named.length === 0) problems.push("the `Repos:` line in Classification is empty — name the repositories the change touches");
            if (unknown.length) problems.push(`the \`Repos:\` line names ${unknown.join(", ")}, which are not repositories of this workspace (${repos.join(", ")}) — use the directory names exactly`);
        }
    }
    const proposed = section("Proposed changes");
    if (proposed !== null) {
        const words = proposed.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
        if (words === 0) problems.push("the Proposed changes section is empty — 2–6 short bullets saying in plain words what changes and why");
        else if (words > PROPOSED_MAX_WORDS) problems.push(`the Proposed changes section is ${words} words; keep it under ${PROPOSED_MAX_WORDS} — plain words, no tables, no code`);
        if (/^\s*\|/m.test(proposed)) problems.push("the Proposed changes section must not contain a table — the Technical changes table follows in its own section");
    }
    const technical = section("Technical changes");
    const change = technical ?? section("Change");
    if (change !== null && !/^\s*\**Summary:?\**\s*\S/im.test(change)) problems.push("the Technical changes section must open with a `Summary:` line — the whole change in 1–3 imperative clauses, before the table");
    if (technical !== null && !/^\s*\**Flow:?\**\s*\S/im.test(technical)) problems.push("the Technical changes section needs a `Flow:` line — the data flow after the change as symbols (`A.field` → `B.method` → `C.total`)");
    if (technical !== null && !/^\s*\|/m.test(technical)) problems.push("the Technical changes section needs the | Layer | File | Symbol | Before | After | table");
    const risks = section("Risks and edge cases");
    if (risks !== null) {
        const bullets = risks.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l));
        const missing = bullets.filter((l) => !/action:/i.test(l)).length;
        if (missing) problems.push(`${missing} bullet(s) in Risks and edge cases have no \`→ action: …\` part — every case names what to do about it`);
    }
    const tests = section("Tests");
    if (tests !== null && !/^\s*\**Run:?\**\s*\n+\s*```/im.test(tests)) problems.push("the Tests section must end with `Run:` followed by a fenced ```bash block with the exact commands (not inline code)");
    if (/mempalace|research\.md|as research (found|showed)|per the ticket'?s? (own )?note/i.test(md)) problems.push("design.md refers to where facts came from (research.md, mempalace, ticket notes) — state the facts only");
    return problems.length ? problems.join("; ") : null;
};

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
        const c = backfillCalibration(this.db, this.cfg.dataDir);
        if (c) console.log(`[stagehand] rate-limit windows calibrated from ${c} run(s)`);
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
        const ref: TicketRef = { source: task.source as "clickup" | "linear", id: task.ticket_id, url: task.ticket_url };
        const extras = extraTicketsOf(task);
        const cd = this.configDirOf(env);
        const account = this.pickAccount(task, STAGE_DEFS.research, env, cd);
        this.setTaskStatus(taskId, "running", extras.length ? `fetching ${extras.length + 1} tickets` : "fetching ticket");
        const onResult = (raw: unknown): void => {
            const parsed = ResultEvent.safeParse(raw);
            if (parsed.success) recordUsage(this.db, { accountId: account?.id ?? null, envId: env.id, taskId, runId: null, kind: "ticket-fetch", stage: null }, parsed.data);
        };
        const fetchOne = (r: TicketRef, file: string): Promise<Ticket> => fetchTicket(r, this.cfg, cd.path, env.path, this.taskDir(taskId), { ...parseEnvVars(env.env_vars), ...authEnv(account) }, onResult, file);
        if (extras.length) mkdirSync(join(this.taskDir(taskId), "tickets"), { recursive: true });
        void fetchOne(ref, "ticket.json")
            .then(async (ticket) => {
                const titles = [ticket.title];
                for (const x of extras) {
                    const t = await fetchOne(x, extraTicketFile(x.id)).catch(() => null);
                    if (t) titles.push(t.title);
                }
                const title = extras.length ? `${ticket.title}${titles.length > 1 ? ` + ${titles.slice(1).join(" + ")}` : ""}` : ticket.title;
                this.db.prepare(`UPDATE tasks SET title = ?, ticket_url = COALESCE(ticket_url, ?), updated_at = ? WHERE id = ?`).run(title.slice(0, 300), ticket.url, now(), taskId);
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
        this.emitTask(taskId);
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

    // Trailing async events (e.g. a killed run's buffered stdout) can fire after the task row is gone —
    // skip the emit rather than sending clients a "task" payload with no task.
    private emitTask(id: string): void {
        const task = this.getTask(id);
        if (task) this.emit("task", task);
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

    // One task per call. `tickets` holds one ticket, or several for a batch task (one branch / one PR set covering them all).
    createTask(envId: string, tickets: string[], accountId?: string, model?: string, notes?: string): TaskRow {
        const env = this.env(envId);
        const refs = tickets.map((t) => parseTicketRef(t, env.ticket_source));
        const ref = refs[0];
        if (!ref) throw new Error("no ticket given");
        const seen = new Set<string>();
        const extras = refs.slice(1).filter((r) => r.id !== ref.id && !seen.has(r.id) && seen.add(r.id));
        const id = randomUUID();
        const sessionId = randomUUID();
        const ts = now();
        this.db
            .prepare(
                `INSERT INTO tasks (id, env_id, ticket_id, source, ticket_url, model, session_id, account_id, stage, status, status_line, pinned, notes, extra_tickets, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'research', 'running', 'fetching ticket', 0, ?, ?, ?, ?)`,
            )
            .run(id, env.id, ref.id, ref.source, ref.url, model ?? this.cfg.defaultModel, sessionId, accountId ?? accountOrderOf(env)[0] ?? null, notes?.trim() || null, extras.length ? JSON.stringify(extras) : null, ts, ts);
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

    // The Chrome profile browser QA uses for this task (resolved to something `open --profile-directory` accepts).
    qaBrowser(task: TaskRow, env: EnvRow): { account: AccountRow; browser: ChromeBrowser } | { error: string } {
        const candidates = this.browserAccounts(env);
        const account = candidates.find((a) => a.id === task.account_id) ?? candidates[0];
        if (!account) return { error: "no account has a Chrome-paired browser login — AI accounts → Log in (browser) + Probe Chrome" };
        const browser = chromeBrowsersOf(account).find((b) => b.deviceId === account.chrome_device_id);
        if (!browser?.profileDir) return { error: `${account.name}'s Chrome profile is not resolved — AI accounts → ${account.name} → Probe Chrome, then pick the profile` };
        return { account, browser };
    }

    // Opens the app in the QA Chrome profile and waits for a human to log in there — no agent: the server polls Chrome's
    // tabs through osascript. The profile persists, so this is needed once per app session lifetime (core: 365 days;
    // deal: the Auth0 tenant's session). Deal alt-port hack: Auth0 sends the browser back to https://localhost:3000/?code=…
    // (whatever listens there); the poll moves such a tab to the task's real port, where the SDK completes the login.
    async qaLogin(taskId: string): Promise<"logged_in" | "timeout" | "failed"> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const env = this.env(task.env_id);
        const picked = this.qaBrowser(task, env);
        if ("error" in picked) {
            this.setTaskStatus(taskId, "blocked", picked.error);
            throw new Error(picked.error);
        }
        const { browser } = picked;
        const appUrl = this.appUrlFor(task, env).replace(/\/+$/, "");
        const where = `Chrome profile "${chromeBrowserLabel(browser)}"`;
        const helpLine = `log in at ${appUrl} in ${where}; the helper watches the tab and re-runs the stage by itself`;
        if (this.loginWaits.has(taskId)) {
            this.setTaskStatus(taskId, "blocked", `waiting for you to ${helpLine}`);
            return "failed";
        }
        this.loginWaits.add(taskId);
        try {
            const kind = browser.browser ?? "Google";
            // Tabs that exist before the open are stale (earlier attempts); only tabs that appear or change afterwards count.
            const before = new Set((await listChromeTabs(kind)).map(tabKey));
            await openInProfile(kind, browser.profileDir!, `${appUrl}/`);
            this.setTaskStatus(taskId, "blocked", `waiting for you to ${helpLine}`);
            const outcome = await this.waitForLogin(appUrl, kind, LOGIN_WAIT_MS, before);
            if (outcome === "logged_in") {
                this.setTaskStatus(taskId, "idle", "logged in — re-running the blocked stage");
                this.helperReruns.add(taskId);
                this.rerun(taskId, task.stage);
                return "logged_in";
            }
            this.setTaskStatus(taskId, "blocked", `login window timed out — ${helpLine.replace("the helper watches", "click Log in for QA again; the helper watches")}`);
            return "timeout";
        } catch (e) {
            const msg = String((e as Error).message ?? e).slice(0, 120);
            this.setTaskStatus(taskId, "blocked", `login helper failed: ${msg} — ${helpLine}`);
            return "failed";
        } finally {
            this.loginWaits.delete(taskId);
        }
    }

    private readonly loginWaits = new Set<string>();
    // Tasks whose current run was started by the login helper: if that run is auth-blocked again, the helper's
    // "logged in" was wrong (a stale tab) and restarting it would loop — the human is asked instead.
    private readonly helperReruns = new Set<string>();

    // Polls every tab (all profiles) until one sits on the app, not on a login page and not on an Auth0 callback, for
    // three consecutive polls. A callback that landed on https://localhost:3000 (alt-port deal FE) is re-opened on the
    // app's port in the same tab once it has been there for two polls — the app's own FE on 3000 strips that query
    // within a second, so a query that stays belongs to a login that started on another port.
    private async waitForLogin(appUrl: string, browserKind: string, budgetMs: number, stale: Set<string>): Promise<"logged_in" | "timeout"> {
        const origin = new URL(appUrl).origin;
        const altPort = !/^https?:\/\/localhost:3000$/.test(origin);
        const isCallback = (u: string) => /^https?:\/\/localhost:3000\/\?(?=.*\bcode=)(?=.*\bstate=)/.test(u);
        const loginish = (t: ChromeTabLike) => /auth0\.com|\/callback|[?&](code|error)=/.test(t.url) || /welcome|log ?in|sign ?in/i.test(t.title);
        let stableSince = 0;
        let stableUrl = "";
        let callbackSeen = "";
        const until = Date.now() + budgetMs;
        while (Date.now() < until) {
            const tabs = (await listChromeTabs(browserKind)).filter((t) => !stale.has(tabKey(t)));
            const cb = tabs.find((t) => isCallback(t.url));
            if (altPort && cb) {
                if (callbackSeen === cb.url) {
                    await setChromeTabUrl(cb, `${appUrl}/${cb.url.slice(cb.url.indexOf("/?") + 1)}`, browserKind).catch(() => undefined);
                    callbackSeen = "";
                } else callbackSeen = cb.url;
            } else callbackSeen = "";
            const onApp = tabs.find((t) => t.url.startsWith(`${origin}/`) && !loginish(t));
            if (onApp) {
                if (onApp.url !== stableUrl) {
                    stableUrl = onApp.url;
                    stableSince = Date.now();
                } else if (Date.now() - stableSince >= 2 * LOGIN_POLL_MS) return "logged_in";
            } else {
                stableUrl = "";
            }
            await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
        }
        return "timeout";
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

    // Reuses the same cleanup as the "Clean up" button (stop BE/FE, close their Chrome tabs, kill the terminal, run the
    // env's cleanup command, remove the worktree/branch — throwing the same unpushed-work error unless force) before
    // dropping the task's own records. Every table with a foreign key to tasks(id) must be cleared first — `runs`,
    // `pr_state`, `services`, `messages`, `reviews` — or the final DELETE FROM tasks fails (foreign_keys = ON).
    async deleteTask(taskId: string, removeWorktree: boolean, force = false): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) return;
        const run = this.latestRun(taskId);
        if (run) this.active.get(run.id)?.kill();
        await this.doCleanup(task, force, { removeWorktree });
        rmSync(this.taskDir(taskId), { recursive: true, force: true });
        stampTaskOnUsage(this.db, taskId);
        this.db.prepare(`DELETE FROM questions WHERE task_id = ?`).run(taskId);
        this.db.prepare(`DELETE FROM messages WHERE task_id = ?`).run(taskId);
        this.db.prepare(`DELETE FROM reviews WHERE task_id = ?`).run(taskId);
        this.db.prepare(`DELETE FROM pr_state WHERE task_id = ?`).run(taskId);
        this.db.prepare(`DELETE FROM services WHERE task_id = ?`).run(taskId);
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

    // The same changes narrowed to a set of commits, or to what is not committed yet.
    async diffFiltered(taskId: string, filter: { shas: string[] } | { uncommitted: true }): Promise<DiffGroup[]> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path) return [];
        const env = this.env(task.env_id);
        const vars = parseEnvVars(env.env_vars);
        return "uncommitted" in filter ? [await uncommittedGroup(env, task.worktree_path, vars)] : commitsDiff(env, task.worktree_path, filter.shas, vars);
    }

    async commits(taskId: string): Promise<{ commits: BranchCommit[]; uncommitted: boolean }> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path) return { commits: [], uncommitted: false };
        const env = this.env(task.env_id);
        return branchCommits(env, task.worktree_path, parseEnvVars(env.env_vars));
    }

    setAccount(taskId: string, accountId: string): void {
        this.db.prepare(`UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?`).run(accountId, now(), taskId);
        this.emitTask(taskId);
    }

    setLabels(taskId: string, labels: TaskLabel[]): void {
        const clean = labels.map((l) => ({ text: l.text.trim().slice(0, 40), color: l.color })).filter((l) => l.text);
        this.db.prepare(`UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?`).run(clean.length ? JSON.stringify(clean) : null, now(), taskId);
        this.emitTask(taskId);
    }

    setNotes(taskId: string, notes: string | null): void {
        this.db.prepare(`UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?`).run(notes?.trim() || null, now(), taskId);
        this.emitTask(taskId);
    }

    // "I approved by mistake" / "I want this redone": send the task back to an earlier stage with notes, from any
    // non-running state. Stages with a prompt run again with the notes as reviewer notes (like Request changes);
    // User Review just waits for the human again.
    returnTo(taskId: string, stage: Stage, notes?: string, comments?: LineComment[]): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        const idx = STAGES.indexOf(stage);
        const cur = STAGES.indexOf(task.stage);
        if (idx < 0 || idx > cur) throw new Error(`cannot return to ${stage} from ${task.stage}`);
        const def = STAGE_DEFS[stage];
        const cs = comments ?? [];
        const prior = this.db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND stage = ? AND verdict = 'changes'`).get(taskId, stage) as { n: number };
        this.db
            .prepare(`INSERT INTO reviews (id, task_id, stage, verdict, route_to, notes, comments, created_at) VALUES (?, ?, ?, 'changes', ?, ?, ?, ?)`)
            .run(randomUUID(), taskId, stage, stage, notes?.trim() || null, cs.length ? JSON.stringify(cs) : null, now());
        this.setStage(taskId, stage);
        if (!def.prompt) {
            this.setTaskStatus(taskId, "waiting_user", `${def.label} · returned by you — needs you`);
            return;
        }
        const hasContent = !!notes?.trim() || cs.length > 0;
        this.dispatch(taskId, stage, {
            notes: hasContent
                ? `${renderReviewNotes(prior.n + 1, notes, cs)}\n\n(The task was sent back to this stage by the human after a later stage; later stages will run again after you.)`
                : "The human sent the task back to this stage without notes; re-examine the work and improve it. Later stages will run again after you.",
        });
    }

    // Everything a finished task still holds on this machine: its BE/FE, its tmux session, its worktree and local branch.
    // The task itself, its artifacts and history stay. Refuses to drop commits that exist nowhere else unless forced.
    async cleanup(taskId: string, force: boolean): Promise<{ done: string[]; skipped: string[] }> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        const result = await this.doCleanup(task, force, { removeWorktree: true });
        const line = `cleaned up · ${result.done.join(", ")}${result.skipped.length ? ` · ${result.skipped.join("; ")}` : ""}`;
        this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(line, now(), taskId);
        this.emitTask(taskId);
        return result;
    }

    // Shared by the "Clean up" button and Delete: stop BE/FE, close any Chrome tabs still open on them, kill the
    // terminal session, run the env's cleanup command, remove the worktree and local branch. Does NOT check task
    // status — callers that need "not while running" (cleanup()) check it themselves; Delete kills the run first
    // instead of refusing, since deleting is meant to work regardless.
    private async doCleanup(task: TaskRow, force: boolean, opts: { removeWorktree: boolean }): Promise<{ done: string[]; skipped: string[] }> {
        const env = this.env(task.env_id);
        const vars = parseEnvVars(env.env_vars);
        const done: string[] = [];
        const skipped: string[] = [];
        if (opts.removeWorktree && task.worktree_path && task.branch) {
            const checkouts = this.prCheckouts(task, env).filter((p) => existsSync(p));
            if (!force) {
                for (const cwd of checkouts) {
                    const remote = await this.git(cwd, ["ls-remote", "--heads", "origin", task.branch], env).catch(() => "");
                    const ahead = await this.git(cwd, ["log", "--oneline", remote ? `origin/${task.branch}..HEAD` : `origin/${env.base_branch}..HEAD`], env).catch(() => "");
                    const dirty = await this.git(cwd, ["status", "--porcelain"], env).catch(() => "");
                    if (ahead || dirty) {
                        const what = [ahead ? `${ahead.split("\n").length} unpushed commit(s)` : null, dirty ? "uncommitted changes" : null].filter(Boolean).join(" and ");
                        throw new Error(`${relative(task.worktree_path, cwd) || "the worktree"} has ${what} that exist nowhere else — push them first, or clean up anyway to discard them`);
                    }
                }
            }
        }
        // Capture the URLs before stopAll marks the service rows stopped (services.get only returns still-running rows).
        const be = this.services.get(task.id, "be");
        const fe = this.services.get(task.id, "fe");
        const tabUrls = [be?.url, fe?.url].filter((u): u is string => !!u);
        await this.services.stopAll(task.id);
        done.push("BE/FE stopped");
        if (tabUrls.length) {
            const closed = await closeChromeTabs(tabUrls).catch(() => 0);
            if (closed) done.push(`${closed} Chrome tab(s) closed`);
        }
        await killSession(taskSessionName(task.ticket_id));
        if (opts.removeWorktree && task.worktree_path && existsSync(task.worktree_path)) {
            if (env.cleanup_command) {
                this.setTaskStatus(task.id, task.status, "cleanup · running the environment's cleanup command");
                try {
                    await runWorktreeSetup(task.worktree_path, env.path, env.cleanup_command, vars);
                    done.push("cleanup command ran");
                } catch (e) {
                    skipped.push(`cleanup command failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
                }
            }
            if (task.branch) {
                await removeWorktreeAndBranch(env, task.worktree_path, task.branch, vars).catch((e: unknown) => skipped.push(`worktree: ${String((e as Error).message ?? e).slice(0, 160)}`));
                if (!existsSync(task.worktree_path)) done.push("worktree and local branch removed");
            }
        } else if (opts.removeWorktree && task.worktree_path) done.push("worktree already gone");
        if (opts.removeWorktree && task.worktree_path && !existsSync(task.worktree_path)) {
            this.db.prepare(`UPDATE tasks SET worktree_path = NULL, updated_at = ? WHERE id = ?`).run(now(), task.id);
        }
        rmSync(join(this.taskDir(task.id), "logs"), { recursive: true, force: true });
        return { done, skipped };
    }

    review(taskId: string, input: ReviewInput): void {
        const task = this.getTask(taskId);
        if (!task || task.status !== "waiting_user") throw new Error("task is not waiting for review");
        if (this.pendingQuestions(taskId)) throw new Error("the agent is waiting for answers to its questions — answer (or dismiss) them first");
        const comments = input.comments ?? [];
        const prior = this.db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND stage = ? AND verdict = 'changes'`).get(taskId, task.stage) as { n: number };
        this.db
            .prepare(`INSERT INTO reviews (id, task_id, stage, verdict, route_to, notes, comments, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), taskId, task.stage, input.verdict, input.routeTo ?? null, input.notes ?? null, comments.length ? JSON.stringify(comments) : null, input.repo ?? null, now());

        if (task.stage === "pr_creation_review") {
            this.reviewPrDraft(task, input, prior.n + 1);
            return;
        }
        if (input.verdict === "changes") {
            const target: Stage = task.stage === "design_proposal" || task.stage === "pr_fix" ? task.stage : (input.routeTo ?? "implementation");
            this.setStage(taskId, target);
            const hasContent = !!input.notes?.trim() || comments.length > 0;
            this.dispatch(taskId, target, {
                notes: hasContent ? renderReviewNotes(prior.n + 1, input.notes, comments) : "The reviewer requested changes without notes; re-examine the work and improve it.",
            });
            return;
        }
        const next = STAGE_DEFS[task.stage].next;
        if (!next) return;
        if (task.stage === "pr_fix") {
            void this.pushPrFix(taskId);
            return;
        }
        this.advance(taskId, next);
    }

    // ---------- pull requests (one per repository) ----------

    // Repositories a task opens PRs in: each sub-repo of a multi-repo workspace, or "" for the single repository.
    private prRepos(env: EnvRow): string[] {
        const subs = envRepos(env);
        return subs.length ? subs : [""];
    }

    private checkoutOf(task: TaskRow, env: EnvRow, repo: string): string {
        const wt = task.worktree_path ?? env.path;
        return repo ? join(wt, repo) : wt;
    }

    private async git(cwd: string, args: string[], env: EnvRow): Promise<string> {
        const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, ...parseEnvVars(env.env_vars) }, maxBuffer: 4 * 1024 * 1024 });
        return stdout.trim();
    }

    private async gh(cwd: string, args: string[], env: EnvRow): Promise<string> {
        const { stdout } = await execFileAsync("gh", args, { cwd, env: { ...process.env, ...parseEnvVars(env.env_vars) }, maxBuffer: 4 * 1024 * 1024 });
        return stdout.trim();
    }

    // Every git checkout of the task (one per repository), for cleanup.
    private prCheckouts(task: TaskRow, env: EnvRow): string[] {
        return this.prRepos(env).map((repo) => this.checkoutOf(task, env, repo));
    }

    prRows(taskId: string): PrStateRow[] {
        return this.db.prepare(`SELECT * FROM pr_state WHERE task_id = ? ORDER BY repo`).all(taskId) as PrStateRow[];
    }

    private prRow(taskId: string, repo: string): PrStateRow | undefined {
        return this.db.prepare(`SELECT * FROM pr_state WHERE task_id = ? AND repo = ?`).get(taskId, repo) as PrStateRow | undefined;
    }

    private upsertPrRow(taskId: string, repo: string, patch: Partial<Omit<PrStateRow, "task_id" | "repo" | "updated_at">>): void {
        const cur = this.prRow(taskId, repo);
        const next = { number: null, url: null, checks_json: null, review_decision: null, merged_at: null, pushed_at: null, approved_at: null, state: null, ...(cur ?? {}), ...patch };
        this.db
            .prepare(
                `INSERT INTO pr_state (task_id, repo, number, url, checks_json, review_decision, merged_at, pushed_at, approved_at, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(task_id, repo) DO UPDATE SET number = excluded.number, url = excluded.url, checks_json = excluded.checks_json, review_decision = excluded.review_decision, merged_at = excluded.merged_at, pushed_at = excluded.pushed_at, approved_at = excluded.approved_at, state = excluded.state, updated_at = excluded.updated_at`,
            )
            .run(taskId, repo, next.number, next.url, next.checks_json, next.review_decision, next.merged_at, next.pushed_at, next.approved_at, next.state, now());
    }

    // pr.json normalised to one draft per repository. A file from before per-repo drafts ({title, body, base}) is fanned
    // out to every repository of the env — that is what one shared draft used to mean.
    readPrDraft(taskId: string): (PrDraft & { legacy?: boolean }) | null {
        const raw = this.readArtifactJson<unknown>(taskId, "pr.json");
        if (!raw || typeof raw !== "object") return null;
        const parsed = PrDraft.safeParse(raw);
        if (parsed.success) return parsed.data;
        const old = raw as { title?: unknown; body?: unknown; base?: unknown };
        if (typeof old.title !== "string") return null;
        const task = this.getTask(taskId);
        const env = task ? this.env(task.env_id) : null;
        const repos = env ? this.prRepos(env) : [""];
        return { legacy: true, base: typeof old.base === "string" && old.base ? old.base : (env?.base_branch ?? "main"), drafts: repos.map((repo) => ({ repo, title: old.title as string, body: typeof old.body === "string" ? old.body : "" })) };
    }

    // Which repositories this task's PR review covers: the drafted ones, else every repository of the env.
    private draftRepos(taskId: string, env: EnvRow): string[] {
        const draft = this.readPrDraft(taskId);
        return draft?.drafts.length ? draft.drafts.map((d) => d.repo) : this.prRepos(env);
    }

    // The human edits one repository's drafted PR (title / markdown body) or the shared base before approving it.
    setPrDraft(taskId: string, patch: { repo?: string | undefined; title?: string | undefined; body?: string | undefined; base?: string | undefined }): PrDraft {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — wait for it to finish");
        const env = this.env(task.env_id);
        const current = this.readPrDraft(taskId) ?? { base: env.base_branch, drafts: [] };
        const repo = patch.repo ?? current.drafts[0]?.repo ?? "";
        if (this.prRow(taskId, repo)?.number) throw new Error(`the ${repoLabel(repo)} PR already exists on GitHub — edit it there`);
        const idx = current.drafts.findIndex((d) => d.repo === repo);
        const cur = idx >= 0 ? current.drafts[idx]! : { repo, title: "", body: "" };
        const entry = { repo, title: (patch.title ?? cur.title).trim(), body: patch.body ?? cur.body };
        if (!entry.title) throw new Error("the PR title cannot be empty");
        const drafts = idx >= 0 ? current.drafts.map((d, i) => (i === idx ? entry : d)) : [...current.drafts, entry];
        const next: PrDraft = { base: (patch.base ?? current.base ?? env.base_branch).trim() || env.base_branch, drafts };
        writeFileSync(join(this.taskDir(taskId), "pr.json"), JSON.stringify(next, null, 2));
        // An edited draft is no longer the approved one (only matters while its PR does not exist yet).
        if (patch.title !== undefined || patch.body !== undefined) this.db.prepare(`UPDATE pr_state SET approved_at = NULL, updated_at = ? WHERE task_id = ? AND repo = ? AND number IS NULL`).run(now(), taskId, repo);
        this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
        this.emitTask(taskId);
        return next;
    }

    // PR Creation Review is per repository: each draft is approved on its own (its PR is pushed/opened right away) and
    // the task moves on once every repository's draft is approved. "Changes" redoes the drafting run with notes aimed at
    // one repository; drafts whose PR already exists are untouched by that.
    private reviewPrDraft(task: TaskRow, input: ReviewInput, round: number): void {
        const env = this.env(task.env_id);
        const repos = this.draftRepos(task.id, env);
        const repo = input.repo ?? (repos.length === 1 ? repos[0]! : undefined);
        if (input.verdict === "changes") {
            this.db.prepare(`UPDATE pr_state SET approved_at = NULL, updated_at = ? WHERE task_id = ? AND number IS NULL`).run(now(), task.id);
            const scope = repo !== undefined && repos.length > 1 ? `\n\nRevise the draft for repository \`${repo}\` only; copy every other repository's draft from the current pr.json unchanged.` : "";
            const notes = input.notes?.trim() ? renderReviewNotes(round, input.notes, []) : "The reviewer requested changes without notes; re-examine the draft and improve it.";
            this.dispatch(task.id, "pr_creation_review", { notes: `${notes}${scope}` });
            return;
        }
        if (repo === undefined) throw new Error("say which repository's draft you approve");
        if (!repos.includes(repo)) throw new Error(`no draft for repository ${repo || "(root)"}`);
        void this.approvePrRepo(task.id, repo).catch((e: unknown) => console.warn(`[stagehand] approve PR ${task.ticket_id} ${repo}: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }

    private async approvePrRepo(taskId: string, repo: string): Promise<void> {
        this.upsertPrRow(taskId, repo, { approved_at: now() });
        const outcome = await this.createPrForRepo(taskId, repo);
        if (outcome === null) return; // failed; status already says why
        const task = this.getTask(taskId);
        if (!task) return;
        const env = this.env(task.env_id);
        const repos = this.draftRepos(taskId, env);
        const rows = this.prRows(taskId);
        const remaining = repos.filter((r) => !rows.find((x) => x.repo === r)?.approved_at);
        if (remaining.length) {
            this.setStage(taskId, "pr_creation_review");
            this.setTaskStatus(taskId, "waiting_user", `PR Creation Review · ${repoPrefix(repo, repos)}${outcome} — still to review: ${remaining.map((r) => repoLabel(r)).join(", ")}`);
            return;
        }
        this.setStage(taskId, "pr_waiting");
        this.syncPrTaskState(taskId, { force: true });
        this.pollPrSoon(taskId);
    }

    // Retry push/create for every approved repository that has no PR yet — e.g. after the env's rules were opened up,
    // or after the human committed what was missing. Returns one outcome line per repository tried.
    async createApprovedPrs(taskId: string): Promise<string[]> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — wait for it to finish");
        const pending = this.prRows(taskId).filter((r) => r.approved_at && !r.number);
        if (pending.length === 0) throw new Error("every approved repository already has its PR");
        const out: string[] = [];
        for (const row of pending) {
            const outcome = await this.createPrForRepo(taskId, row.repo);
            if (outcome === null) return out; // failed; the task status says why
            out.push(`${repoLabel(row.repo)}: ${outcome}`);
        }
        await this.pollAllPrs(this.getTask(taskId)!, { force: true }).catch(() => undefined);
        return out;
    }

    // After the human approves one repository's draft: push that checkout (if allowed) and open its PR (if allowed);
    // otherwise say what the human has to do. Returns a short outcome for the status line, or null after a failure
    // (the task status already carries the error). The poller later tracks the PR by head branch, so a PR opened by
    // hand is picked up the same way.
    private async createPrForRepo(taskId: string, repo: string): Promise<string | null> {
        const task = this.getTask(taskId);
        if (!task?.branch) return null;
        const env = this.env(task.env_id);
        const rules = rulesOf(this.configDirOf(env));
        const draft = this.readPrDraft(taskId);
        const entry = draft?.drafts.find((d) => d.repo === repo);
        const cwd = this.checkoutOf(task, env, repo);
        const existing = this.prRow(taskId, repo);
        const ahead = await this.git(cwd, ["log", "--oneline", `origin/${env.base_branch}..HEAD`], env).catch(() => "");
        const dirty = await this.git(cwd, ["status", "--porcelain"], env).catch(() => "");
        // Nothing committed but changes on disk: an env that forbids agent commits (or an agent that left work
        // uncommitted) — the human has to commit before anything can be pushed or opened.
        if (!ahead && dirty.trim()) return `${dirty.trim().split("\n").length} changed file(s) are not committed — commit and push \`${task.branch}\` yourself, then open the PR (draft below)`;
        if (!ahead) return `nothing to ship: no commits ahead of ${env.base_branch}`;
        if (!rules.allowPush) {
            return existing?.number
                ? `push \`${task.branch}\` yourself — PR #${existing.number} picks the commits up`
                : `this env forbids agent pushes — push \`${task.branch}\` and open the PR yourself (draft below); Stagehand picks it up by branch`;
        }
        this.setTaskStatus(taskId, "running", `PR Creation Review · pushing ${repoLabel(repo)} (${task.branch})`);
        try {
            await this.git(cwd, ["push", "-u", "origin", task.branch], env);
        } catch (e) {
            this.setTaskStatus(taskId, "failed", `${repoLabel(repo)}: push failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
            return null;
        }
        // A task sent back after its PR existed just needs the push; the open PR picks the new commits up.
        if (existing?.number) {
            this.resetPrState(taskId, repo);
            return `pushed to PR #${existing.number}`;
        }
        if (!rules.allowPrCreate || !entry) {
            this.upsertPrRow(taskId, repo, { pushed_at: now() });
            return `pushed \`${task.branch}\` — this env forbids agent PR creation: open the PR yourself (draft below); Stagehand picks it up by branch`;
        }
        try {
            const url = await this.gh(cwd, ["pr", "create", "--base", draft?.base || env.base_branch, "--head", task.branch, "--title", entry.title, "--body", entry.body, ...(env.pr_draft ? ["--draft"] : [])], env);
            const number = Number(url.split("/").pop());
            this.upsertPrRow(taskId, repo, { number: Number.isFinite(number) ? number : null, url, pushed_at: now(), state: "OPEN" });
            return `PR #${Number.isFinite(number) ? number : "?"} created`;
        } catch (e) {
            this.setTaskStatus(taskId, "failed", `${repoLabel(repo)}: gh pr create failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
            return null;
        }
    }

    // A push changed the PR's head: what was known about checks and review verdicts describes the old commit. Drop it and
    // remember when the push happened, so the next poll starts from "nothing reported yet" instead of stale green/red.
    private resetPrState(taskId: string, repo: string): void {
        this.upsertPrRow(taskId, repo, { checks_json: null, review_decision: null, pushed_at: now() });
        this.prCommentsCache.delete(`${taskId}:${repo}`);
    }

    // Poll every PR of the task now (a few seconds after a push GitHub already knows the new head), not at the next tick.
    private pollPrSoon(taskId: string, delayMs = 4_000): void {
        setTimeout(() => {
            const task = this.getTask(taskId);
            if (task) void this.pollAllPrs(task).catch((e: unknown) => console.warn(`[stagehand] PR poll ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
        }, delayMs).unref();
    }

    // Human-triggered: forget the cached comments, re-read every PR now.
    async refreshPr(taskId: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        for (const key of [...this.prCommentsCache.keys()]) if (key.startsWith(`${taskId}:`)) this.prCommentsCache.delete(key);
        await this.pollAllPrs(task, { force: true });
    }

    // Merges one repository's PR as the human (a button they click). The task reaches Done once every PR is merged.
    async mergePr(taskId: string, repo: string, method: "squash" | "merge" | "rebase", deleteBranch: boolean): Promise<string> {
        const task = this.getTask(taskId);
        if (!task?.branch) throw new Error("task has no branch");
        const env = this.env(task.env_id);
        const row = this.prRow(taskId, repo);
        if (!row?.number) throw new Error(`no PR recorded for ${repoLabel(repo)} yet`);
        if (row.merged_at) throw new Error("already merged");
        const cwd = this.checkoutOf(task, env, repo);
        this.setTaskStatus(taskId, "running", `merging ${repoLabel(repo)} ${row.url ?? `#${row.number}`} (${method})`);
        try {
            await this.gh(cwd, ["pr", "merge", String(row.number), `--${method}`], env);
        } catch (e) {
            const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message ?? e).trim().split("\n").slice(-2).join(" ").slice(0, 200);
            this.setTaskStatus(taskId, "idle", `${repoLabel(repo)}: merge failed: ${msg} · ${row.url ?? ""}`);
            throw new Error(`merge failed: ${msg}`);
        }
        let note = "";
        if (deleteBranch) {
            // Not `--delete-branch`: from a worktree that would also try to check the base branch out here.
            await this.git(cwd, ["push", "origin", "--delete", task.branch], env).catch((e: unknown) => {
                note = ` (remote branch not deleted: ${String((e as Error).message ?? e).slice(0, 80)})`;
            });
        }
        this.setTaskStatus(taskId, "idle", `${repoLabel(repo)}: merged${note} · ${row.url ?? ""}`);
        await this.pollAllPrs(this.getTask(taskId)!, { force: true }).catch(() => undefined);
        return `merged${note}`;
    }

    // Everything said on one repository's PR: review summaries, line comments and general comments, split into human vs
    // automation by the env's handle list.
    async prComments(taskId: string, repo: string): Promise<PrComments | null> {
        const task = this.getTask(taskId);
        if (!task) return null;
        const row = this.prRow(taskId, repo);
        if (!row?.number) return null;
        const key = `${taskId}:${repo}`;
        const cached = this.prCommentsCache.get(key);
        if (cached && Date.now() - cached.at < 60_000) return cached.data;
        const env = this.env(task.env_id);
        const cwd = this.checkoutOf(task, env, repo);
        const ghRepo = (JSON.parse(await this.gh(cwd, ["repo", "view", "--json", "nameWithOwner"], env)) as { nameWithOwner: string }).nameWithOwner;
        const n = row.number;
        const [reviewsRaw, lineRaw, generalRaw, threads] = await Promise.all([
            this.gh(cwd, ["api", `repos/${ghRepo}/pulls/${n}/reviews`, "--paginate"], env),
            this.gh(cwd, ["api", `repos/${ghRepo}/pulls/${n}/comments`, "--paginate"], env),
            this.gh(cwd, ["api", `repos/${ghRepo}/issues/${n}/comments`, "--paginate"], env),
            this.reviewThreads(cwd, ghRepo, n, env).catch((e: unknown) => {
                console.warn(`[stagehand] review threads for #${n}: ${String((e as Error).message ?? e).slice(0, 160)}`);
                return new Map<number, { threadId: string; resolved: boolean }>();
            }),
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
            // Paths come back relative to that repository; prefix the sub-repo dir so they match the task's diff view.
            path: repo ? `${repo}/${c.path}` : c.path,
            line: c.line ?? c.original_line ?? null,
            side: c.side === "LEFT" ? ("old" as const) : ("new" as const),
            outdated: c.line === null,
            body: c.body,
            at: c.created_at,
            url: c.html_url,
            replyTo: c.in_reply_to_id ?? null,
            snippet: (c.diff_hunk ?? "").split("\n").pop()?.replace(/^[+\- ]/, "") ?? "",
            threadId: threads.get(c.id)?.threadId ?? null,
            resolved: threads.get(c.id)?.resolved ?? false,
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
            repo: ghRepo,
            repoDir: repo,
            human: all.filter((c) => !isBot(c.author)),
            automation: all.filter((c) => isBot(c.author)),
            fetchedAt: now(),
        };
        this.prCommentsCache.set(key, { at: Date.now(), data });
        return data;
    }
    private prCommentsCache = new Map<string, { at: number; data: PrComments }>();

    // Resolution lives on review threads, which only GraphQL exposes: one map from each line comment's REST id to
    // its thread (node id + resolved flag), across every page of threads.
    private async reviewThreads(cwd: string, repo: string, n: number, env: EnvRow): Promise<Map<number, { threadId: string; resolved: boolean }>> {
        const [owner, name] = repo.split("/") as [string, string];
        const out = new Map<number, { threadId: string; resolved: boolean }>();
        let after: string | null = null;
        for (let page = 0; page < 10; page++) {
            const query = `query($owner:String!,$name:String!,$n:Int!,$after:String){ repository(owner:$owner,name:$name){ pullRequest(number:$n){ reviewThreads(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id isResolved comments(first:100){ nodes{ databaseId } } } } } } }`;
            const args = ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${n}`, ...(after ? ["-F", `after=${after}`] : [])];
            const raw = JSON.parse(await this.gh(cwd, args, env)) as {
                data?: { repository?: { pullRequest?: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; isResolved: boolean; comments: { nodes: Array<{ databaseId: number | null }> } }> } } } };
            };
            const threads = raw.data?.repository?.pullRequest?.reviewThreads;
            if (!threads) break;
            for (const t of threads.nodes) for (const c of t.comments.nodes) if (c.databaseId != null) out.set(c.databaseId, { threadId: t.id, resolved: t.isResolved });
            if (!threads.pageInfo.hasNextPage || !threads.pageInfo.endCursor) break;
            after = threads.pageInfo.endCursor;
        }
        return out;
    }

    // Marks a review thread resolved (or reopens it) on GitHub, as the human — a button they click, not an agent action.
    async resolvePrComment(taskId: string, repo: string, commentId: number, resolved: boolean): Promise<PrComments | null> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const comments = await this.prComments(taskId, repo);
        const target = comments?.human.concat(comments.automation).find((c) => c.id === commentId);
        if (!target || target.kind !== "line") throw new Error("comment not found — refresh and try again");
        if (!target.threadId) throw new Error("this comment has no review thread to resolve");
        const env = this.env(task.env_id);
        const cwd = this.checkoutOf(task, env, repo);
        const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
        const raw = JSON.parse(await this.gh(cwd, ["api", "graphql", "-f", `query=mutation($id:ID!){ ${mutation}(input:{threadId:$id}){ thread{ id isResolved } } }`, "-F", `id=${target.threadId}`], env)) as {
            data?: Record<string, { thread?: { isResolved: boolean } } | null>;
            errors?: Array<{ message: string }>;
        };
        if (raw.errors?.length) throw new Error(raw.errors.map((e) => e.message).join("; "));
        this.prCommentsCache.delete(`${taskId}:${repo}`);
        return this.prComments(taskId, repo);
    }

    // Every few ticks: look every PR up (by stored number or by head branch) and move the task through
    // pr_waiting → pr_green → pr_approved → done from the aggregate of its repositories. Blocked tasks (failing checks)
    // are polled too — a re-run or a fix pushed by hand must be noticed without a click.
    private pollCounter = 0;
    private pollPrs(): void {
        if (++this.pollCounter % 8 !== 0) return; // scheduler ticks every 15 s → every 2 min
        const tasks = this.db.prepare(`SELECT * FROM tasks WHERE stage IN ('pr_waiting','pr_green','pr_approved') AND status IN ('idle', 'blocked')`).all() as TaskRow[];
        for (const task of tasks) void this.pollAllPrs(task).catch((e: unknown) => console.warn(`[stagehand] PR poll ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }

    // Once a push is this recent, "no checks reported" means GitHub has not registered them yet, not that there are none.
    private static readonly CHECKS_GRACE_MS = 10 * 60_000;

    private async pollAllPrs(task: TaskRow, opts: { force?: boolean } = {}): Promise<void> {
        if (!task.branch) return;
        const env = this.env(task.env_id);
        for (const repo of this.draftRepos(task.id, env)) {
            await this.pollPr(task, repo).catch((e: unknown) => console.warn(`[stagehand] PR poll ${task.ticket_id} ${repo || "(root)"}: ${String((e as Error).message ?? e).slice(0, 160)}`));
        }
        this.syncPrTaskState(task.id, opts);
    }

    // Reads one repository's PR from GitHub into its pr_state row; false when that repository has no PR yet.
    private async pollPr(task: TaskRow, repo: string): Promise<boolean> {
        if (!task.branch) return false;
        const env = this.env(task.env_id);
        const cwd = this.checkoutOf(task, env, repo);
        if (!existsSync(cwd)) return false;
        const row = this.prRow(task.id, repo);
        let number = row?.number ?? null;
        if (!number) {
            const list = JSON.parse(await this.gh(cwd, ["pr", "list", "--head", task.branch, "--state", "all", "--json", "number,url", "--limit", "1"], env)) as Array<{ number: number; url: string }>;
            if (!list[0]) return false;
            number = list[0].number;
            this.upsertPrRow(task.id, repo, { number, url: list[0].url });
        }
        const pr = JSON.parse(await this.gh(cwd, ["pr", "view", String(number), "--json", "url,state,mergedAt,reviewDecision,statusCheckRollup"], env)) as {
            url: string;
            state: string;
            mergedAt: string | null;
            reviewDecision: string;
            statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string; startedAt?: string; completedAt?: string; detailsUrl?: string; targetUrl?: string; workflowName?: string }>;
        };
        this.upsertPrRow(task.id, repo, { url: pr.url, checks_json: JSON.stringify(pr.statusCheckRollup ?? []), review_decision: pr.reviewDecision ?? null, merged_at: pr.mergedAt ?? null, state: pr.state ?? null });
        return true;
    }

    // One repository's PR in a word, from its stored row.
    private prRepoSummary(row: PrStateRow | undefined): { kind: "none" | "manual" | "pending" | "failed" | "green" | "approved" | "merged" | "closed"; text: string } {
        if (!row?.number) return row?.approved_at ? { kind: "manual", text: "not on GitHub yet — push / open it" } : { kind: "none", text: "not approved yet" };
        const n = `#${row.number}`;
        if (row.merged_at) return { kind: "merged", text: `${n} merged` };
        if (row.state === "CLOSED") return { kind: "closed", text: `${n} closed without merge` };
        let checks: Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string }> = [];
        try {
            checks = row.checks_json ? (JSON.parse(row.checks_json) as typeof checks) : [];
        } catch {
            checks = [];
        }
        const gated = checks.filter((c) => !isApprovalGateCheck(c));
        const failed = gated.filter(isFailedCheck);
        const pending = gated.filter((c) => !c.conclusion && !/SUCCESS|FAILURE|ERROR/i.test(c.state ?? "") && (c.status ?? "") !== "COMPLETED");
        const cancelled = gated.filter(isCancelledCheck);
        const justPushed = !!row.pushed_at && Date.now() - new Date(row.pushed_at).getTime() < Engine.CHECKS_GRACE_MS;
        if (failed.length) return { kind: "failed", text: `${n} ${failed.length} check(s) failing (${failed.map((c) => c.name ?? c.context ?? "check").join(", ")})` };
        if (pending.length) return { kind: "pending", text: `${n} ${pending.length} check(s) running` };
        if (gated.length === 0 && justPushed) return { kind: "pending", text: `${n} pushed, waiting for checks to start` };
        if (row.review_decision === "APPROVED") return { kind: "approved", text: `${n} approved, waiting for merge` };
        const cancelNote = cancelled.length ? ` (${cancelled.length} cancelled)` : "";
        return { kind: "green", text: `${n} ${gated.length > cancelled.length ? "checks passed" : "no checks"}${cancelNote}, waiting for review` };
    }

    // The task's stage/status/line from the aggregate of its PRs: any red → blocked; anything not yet on GitHub or
    // still checking → waiting; every PR merged → done; every PR approved → PR Approved; otherwise PR Green.
    private syncPrTaskState(taskId: string, opts: { force?: boolean } = {}): void {
        const cur = this.getTask(taskId);
        if (!cur) return;
        if (!["pr_waiting", "pr_green", "pr_approved"].includes(cur.stage)) return;
        if (!opts.force && cur.status !== "idle" && cur.status !== "blocked") {
            // Something else took the task over meanwhile (a PR Fix run, a return to an earlier stage) — only record, don't steer.
            this.emitTask(taskId);
            return;
        }
        const env = this.env(cur.env_id);
        const repos = this.draftRepos(taskId, env);
        const rows = this.prRows(taskId);
        const summaries = repos.map((repo) => ({ repo, ...this.prRepoSummary(rows.find((r) => r.repo === repo)) }));
        const line = summaries.map((s) => `${repoPrefix(s.repo, repos)}${s.text}`).join(" · ");
        const kinds = new Set(summaries.map((s) => s.kind));
        const all = (k: string) => summaries.every((s) => s.kind === k);
        // Only re-announce a blocked/idle line when it actually changed, so a still-red PR does not re-notify every poll.
        const set = (stage: Stage, status: TaskStatus, text: string): void => {
            if (cur.stage !== stage) this.setStage(taskId, stage);
            if (cur.status === status && cur.status_line === text) {
                this.emitTask(taskId);
                return;
            }
            this.setTaskStatus(taskId, status, text);
        };
        if (all("merged")) return set("done", "done", `merged · ${rows.map((r) => r.url).filter(Boolean).join(" ")}`);
        if (kinds.has("failed")) return set("pr_waiting", "blocked", `PR Waiting · ${line} — click Fix CI on the failing PR, or fix it yourself`);
        if (kinds.has("none") || kinds.has("manual") || kinds.has("pending")) return set("pr_waiting", "idle", `PR Waiting · ${line}`);
        if (summaries.every((s) => s.kind === "closed" || s.kind === "merged")) return set("pr_waiting", "stopped", `PR closed without merge · ${line}`);
        if (summaries.every((s) => s.kind === "approved" || s.kind === "merged")) return set("pr_approved", "idle", `PR Approved · ${line}`);
        set("pr_green", "idle", `PR Green · ${line}`);
    }

    // Human-triggered only (button in the UI) — never automatic. Re-reads that repository's checks fresh (the stored row
    // can be up to ~2 minutes stale) and dispatches PR Fix, which commits a fix locally but does not push; the human
    // reviews the diff and approves or requests changes before pushPrFix() ever runs.
    async startPrFix(taskId: string, repo: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        const env = this.env(task.env_id);
        const row = this.prRow(taskId, repo);
        if (!row?.number) throw new Error(`no PR recorded for ${repoLabel(repo)} yet`);
        const cwd = this.checkoutOf(task, env, repo);
        const pr = JSON.parse(await this.gh(cwd, ["pr", "view", String(row.number), "--json", "statusCheckRollup"], env)) as {
            statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string }>;
        };
        const failed = (pr.statusCheckRollup ?? []).filter((c) => !isApprovalGateCheck(c) && isFailedCheck(c));
        if (!failed.length) throw new Error("no failing checks right now — re-poll first");
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        const names = failed.map((c) => c.name ?? c.context ?? "check").join(", ");
        this.setStage(taskId, "pr_fix");
        this.dispatch(taskId, "pr_fix", {
            attempt: rounds.n + 1,
            extraVars: { failureOutput: `${repoScopeNote(repo)}Failing checks on PR #${row.number}: ${names}. Read their logs with \`gh pr checks ${row.number}\` and \`gh run view --log-failed <run-id>\` (run inside that repository) before changing anything.` },
        });
    }

    // Human-triggered only (checkbox picks on the PR comments tab). Same commit-locally-then-review-the-diff cycle as
    // startPrFix, just sourced from one PR's comments instead of failing checks.
    async startPrCommentFix(taskId: string, repo: string, commentIds: number[]): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        const row = this.prRow(taskId, repo);
        if (!row?.number) throw new Error(`no PR recorded for ${repoLabel(repo)} yet`);
        const comments = await this.prComments(taskId, repo);
        if (!comments) throw new Error("could not fetch PR comments — re-poll and try again");
        const wanted = new Set(commentIds);
        const picked = [...comments.human, ...comments.automation].filter((c) => wanted.has(c.id));
        if (!picked.length) throw new Error("none of the selected comments were found — they may be stale, refresh and re-select");
        const describe = (c: PrComment): string =>
            c.kind === "line"
                ? `- \`${c.path}:${c.line ?? "?"}\`${c.outdated ? " (outdated diff position)" : ""} — ${c.author}: ${c.body.trim()}`
                : c.kind === "review"
                  ? `- Review by ${c.author}${c.state !== "COMMENTED" ? ` (${c.state.toLowerCase().replace("_", " ")})` : ""}: ${c.body.trim() || "(no body text)"}`
                  : `- ${c.author}: ${c.body.trim()}`;
        const failureOutput = `${repoScopeNote(repo)}${picked.length} comment(s) on PR #${row.number} picked by the human to address (this is not necessarily a CI failure):\n${picked.map(describe).join("\n")}`;
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        this.setStage(taskId, "pr_fix");
        this.dispatch(taskId, "pr_fix", { attempt: rounds.n + 1, extraVars: { failureOutput } });
    }

    // After the human approves a PR Fix (already committed locally, never pushed): push every checkout that has
    // unpushed commits, reset those PRs' checks and resume polling.
    private async pushPrFix(taskId: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task?.branch) return;
        const env = this.env(task.env_id);
        const rules = rulesOf(this.configDirOf(env));
        if (!rules.allowPush) {
            this.setStage(taskId, "pr_waiting");
            this.setTaskStatus(taskId, "idle", `PR Waiting · this env forbids agent pushes — push \`${task.branch}\` yourself; Stagehand resumes polling once you do`);
            return;
        }
        this.setTaskStatus(taskId, "running", "PR Fix · pushing the approved fix");
        try {
            for (const repo of this.prRepos(env)) {
                const cwd = this.checkoutOf(task, env, repo);
                if (!existsSync(cwd)) continue;
                const remote = await this.git(cwd, ["ls-remote", "--heads", "origin", task.branch], env).catch(() => "");
                const ahead = await this.git(cwd, ["log", "--oneline", remote ? `origin/${task.branch}..HEAD` : `origin/${env.base_branch}..HEAD`], env).catch(() => "");
                if (!ahead) continue;
                await this.git(cwd, ["push", "-u", "origin", task.branch], env);
                this.resetPrState(taskId, repo);
            }
        } catch (e) {
            this.setTaskStatus(taskId, "failed", `push failed: ${String((e as Error).message ?? e).slice(0, 160)}`);
            return;
        }
        this.advance(taskId, "pr_waiting");
        this.pollPrSoon(taskId);
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
        const asking = task.status === "waiting_user" && !!this.pendingQuestions(task.id);
        const verb = asking ? "has questions for you" : task.status === "waiting_user" ? "needs your review" : task.status === "blocked" ? "is blocked" : task.status === "failed" ? "failed" : "is rate-limited";
        void notify(this.cfg, {
            title: `${task.ticket_id} ${verb} · ${label}`,
            message: task.status_line ?? label,
            priority,
            tags: [asking ? "question" : task.status === "waiting_user" ? "eyes" : task.status === "failed" ? "x" : task.status === "blocked" ? "no_entry" : "hourglass"],
            ...(taskLink(this.cfg, task.id) ? { url: taskLink(this.cfg, task.id)! } : {}),
            localUrl: localTaskLink(this.cfg, task.id),
            group: `stagehand-${task.id}`,
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

    // ---------- chat: the human's own Q&A / notes channel with the task's agent ----------

    listMessages(taskId: string): MessageRow[] {
        return this.db.prepare(`SELECT * FROM messages WHERE task_id = ? ORDER BY created_at`).all(taskId) as MessageRow[];
    }

    private addMessage(taskId: string, role: "user" | "agent", text: string): MessageRow {
        const id = randomUUID();
        this.db.prepare(`INSERT INTO messages (id, task_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, taskId, role, text, now());
        const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow;
        this.emit("message", row);
        return row;
    }

    // A note the agent leaves for the human on its own, outside the chat exchange (e.g. implementation notes, a CI
    // fix summary) — same table, same tab, so the human sees explanations and answers to their own questions together.
    private addAgentNote(taskId: string, text: string): void {
        const trimmed = text.trim();
        if (trimmed) this.addMessage(taskId, "agent", trimmed);
    }

    // Asks the task's agent a question in its own session (full context: everything it has done on this task so far).
    // Same constraint as the terminal: a headless stage run and an ad-hoc chat turn cannot share the session at once.
    async askAgent(taskId: string, text: string): Promise<MessageRow> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a headless run owns this session right now — ask again once it's idle");
        this.addMessage(taskId, "user", text);
        const env = this.env(task.env_id);
        const cd = this.configDirOf(env);
        const usable = this.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === env.default_account_id) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        const prompt =
            `The human sent this in the task's chat — a question or comment, not necessarily an instruction: "${text.replace(/"/g, '\\"')}"\n\n` +
            `Answer directly and briefly, drawing on this task's own history (research, design, code, QA) as needed. ` +
            `If they are actually asking for a change, say what you would do and that it happens through the normal stage flow (Return to a stage, or a new review round) — do not make code changes from this chat.`;
        const run = startClaude({
            prompt,
            cwd: task.worktree_path ?? env.path,
            configDir: cd.path,
            extraEnv: { ...parseEnvVars(env.env_vars), ...authEnv(acc) },
            resume: task.session_id,
            maxTurns: 15,
            ...(task.model ? { model: task.model } : {}),
        });
        const outcome = await run.done;
        if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "chat", stage: null }, outcome.result);
        const reply = outcome.result?.result?.trim() || (outcome.exitCode !== 0 ? `(could not answer: ${outcome.stderr.trim().split("\n").slice(-2).join(" ").slice(-200) || `exit ${outcome.exitCode}`})` : "(no reply)");
        return this.addMessage(taskId, "agent", reply);
    }

    // Every archived Manual QA attempt for this task (oldest first) — the run(s) that failed and got auto-returned to
    // Implementation before the current/latest qa/after.json. Empty when Manual QA has not failed and auto-looped yet.
    qaHistory(taskId: string): Array<{ attempt: number; data: QaPassResult | null }> {
        return qaAttemptFiles(this.taskDir(taskId)).map(({ n, path }) => {
            try {
                return { attempt: n, data: QaPassResult.parse(JSON.parse(readFileSync(path, "utf8"))) };
            } catch {
                return { attempt: n, data: null };
            }
        });
    }

    // The stored tickets of a task: ticket.json plus tickets/<id>.json for a batch; missing or invalid files are skipped.
    tickets(task: TaskRow): Ticket[] {
        const files = ["ticket.json", ...extraTicketsOf(task).map((x) => extraTicketFile(x.id))];
        const out: Ticket[] = [];
        for (const f of files) {
            const raw = this.readArtifactJson<unknown>(task.id, f);
            const parsed = raw ? Ticket.safeParse(raw) : null;
            if (parsed?.success) out.push(parsed.data);
        }
        return out;
    }

    private promptVars(task: TaskRow, def: StageDef, opts: DispatchOpts): Record<string, string> {
        const env = this.env(task.env_id);
        const taskDir = this.taskDir(task.id);
        const tickets = this.tickets(task);
        const extras = extraTicketsOf(task);
        const allIds = [task.ticket_id, ...extras.map((x) => x.id)];
        const vars: Record<string, string> = {
            ticketId: allIds.join(" + "),
            ticketIdUpper: task.ticket_id.toUpperCase(),
            ticketIds: allIds.join(", "),
            ticketSource: task.source,
            ticketUrl: task.ticket_url ?? "",
            ticket: tickets.length
                ? renderTicketsForPrompt(tickets, taskDir) +
                  (tickets.length < allIds.length ? `\n\n(Stagehand could not fetch ${allIds.filter((id) => !tickets.some((t) => t.id === id)).join(", ")} server-side — fetch them yourself with the ${task.source} MCP tool.)` : "")
                : `(Stagehand could not fetch the ticket server-side. Fetch ${task.source} ticket ${allIds.join(", ")} yourself with the ${task.source} MCP tool — for ClickUp: mcp__clickup__clickup_get_task with detail_level "detailed", and its parent if any. If that fails too, write the output file with classification "feature", title "TICKET FETCH FAILED" and the error in summary.)`,
            taskNotes: task.notes?.trim() ? `## Instructions from the human for this task (apply them throughout)\n\n${task.notes.trim()}` : "",
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
            askHuman: askHumanBlock(taskDir),
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
            // The account's chrome_capable flag is only as fresh as the last manual Probe Chrome — it can go stale (the
            // extension disconnects, Chrome restarts, a new config dir was never introduced to it). Confirm live, once,
            // right before spending a full QA run on a bridge that will not answer.
            if (!opts.chromeVerified) {
                this.setTaskStatus(taskId, "running", `${def.label} · confirming the Chrome bridge is connected`);
                void probeChrome(chrome.configDir, task.worktree_path ?? env.path, 1)
                    .then((r) => {
                        if (r.ok) {
                            this.dispatch(taskId, stage, { ...opts, chromeVerified: true });
                            return;
                        }
                        this.db.prepare(`UPDATE accounts SET chrome_capable = 0, chrome_device_id = NULL, chrome_browser_name = NULL WHERE id = ?`).run(chrome.account.id);
                        this.setTaskStatus(
                            taskId,
                            "blocked",
                            `${def.label} · Chrome extension is not connected for ${chrome.account.name} (checked ${chrome.configDir}) — open Chrome, confirm the extension is installed and signed into this account, then AI accounts → Probe Chrome`,
                        );
                    })
                    .catch((e: unknown) => this.setTaskStatus(taskId, "blocked", `${def.label} · Chrome check failed: ${String((e as Error).message ?? e).slice(0, 160)}`));
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
        this.dismissPendingQuestions(taskId);
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
                this.emitTask(taskId);
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
        this.emitTask(task.id);
        return true;
    }

    recordRateLimit(accountId: string, info: RateLimitInfo): void {
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
        this.emitTask(task.id);
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
            calibrateWindows(this.db, account.id, outcome.firstRateLimit, outcome.lastRateLimit, outcome.result?.total_cost_usd);
        };

        const limited = outcome.lastRateLimit && outcome.lastRateLimit.status !== "allowed";
        if (limited && outcome.lastRateLimit?.resetsAt) {
            finish("rate_limited", "rate limited");
            this.queueRateLimited(task, account, outcome.lastRateLimit.resetsAt, `rate limited on ${account.name}`);
            return;
        }
        // The agent handed a decision to the human (questions.json written by this run, no valid output): park the task
        // until the answers arrive; the same session is then resumed with them.
        const asked = this.questionsAskedDuringRun(taskId, runId);
        if (asked && !(def.contract && def.outputFile && this.outputWrittenDuringRun(taskId, def.outputFile, runId) && this.validateOutput(taskId, def).ok)) {
            finish("blocked", `asked the human ${asked.questions.length} question(s)`);
            this.parkOnQuestions(taskId, runId, def, asked, opts);
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

    // ---------- questions: the agent asks, the human answers, the stage resumes ----------

    // questions.json written (or rewritten) by this run and valid; a stale file from an earlier run does not count.
    private questionsAskedDuringRun(taskId: string, runId: string): QuestionsFile | null {
        if (!this.outputWrittenDuringRun(taskId, "questions.json", runId)) return null;
        const raw = this.readArtifactJson<unknown>(taskId, "questions.json");
        const parsed = QuestionsFile.safeParse(raw);
        return parsed.success ? parsed.data : null;
    }

    private parkOnQuestions(taskId: string, runId: string, def: StageDef, asked: QuestionsFile, opts: DispatchOpts): void {
        const id = randomUUID();
        // Keep what the run was started with (reviewer notes, PR-fix failure text, attempt) so the resumed run gets the same brief.
        const resume = { notes: opts.notes ?? null, attempt: opts.attempt ?? 1, extraVars: opts.extraVars ?? {} };
        this.db
            .prepare(`INSERT INTO questions (id, task_id, run_id, stage, questions, answers, created_at, answered_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`)
            .run(id, taskId, runId, def.stage, JSON.stringify({ ...asked, resume }), now());
        // The file has served its purpose; a leftover would otherwise look like a fresh question to a later run's check (mtime guards, but keep the dir clean).
        const p = join(this.taskDir(taskId), "questions.json");
        if (existsSync(p)) renameSync(p, join(this.taskDir(taskId), `questions-${Date.now()}.json`));
        this.addMessage(taskId, "agent", `**${def.label} — I need your input before continuing:**\n\n${asked.questions.map((q) => `- **${q.id}** ${q.text}${q.context ? `\n  _${q.context}_` : ""}${q.options.length ? `\n  options: ${q.options.join(" · ")}` : ""}`).join("\n")}`);
        this.setTaskStatus(taskId, "waiting_user", `${def.label} · ${asked.questions.length} question(s) for you`);
    }

    listQuestions(taskId: string): Array<{ id: string; run_id: string | null; stage: Stage; questions: AgentQuestion[]; answers: Record<string, string> | null; created_at: string; answered_at: string | null }> {
        const rows = this.db.prepare(`SELECT * FROM questions WHERE task_id = ? ORDER BY created_at`).all(taskId) as QuestionRow[];
        return rows.map((r) => {
            let questions: AgentQuestion[] = [];
            let answers: Record<string, string> | null = null;
            try {
                questions = (JSON.parse(r.questions) as QuestionsFile).questions;
            } catch {
                /* unreadable row */
            }
            try {
                answers = r.answers ? (JSON.parse(r.answers) as Record<string, string>) : null;
            } catch {
                /* unreadable row */
            }
            return { id: r.id, run_id: r.run_id, stage: r.stage, questions, answers, created_at: r.created_at, answered_at: r.answered_at };
        });
    }

    pendingQuestions(taskId: string): QuestionRow | undefined {
        return this.db.prepare(`SELECT * FROM questions WHERE task_id = ? AND answers IS NULL ORDER BY created_at DESC LIMIT 1`).get(taskId) as QuestionRow | undefined;
    }

    // A rerun / return / retry started something else: the open questions are moot, mark them so instead of leaving them pending forever.
    private dismissPendingQuestions(taskId: string): void {
        this.db.prepare(`UPDATE questions SET answers = '{"__dismissed__":"true"}', answered_at = ? WHERE task_id = ? AND answers IS NULL`).run(now(), taskId);
    }

    // Stores the answers and resumes the stage that asked, in the same session, with the answers as notes.
    answerQuestions(taskId: string, questionRowId: string, answers: Record<string, string>): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress");
        const row = this.db.prepare(`SELECT * FROM questions WHERE id = ? AND task_id = ?`).get(questionRowId, taskId) as QuestionRow | undefined;
        if (!row) throw new Error("questions not found");
        if (row.answers) throw new Error("these questions were already answered");
        const stored = JSON.parse(row.questions) as QuestionsFile & { resume?: { notes: string | null; attempt: number; extraVars: Record<string, string> } };
        this.db.prepare(`UPDATE questions SET answers = ?, answered_at = ? WHERE id = ?`).run(JSON.stringify(answers), now(), row.id);
        this.addMessage(taskId, "user", stored.questions.map((q) => `**${q.id}** ${q.text}\n→ ${answers[q.id]?.trim() || "(no answer — decide yourself)"}`).join("\n\n"));
        const answerNotes = renderAnswers(stored.questions, answers);
        const prior = stored.resume?.notes?.trim();
        this.setStage(taskId, row.stage);
        this.dispatch(taskId, row.stage, {
            notes: prior ? `${answerNotes}\n\n---\n\n${prior}` : answerNotes,
            attempt: stored.resume?.attempt ?? 1,
            ...(stored.resume?.extraVars && Object.keys(stored.resume.extraVars).length ? { extraVars: stored.resume.extraVars } : {}),
        });
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
        if (def.stage === "pr_creation_review") {
            const task = this.getTask(taskId);
            const repos = task ? this.prRepos(this.env(task.env_id)) : [""];
            const drafts = (parsed.data as PrDraft).drafts;
            const unknown = drafts.map((d) => d.repo).filter((r) => !repos.includes(r));
            if (unknown.length) return { ok: false, error: `pr.json names repositories that are not part of this workspace: ${unknown.map((r) => r || '""').join(", ")} — use ${repos.map((r) => `"${r}"`).join(", ")}` };
            const dupes = drafts.map((d) => d.repo).filter((r, i, a) => a.indexOf(r) !== i);
            if (dupes.length) return { ok: false, error: `pr.json has more than one draft for ${dupes.map((r) => r || '""').join(", ")} — one entry per repository` };
        }
        return { ok: true, data: parsed.data };
    }

    private designMdProblems(taskId: string): string | null {
        const p = join(this.taskDir(taskId), "design.md");
        if (!existsSync(p)) return "design.md was not written";
        const task = this.getTask(taskId);
        const repos = task ? envRepos(this.env(task.env_id)) : [];
        return designMdProblems(readFileSync(p, "utf8"), { repos });
    }

    private afterStage(taskId: string, def: StageDef, data: unknown): void {
        const task = this.getTask(taskId)!;
        if (def.stage === "implementation") this.addAgentNote(taskId, (data as ImplResult).notes);
        if (def.stage === "pr_fix") this.addAgentNote(taskId, `CI fix: ${(data as PrFixResult).summary}`);
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
                if (this.helperReruns.delete(taskId)) {
                    this.setTaskStatus(taskId, "blocked", `${def.label} · still not logged in at ${this.appUrlFor(task, env)} in ${where} — log in there (a tab that only looks logged in is not enough: reload it), then click Log in for QA`);
                    return;
                }
                this.setTaskStatus(taskId, "blocked", `${def.label} · log in at ${this.appUrlFor(task, env)} in ${where} — opening it for you`);
                // Start the login helper right away: it opens the app in the QA Chrome profile, waits for the human, and re-runs the stage.
                void this.qaLogin(taskId).catch((e: unknown) => console.warn(`[stagehand] auto login helper ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
                return;
            }
            this.helperReruns.delete(taskId);
            const blocked = qa.scenarios.filter((s) => s.outcome === "blocked");
            const failed = qa.scenarios.filter((s) => s.outcome === "fail").length;
            const needsHuman = qa.scenarios.filter((s) => s.outcome === "needs_human").length;
            // A baseline with even one blocked scenario is not a solid base to build on: that scenario has no real
            // "before" state to diff manual_qa against later. Unlike bridge-miss/auth (handled and retried above),
            // this covers everything else that can block a scenario (an environment problem, a data issue, ...) —
            // qa_baseline must not silently sail into implementation on a partial or empty result.
            if (def.stage === "qa_baseline" && blocked.length > 0) {
                const reason = qa.blockers[0] ?? blocked[0]!.observation;
                this.setTaskStatus(
                    taskId,
                    "blocked",
                    `QA baseline · ${blocked.length}/${qa.scenarios.length} scenario(s) blocked, not a solid baseline — ${reason} — fix it, then Retry`,
                );
                return;
            }
            if (def.stage === "manual_qa" && (failed > 0 || needsHuman > 0 || blocked.length > 0)) {
                const parts = [failed > 0 ? `${failed} scenario(s) failed` : null, needsHuman > 0 ? `${needsHuman} need your own check` : null, blocked.length > 0 ? `${blocked.length} blocked` : null].filter(Boolean);
                this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`Manual QA · ${parts.join(" · ")}`, now(), taskId);
                if (failed > 0) {
                    const taskDir = this.taskDir(taskId);
                    const priorAttempts = qaAttemptFiles(taskDir).length;
                    if (priorAttempts < MAX_AUTO_QA_RETURNS) {
                        const attemptNum = priorAttempts + 1;
                        const afterPath = join(taskDir, "qa", "after.json");
                        if (existsSync(afterPath)) copyFileSync(afterPath, join(taskDir, "qa", `after-attempt-${attemptNum}.json`));
                        const notes = renderQaFailureNotes(taskDir, qa, this.readArtifactJson<DesignResult>(taskId, "design.json"), attemptNum);
                        this.setStage(taskId, "implementation");
                        this.setTaskStatus(taskId, "running", `Manual QA · ${failed} scenario(s) failed — sending back to Implementation automatically (fix ${attemptNum}/${MAX_AUTO_QA_RETURNS})`);
                        this.dispatch(taskId, "implementation", { notes });
                        return;
                    }
                    this.db
                        .prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`)
                        .run(`Manual QA · ${failed} scenario(s) still failing after ${MAX_AUTO_QA_RETURNS} automatic fix attempts — needs your review`, now(), taskId);
                }
            }
        }
        if (def.next) this.advance(taskId, def.next);
    }
}
