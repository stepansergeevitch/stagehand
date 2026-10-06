import { BaseCheckout } from "./migrations.js";
import { callbackPortsOf, parseCookies, withPrepare } from "./env-config.js";
import { readLocalStorage } from "./chrome-storage.js";
import { assertDbHosts } from "./db-hosts.js";
import { copyNames, namesTemplate, ownedDbNames, TaskDbs, templatesOf, taskDbActive, taskDbEnv, taskDbExpect, taskDbOf, taskDbRow, type TaskDbRow } from "./task-db.js";
import { activeRound, addedFiles, AutopilotReview, autopilotRulesOf, describeRules, changedRanges, failureKey, fixBrief, MAX_AUTOPILOT_ROUNDS, readAutopilot, TriageResult, verifyFailure, writeAutopilot, type AutopilotRound, type AutopilotState, type VerifiedFailure, type VerifyCtx } from "./ci-autopilot.js";
import { EventEmitter } from "node:events";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PREVIEW, type Config } from "./config.js";
import { accountBrowserReady, accountModelsOf, accountOrderOf, accountUsableWith, baseBranchFor, chromeBrowserLabel, chromeBrowsersOf, componentsOf, extraTicketsOf, normalizeBaseBranch, now, parseEnvVars, STAGES, type AccountRow, type ChromeBrowser, type ConfigDirRow, type DB, type EnvComponent, type EnvRow, type MessageAnchor, type MessageKind, type MessageRow, type PrStateRow, type QuestionRow, type RunRow, type SharedFile, type Stage, type TaskLabel, type TaskRow, type TaskStatus } from "./db.js";
import { permissionProblem, rateLimitHit, ResultEvent, startClaude, type ActivityEvent, type ClaudeRun, type RateLimitInfo, type RunOutcome } from "./claude/runner.js";
import { renderHumanDirectives, type HumanDirective } from "./human-directives.js";
import { authEnv, browserDirFor, mirrorConfigDir, probeChrome } from "./claude/accounts.js";
import { activateChromeTab, chromeHasQaFlags, closeChromeTabs, listChromeTabs, openInProfile, QA_CHROME_FLAGS, setChromeTabUrl } from "./chrome-profiles.js";
import { activateCloneTab, cloneProfile, launchClone, pickCdpPort, quitClone, sweepClones, type ChromeClone } from "./chrome-clones.js";
import { backfillCalibration, backfillUsage, calibrateWindows, recordUsage, stampTaskOnUsage } from "./usage.js";
import { localTaskLink, notify, taskLink, type Notice } from "./notify.js";
import { baseDrift, baseOf, branchCommits, commitsDiff, createWorktree, describePaths, dirtyPaths, type RepoLayout, envRepos, loginShellArgs, loginShellEnv, removeWorktreeAndBranch, repoPaths, runWorktreeSetup, uncommittedGroup, worktreeDiff, type BranchCommit, type DiffFile, type DiffGroup } from "./git.js";
import { materializeRules, prTemplates, rulesOf } from "./rules.js";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { DEPENDENCY_KIND, type Services } from "./services.js";
import { CallbackRelay } from "./callback-relay.js";
import type { ServiceKind } from "./db.js";
import { extraTicketFile, fetchTicket, fetchTicketRest, parseTicketRef, renderSharedFiles, renderTicketsForPrompt, Ticket, type TicketRef } from "./tickets.js";
import { describeReviewChecklist } from "./review-checklist.js";
import { killSession, taskSessionName } from "./tmux.js";
import { findTranscript } from "./transcripts.js";
import { STAGE_DEFS, renderPrompt, type StageDef } from "./stages/registry.js";
import { applyQaFixes, applyFixToScenario, guardQaFix, parseStepFixAnswer, proposedOption, revertQaChange, type FixKind, type FixRequest, type QaChange } from "./qa-fixes.js";
import { autoFixKinds, decideQaFix, DEFAULT_QA_AUTO_FIX, jevQaFixVerdict } from "./qa-autofix.js";
import { fillQaVars, newQaPassId, qaContractProblems, type QaVars } from "./qa-vars.js";
import { mergeQuestions, mergeScenarios, planQaShards, shardFiles, type QaShard } from "./qa-shards.js";
import { flagSubstitutions, isNetworkError } from "./qa-grade.js";
import { jevAsk, jevEnabled } from "./jev.js";
import { djangoBatchCommand, djangoBatchEnv, parseBatchOutput, planSeedUnits, type SeedItem } from "./seed-batch.js";
import { DesignResult, ImplResult, PrDraft, PrFixResult, QaPassResult, QuestionsFile, ResearchResult, ReviewResult, type AgentQuestion, QaScenario } from "./stages/contracts.js";

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
// One PR comment as a prompt line: where it sits, who wrote it, what it says.
export const describePrComment = (c: PrComment): string =>
    c.kind === "line"
        ? `- \`${c.path}:${c.line ?? "?"}\`${c.outdated ? " (outdated diff position)" : ""} — ${c.author}: ${c.body.trim()}`
        : c.kind === "review"
          ? `- Review by ${c.author}${c.state !== "COMMENTED" ? ` (${c.state.toLowerCase().replace("_", " ")})` : ""}: ${c.body.trim() || "(no body text)"}`
          : `- ${c.author}: ${c.body.trim()}`;
// The GitHub replies under a line comment, indented under it in a fix brief.
const renderReplies = (c: PrComment, all: PrComment[]): string => {
    const replies = all.filter((r): r is Extract<PrComment, { kind: "line" }> => r.kind === "line" && r.replyTo === c.id).sort((a, b) => a.at.localeCompare(b.at));
    return replies.length ? `\n  Replies on GitHub:\n${replies.map((r) => `    - ${r.author}: ${r.body.trim().replace(/\n/g, "\n      ")}`).join("\n")}` : "";
};
// What the human and the agent said about a comment in Stagehand (the Ask chat under it), indented under it in a fix
// brief: the human's questions there are instructions, the agent's answers are its own earlier reading of the point.
const renderAskThread = (thread: MessageRow[]): string => {
    if (!thread.length) return "";
    const line = (m: MessageRow): string => `    - ${m.role === "user" ? "Human" : "Agent"}: ${m.text.trim().slice(0, 1500).replace(/\n/g, "\n      ")}`;
    return `\n  Discussed in Stagehand under this comment (oldest first):\n${thread.map(line).join("\n")}`;
};
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
    // "changes" only: skip the browser QA stages on the way back to User Review this once (the human QA'd by hand).
    skipQa?: boolean | undefined;
    // Files the human attached to the verdict (a screenshot of what is wrong): listed by path in the reviewer notes.
    files?: SharedFile[] | undefined;
}

// Every archived attempt file matching qa/<prefix>-N.json so far (oldest first): { N, path }. The CURRENT qa/<pass>.json
// is not included — archive it first (see afterStage) if it should count as one of these. Used both for Manual QA's
// "failed → auto-return to Implementation" trail (prefix "after-attempt") and for the "blocked → auto-unblock-and-retry"
// trail (prefix "<pass>-blocked-attempt"), which are independent budgets even within the same run.
const attemptFiles = (taskDir: string, prefix: string): Array<{ n: number; path: string }> => {
    const dir = join(taskDir, "qa");
    if (!existsSync(dir)) return [];
    const re = new RegExp(`^${prefix}-(\\d+)\\.json$`);
    return readdirSync(dir)
        .map((f) => re.exec(f))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ n: Number(m[1]), path: join(dir, m[0]) }))
        .sort((a, b) => a.n - b.n);
};
const qaAttemptFiles = (taskDir: string): Array<{ n: number; path: string }> => attemptFiles(taskDir, "after-attempt");

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

// What the SAME QA runner sees on a "blocked → try to unblock, then retry this same pass" cycle: unlike a fail
// (a real assert that did not hold, sent to Implementation), a block means the scenario never got far enough to
// assert anything — a stale dev-server, a real app bug unrelated to this ticket, a data gap — so the runner itself,
// already sitting in the worktree with Bash and the browser open, gets one narrow exception to stay read-only and
// go fix the cause, rather than handing it to a separate Implementation run that would start from a cold state.
const renderUnblockHint = (qa: QaPassResult, blocked: QaPassResult["scenarios"], attemptNum: number, commitRule: string, taskDir: string): string => {
    const parts = [`## Automatic unblock retry ${attemptNum} of ${MAX_UNBLOCK_ATTEMPTS} — the previous attempt could not run these scenarios`];
    parts.push(blocked.map((b) => `- \`${b.id}\` — ${b.observation}`).join("\n"));
    if (qa.blockers.length) parts.push(`Blockers: ${qa.blockers.join("; ")}`);
    parts.push(
        `Before repeating the scenarios, investigate why: check the dev-server logs, the page's console and network requests, and the DOM. If it is a real, fixable bug in the app's current code in this worktree — not something this ticket's own design is about, just something in the way — fix it with a normal code edit; that is the one exception to staying hands-off with the app in this run. ${commitRule}`,
    );
    parts.push(
        `**If the cause is the seed step itself** — its SQL names a column, table or value that does not exist, a typo, a wrong path — do not run a rewritten version on your own and do not just record it blocked again: work out the exact corrected command (check the schema and the models), then hand it to the human with the questions mechanism below — one question per broken step, quoting the scenario id, the error, and the corrected command in full as an option (e.g. options: ["apply the corrected command above", "keep the seed as written"]). Reply NEED_INPUT. When the answer comes back and approves a correction (or gives a different one), edit that seed step's text in \`${taskDir}/design.json\` to the approved command — that file is the spec both passes seed from — then run it and continue the scenarios. If the human says the seed is right, follow their explanation of how to unblock instead. If you cannot find a cause within reasonable effort, record the scenarios \`blocked\` again with what you tried and observed, and stop.`,
    );
    return parts.join("\n\n");
};

// What the agent sees on a review round: the general notes, then every line comment with its anchor and the quoted
// line, then where THIS stage records how each point was resolved — the closing line names the stage's own output
// file, because a design revision told to "list it in impl.json notes" wrote an impl.json (with an array of notes)
// that the task page then rendered as an Implementation result (INV-131, 2026-09-17).
// Stages at which Code-changes line comments go to a PR-fix round instead of User Review's "Request changes".
const LOCAL_COMMENT_FIX_STAGES: ReadonlySet<Stage> = new Set(["pr_waiting", "pr_fix", "pr_green", "pr_approved"]);

const renderReviewNotes = (round: number, notes: string | undefined, comments: LineComment[], stage: Stage): string => {
    const parts: string[] = [`## Reviewer notes — review round ${round} (address every point)`];
    if (notes?.trim()) parts.push(notes.trim());
    if (comments.length) {
        parts.push("### Line comments (path:line refer to the current diff against the base branch; the quoted text is the line as it is now)");
        for (const c of comments) parts.push(`- \`${c.path}:${c.line}\` (${c.side === "old" ? "removed line" : "line"}) — \`${c.snippet.trim().slice(0, 160)}\`\n  → ${c.text.trim()}`);
    }
    const closing: Partial<Record<Stage, string>> = {
        implementation: "When done, list in impl.json `notes` (one markdown string, not an array) each reviewer point and how you resolved it (or why not).",
        design_proposal: "Address every point inside design.md and design.json themselves — they are this stage's only output; do not write impl.json or any other file. Where a point changed a decision, the Decision, Evidence and Contract sections must reflect it.",
        pr_fix: "When done, cover each reviewer point in pr-fix.json `summary`.",
        pr_creation_review: "Revise pr.json accordingly; write nothing else.",
    };
    parts.push(closing[stage] ?? "When done, say in this stage's output how each reviewer point was resolved (or why not).");
    return parts.join("\n\n");
};

// The block every stage prompt carries: how to hand a decision to the human without guessing or stopping silently.
const askHumanBlock = (taskDir: string, file = "questions.json"): string =>
    [
        "## Asking the human (any stage)",
        "",
        "When only the human can decide something — an ambiguous requirement, two valid approaches with different scope or cost, a conflict between the ticket and the code, credentials or data you genuinely cannot create — do not guess and do not stop silently. Write `" + `${taskDir}/${file}` + "`:",
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
    // The run was already repeated once after the CLI could not reach its API (isNetworkError).
    netRetried?: boolean;
    // Run on this model whatever the settings say: the automatic retry after a refused permission pins a real model.
    model?: string;
    // The run was already dispatched once more with a pinned model after a refused permission.
    modelRetried?: boolean;
    // The round the agent is told about ("fix round N" for a PR Fix); also the run row's attempt column.
    attempt?: number;
    // Contract retries within one round: how many times this run has been dispatched because its output file was
    // missing or invalid (1 = the first run). Kept apart from `attempt`: a PR Fix round starts at attempt = its round
    // number, and until 2026-09-23 that number also counted as contract attempts, so a task in fix round 5 or later
    // failed for good on its first missing file (INV-133 round 5, INV-63 round 9).
    contractAttempt?: number;
    // The run was already resumed once because it ended its turn with background commands still running.
    backgroundResumed?: boolean;
    extraVars?: Record<string, string>;
    servicesReady?: boolean;
    // QA baseline: the worktree is on base code for this pass (or needed no switch).
    onBase?: boolean;
    // Browser stages: the orchestrator has already executed the scenarios' `shell:` seed steps for this dispatch.
    seedsDone?: boolean;
    // Browser stages: a live probe just confirmed the Chrome extension answers for this dispatch — skip re-probing.
    chromeVerified?: boolean;
    // Browser stages: the running Chrome was confirmed to carry QA_CHROME_FLAGS for this dispatch.
    chromeFlagsVerified?: boolean;
    // Browser stages on an account that clones its QA profile per run: the clone for this task is up and its extension connected.
    cloneReady?: boolean;
    // Browser stages: cloning failed for this dispatch — run in the shared profile instead.
    cloneFailed?: boolean;
    // PR Fix: what started the round — failing checks or picked comments — for config.operationModels.
    operation?: "pr_fix_ci" | "pr_fix_comments";
    // The env's QA session command already ran for this dispatch (refreshQaSession).
    sessionReady?: boolean;
    // The env's DB host check passed for this dispatch (db-hosts.ts).
    dbHostsChecked?: boolean;
    // QA stages: this dispatch is one shard of a pass split into parallel runs (qa-shards.ts).
    shard?: QaShard | PrShard;
    // Browser stages on a gstack env: this run's headless daemon is up and its session cookies are in.
    gstackReady?: boolean;
    // A run that hit its turn cap without output is resumed in the same session this many times so far (cap = checkpoint).
    continuations?: number;
}

// One repository's slice of a PR Fix round that runs in parallel with the other repositories' slices: a fresh session
// (the task session cannot be resumed twice at once), its own jobs text, output file and questions file.
interface PrShard {
    kind: "pr";
    group: string;
    // The repository directory ("" = the single-repo root); doubles as the shard id.
    id: string;
    repo: string;
    failureOutput: string;
    sessionId: string;
    browser: false;
    phase: "parallel";
    scenarios: string[];
}
const isPrShard = (s: QaShard | PrShard | undefined): s is PrShard => !!s && "kind" in s && s.kind === "pr";
type PrShardResult =
    | { kind: "ok"; summary: string; comments: PrFixResult["comments"] }
    | { kind: "asked"; questions: QuestionsFile }
    | { kind: "failed"; error: string }
    | { kind: "rate_limited"; resetsAt: number | null }
    | { kind: "stopped" };
interface PrGroup {
    // Shards already repeated once after a network failure of the run itself.
    netRetried?: Set<string>;
    id: string;
    taskId: string;
    attempt: number;
    contractAttempt: number;
    operation: DispatchOpts["operation"];
    notes: string | undefined;
    pending: PrShard[];
    starting: Set<string>;
    running: Map<string, PrShard>;
    results: Map<string, PrShardResult>;
}
// <taskDir>/pr_fix_round.json — the jobs of the current PR Fix round per repository, so Retry and a restart replay it.
// The PR comments a fix round addresses (pr_fix_comments.json) and the "Addressed in <commit>" replies the human picked.
interface FixComments {
    at: string;
    repos: Record<string, { number: number; prUrl: string; headBefore: string; comments: Array<{ id: number; kind: PrComment["kind"]; author: string; url: string; body: string; path?: string; line?: number | null; root?: number }> }>;
    replies: Array<{ repo: string; commentId: number; sha: string; posted?: string | null; error?: string | null }>;
    // What the fix run reported per comment (pr_fix.json `comments`), checked against the round's own commits: the
    // addressed ones get their reply pre-filled with that commit; the others are shown with the reason, no reply.
    outcomes?: Array<{ repo: string; commentId: number; addressed: boolean; sha: string | null; note: string }>;
}

interface PrRoundSpec {
    jobs: Record<string, string>;
    attempt: number;
    contractAttempt?: number;
    operation: DispatchOpts["operation"];
}
// A headless `claude -p` run gets no "background command finished" notification: when the agent ends its turn to wait
// for one, the process exits and the CLI kills the command (reported as task_notification status "stopped" after the
// result). Seen on INV-63 and INV-133 (2026-09-23): every PR Fix run that "failed the output contract" had started
// pytest in the background and replied "I'll wait for the completion notification".
const backgroundNote = (n: number): string =>
    `The run ended its turn while ${n} command(s) it started in the background were still running; they were killed when the process exited — in a headless run no completion notification ever arrives. Run long commands in the foreground (with a long timeout) or block on their output, and do not end the turn before they finish. `;
// A run that ends at its turn cap without output is resumed in the same session up to this many times.
const MAX_CONTINUATIONS = 2;
const continueNote = (n: number, outputFile: string | undefined, prior: string | undefined): string =>
    `## Turn budget reached — continuation ${n} of ${MAX_CONTINUATIONS}\n\nYour previous run hit its turn cap before writing ${outputFile ?? "its output file"}. Continue from the current state of the worktree: do not redo finished work, commit what is done, and write the output file well before the cap this time.` +
    (prior?.trim() ? `\n\n---\n\n${prior}` : "");

// One QA pass running as several shards: what is still to start, what runs, what each finished shard reported.
type ShardResult =
    | { kind: "ok"; scenarios: QaPassResult["scenarios"]; blockers: string[] }
    | { kind: "asked"; questions: QuestionsFile; recorded: QaPassResult["scenarios"] }
    | { kind: "failed"; error: string }
    | { kind: "rate_limited"; resetsAt: number | null }
    | { kind: "stopped" };
interface QaGroup {
    // Shards already repeated once after a network failure of the run itself.
    netRetried?: Set<string>;
    id: string;
    taskId: string;
    stage: Stage;
    // The pass dispatch's options (seeds done, pass id, seed report, notes, attempt), the base of every shard's dispatch.
    opts: DispatchOpts;
    allIds: string[];
    pending: QaShard[];
    // Shard ids whose dispatch is between "started" and "run row inserted" (an async gate: clone copy, Chrome probe).
    starting: Set<string>;
    running: Map<string, QaShard>;
    results: Map<string, ShardResult>;
}

// A scenario result the next attempt keeps instead of driving the scenario again: a verdict, or a hand-off to the human.
const isRecorded = (s: { outcome: string }): boolean => s.outcome === "pass" || s.outcome === "fail" || s.outcome === "needs_human";

// Runs that are not pipeline stages, each with its own model setting (config.operationModels).
type OperationKind = "pr_fix_ci" | "pr_fix_comments" | "chat" | "instruct" | "rebase" | "fix_service" | "git_edit";

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

// execFile's error message is "Command failed: <the whole command>\n<stderr>": the useful part — a pre-push hook's verdict,
// GitHub's rejection reason — is at the END, which a plain slice(0, 160) never reaches. Keep the last few stderr lines.
const gitErrorTail = (e: unknown): string => {
    const lines = String((e as Error).message ?? e)
        .split("\n")
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
        .filter((l) => l && !/^Command failed:/.test(l) && !/^npm warn/i.test(l));
    return (lines.slice(-4).join(" · ") || "no output").slice(0, 400);
};

// Naming a repository in status lines and errors: the sub-repo directory, or "the repository" for a single-repo env.
const repoLabel = (repo: string): string => repo || "the repository";

// A psql seed command with every `-c "<sql>"` / `-c '<sql>'` payload wrapped in BEGIN … ROLLBACK, so running it parses
// and plans the statements against the live schema without changing anything. Unchanged when there is no -c payload.
export const wrapPsqlInRollback = (cmd: string): string =>
    cmd.replace(/(-c\s+)("((?:[^"\\]|\\.)*)"|'([^']*)')/g, (_m, flag: string, _q: string, dq: string | undefined, sq: string | undefined) => {
        const sql = dq ?? sq ?? "";
        if (/^\s*(begin|\\)/i.test(sql)) return `${flag}${_q}`;
        const body = sql.replace(/;\s*$/, "");
        return dq !== undefined ? `${flag}"BEGIN; ${body}; ROLLBACK;"` : `${flag}'BEGIN; ${body}; ROLLBACK;'`;
    });

// Two chat anchors point at the same diff line thread: same file, same side, same text (line numbers drift as the
// branch evolves, the quoted line is what identifies it).
// A PR-comment thread is keyed by the comment itself; a diff-line thread by where the line sits and what it says.
const sameAnchor = (a: MessageAnchor, b: MessageAnchor): boolean =>
    a.prComment || b.prComment
        ? !!a.prComment && !!b.prComment && a.prComment.repo === b.prComment.repo && a.prComment.id === b.prComment.id
        : a.path === b.path && a.side === b.side && a.snippet.trim() === b.snippet.trim();
// "backend: " in front of a per-repo status fragment, only when the task spans several repositories.
const repoPrefix = (repo: string, repos: string[]): string => (repos.length > 1 && repo ? `${repo}: ` : "");
const repoScopeNote = (repo: string): string => (repo ? `Repository: \`${repo}/\` inside the worktree — every git and gh command below runs inside that directory.\n` : "");

const FIVE_HOUR = "five_hour";
// Task states in which nothing happens until a human acts (or, for rate limits, until the window resets).
const NEEDS_HUMAN: ReadonlySet<TaskStatus> = new Set(["waiting_user", "blocked", "failed", "rate_limited"]);

// Required `## ` sections of design.md, in order (numbering optional); mirrored in prompts/design.md. Root cause is
// required for a bug and refused for a feature.
export const DESIGN_SECTIONS = ["Classification", "Problem statement", "Root cause", "Suggested approach", "Technical changes"] as const;
// Word caps count prose only: code blocks and table rows are excluded everywhere.
export const DESIGN_MAX_WORDS = 700;
const PROBLEM_MAX_WORDS = 80;
const ROOT_CAUSE_WORDS = [40, 160] as const;
const APPROACH_WORDS = [60, 250] as const;
const SUMMARY_MAX_WORDS = 50;
// ASD-STE100: 20 words for an instruction, 25 for a description — the longer limit is the hard one.
const SENTENCE_MAX_WORDS = 25;
// Sections for a product reader: behaviour and the part of the system, never paths, line numbers or identifiers.
const PROSE_SECTIONS = ["Problem statement", "Root cause", "Suggested approach"] as const;
// Filler and hedging the STE rules in prompts/design.md ban; "should/might/could" state no requirement.
const DESIGN_FILLER = /\b(it is worth noting|importantly|note that|in order to|basically|essentially|robust|seamless(ly)?|leverag(e|es|ing)|comprehensive|ensure that|should|might|could)\b/i;
// A backticked span counts as code when it looks like one (path, identifier, call, constant); a plain word such as `archived` is a product term.
const CODE_REF = /`[^`\n]*(?:[./_(:\\]|[a-z][A-Z])[^`\n]*`|`[^`\n]{30,}`|\b[\w./-]+\.(py|ts|tsx|js|jsx|rs|go|java|kt|rb|sql|scss|css|json|ya?ml)\b|\b[\w./-]+:\d+\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z]\w+\(|\b[A-Z]+_[A-Z_]+\b/;
const LOGIN_POLL_MS = 3_000;
// A Manual QA run that still has failing scenarios goes straight back to Implementation with the failure detail as
// reviewer notes, instead of waiting for the human to notice at User Review. Capped so a genuinely stuck fix doesn't
// loop forever — after this many automatic returns, it needs the human's review regardless (a needs_human-only run,
// with nothing failed or blocked, still falls through to User Review as normal — that one is a real human judgment
// call, not something an automatic retry could ever resolve).
const MAX_AUTO_QA_RETURNS = 2;
// A blocked scenario (qa_baseline or manual_qa, after ruling out the self-resolving bridge-miss/auth cases above)
// gets the SAME QA runner one retry cycle to investigate and fix the cause itself before a human is pulled in —
// see renderUnblockHint. Capped independently of MAX_AUTO_QA_RETURNS since it is a different kind of retry (same
// stage re-running itself, not a return to Implementation).
const MAX_UNBLOCK_ATTEMPTS = 2;
// The QA baseline runs inside the design stage (the user's ask, 2026-09-30): the design agent writes its scenarios, the
// baseline runs them on the unchanged app, the agent corrects the wrong ones, and the proposal reaches the reviewer only
// with a baseline behind it. design-baseline.json tracks the loop: `running` while a pass drives the scenarios,
// `reviewing` while the agent reads the result, `done` once the scenarios stop changing (or the rounds run out).
// `hashes`: each scenario's content hash as of the baseline result on record — a scenario whose hash is unchanged keeps
// that result (a review round that edits only the proposal reruns nothing; one edited scenario reruns alone).
interface DesignBaseline {
    status: "running" | "reviewing" | "done";
    round: number;
    qaHash: string;
    hashes?: Record<string, string>;
}
const MAX_DESIGN_BASELINE_ROUNDS = 3;
// Key order and whitespace are not content: the agent rewriting design.json must not look like a changed scenario.
const stableJson = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map(stableJson).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);
const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");
// Defaults are not content either: a scenario is hashed as the contract reads it, so a rewrite that drops
// `"exclusive": false` or `"shot": false` keeps its baseline (INV-149, 2026-10-02: such a rewrite reran all four).
const normalScenario = (s: unknown): unknown => {
    const parsed = QaScenario.safeParse(s);
    return parsed.success ? parsed.data : s;
};
export const scenarioHashes = (design: DesignResult | null): Record<string, string> => Object.fromEntries((design?.qa ?? []).map((s) => [s.id, sha1(stableJson(normalScenario(s)))]));
// Hashes recorded before normalisation took the scenario as written.
const rawScenarioHashes = (design: DesignResult | null): Record<string, string> => Object.fromEntries((design?.qa ?? []).map((s) => [s.id, sha1(stableJson(s))]));
const qaHashOf = (design: DesignResult | null): string => sha1(stableJson(scenarioHashes(design)));
// What the design agent reads after a baseline pass: every scenario's outcome and observation, and why the pass stopped.
const renderDesignBaselineNotes = (qa: QaPassResult, round: number, stopped: string | null): string => {
    const line = (s: QaPassResult["scenarios"][number]): string => {
        const log = s.log?.trim() ? `\n  Output: ${s.log.trim().slice(-600).replace(/\n/g, "\n  ")}` : "";
        return `- **${s.id}** — **${s.outcome}** — ${s.observation.slice(0, 800)}${log}`;
    };
    return (
        `## QA baseline result — round ${round} of ${MAX_DESIGN_BASELINE_ROUNDS}\n\n` +
        "The baseline ran your design.json scenarios on the unchanged app. Follow \"When you get the baseline result\" in this prompt.\n\n" +
        (stopped ? `**The pass stopped:** ${stopped}\n\n` : "") +
        (qa.blockers.length ? `**Blockers:**\n${qa.blockers.map((b) => `- ${b}`).join("\n")}\n\n` : "") +
        `${qa.scenarios.map(line).join("\n")}\n\n` +
        "Leave design.json `qa` unchanged when every scenario is correct: that sends the proposal to the reviewer."
    );
};
// Jev's sorting of a blocked QA scenario (classifyQaBlockers): what a retry can and cannot fix.
type BlockerKind = "bridge_or_auth" | "seed_or_design_defect" | "environment" | "app_bug" | "other";
// qa/baseline-rerun.json: scenarios whose baseline a change made stale; `active` while the re-run pass drives them on the
// base commit (heads = the branch tips to return to, per repository).
interface BaselineRerun {
    ids: string[];
    active: boolean;
    heads: Record<string, string>;
    next: Stage;
    startedAt?: string;
}
// A stage whose output file fails its contract is re-run with the validation error as notes; outside the fresh-session
// QA stages each retry resumes the same session, so it is cheap. After this many attempts the task fails for the human.
const MAX_CONTRACT_ATTEMPTS = 5;
// The model a run is repeated on after the CLI refused its edits and no global default is set (see permissionProblem).
const REFUSAL_RETRY_MODEL = "sonnet";
const LOGIN_WAIT_MS = 15 * 60_000;
type ChromeTabLike = { url: string; title: string };
const tabKey = (t: { window: number; tab: number; url: string }): string => `${t.window}:${t.tab}:${t.url}`;

// The proposal is for a human: a fixed set of sections, hard word caps and the STE sentence rules keep it dense.
// Violations go back to the agent through the normal contract-retry path.
// `repos`: the workspace's sub-repository directories (multi-repo env) — Classification must then name the affected ones.
export const designMdProblems = (md: string, opts: { repos?: string[] } = {}): string | null => {
    const problems: string[] = [];
    const headings = [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/^\d+[.)]\s*/, "").toLowerCase());
    const has = (title: string): boolean => headings.some((h) => h.startsWith(title.toLowerCase()));
    const section = (name: string): string | null => {
        const m = new RegExp(`^##\\s+(?:\\d+[.)]\\s*)?${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "im").exec(md);
        return m ? m[1]! : null;
    };
    const subsection = (body: string, name: string): string | null => {
        const m = new RegExp(`^###\\s+${name}[^\\n]*\\n([\\s\\S]*?)(?=^###\\s|(?![\\s\\S]))`, "im").exec(body);
        return m ? m[1]! : null;
    };
    // Prose only: code blocks and table rows are structure, not review-time reading.
    const prose = (s: string): string => s.replace(/```[\s\S]*?```/g, " ").split("\n").filter((l) => !/^\s*\|/.test(l) && !/^\s*#/.test(l)).join("\n");
    const wordCount = (s: string): number => prose(s).split(/\s+/).filter(Boolean).length;
    const bullets = (body: string): string[] => body.split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l));
    const hasTable = (body: string): boolean => /^\s*\|.*\|\s*\n\s*\|\s*:?-+/m.test(body);

    const classification = section("Classification");
    const isBug = !!classification && /^\s*`?\**bug\**`?\b/im.test(classification);
    const isFeature = !!classification && /^\s*`?\**feature\**`?\b/im.test(classification);
    for (const want of DESIGN_SECTIONS) {
        if (want === "Root cause" && !isBug) continue;
        if (!has(want)) problems.push(`design.md is missing the section "## ${want}"`);
    }
    if (classification !== null && !isBug && !isFeature) problems.push("the Classification section starts with `bug` or `feature`, a dash, then the reason");
    if (isFeature && has("Root cause")) problems.push("a feature has no Root cause section — the Suggested approach explains the change");
    const extra = headings.filter((h) => !DESIGN_SECTIONS.some((s) => h.startsWith(s.toLowerCase())));
    if (extra.length) problems.push(`design.md has section(s) the template does not have: ${extra.map((h) => `"## ${h}"`).join(", ")} — use only ${DESIGN_SECTIONS.join(", ")}`);

    const words = wordCount(md);
    if (words > DESIGN_MAX_WORDS) problems.push(`design.md is ${words} words of prose; the cap is ${DESIGN_MAX_WORDS} — cut repetition and prose around tables`);
    if (/^\s*```json/m.test(md)) problems.push("design.md contains a JSON block — design.json carries the structure");

    const cap = (name: string, min: number, max: number): void => {
        const body = section(name);
        if (body === null) return;
        const n = wordCount(body);
        if (n < min) problems.push(`the ${name} section is ${n} words — it needs at least ${min}`);
        else if (n > max) problems.push(`the ${name} section is ${n} words; keep it under ${max}`);
    };
    cap("Problem statement", 1, PROBLEM_MAX_WORDS);
    if (isBug) cap("Root cause", ROOT_CAUSE_WORDS[0], ROOT_CAUSE_WORDS[1]);
    cap("Suggested approach", APPROACH_WORDS[0], APPROACH_WORDS[1]);

    for (const name of PROSE_SECTIONS) {
        const body = section(name);
        if (body === null) continue;
        const hit = CODE_REF.exec(body);
        if (hit) problems.push(`the ${name} section contains code or a file reference (${hit[0].slice(0, 40)}) — write it in product words; paths, line numbers and identifiers belong in Technical changes`);
        const plain = bullets(body).filter((l) => !/^\s*[-*]\s+\*\*[^*\n]+\*\*/.test(l));
        if (plain.length) problems.push(`${plain.length} bullet(s) in ${name} have no bold lead-in — open every bullet with **the part of the system or the case** — then the fact`);
    }
    const approach = section("Suggested approach");
    if (approach !== null && !/^\s*(?:[-*]\s*)?\*\*Invariant:?\*\*/im.test(approach)) problems.push("the Suggested approach section closes with an `**Invariant:**` line — what must stay true after the change");

    const technical = section("Technical changes");
    if (technical !== null) {
        const summary = /^\s*(?:[-*]\s*)?\**Summary:?\**\s*(\S.*)$/im.exec(technical);
        if (!summary) problems.push("the Technical changes section opens with a `**Summary:**` line — the whole change in 1–3 imperative clauses, with the symbols");
        else if (summary[1]!.split(/\s+/).length > SUMMARY_MAX_WORDS) problems.push(`the Technical changes Summary line is over ${SUMMARY_MAX_WORDS} words`);
        if (!hasTable(technical) || !/^\s*\|\s*Layer\s*\|/im.test(technical)) problems.push("the Technical changes section needs the | Layer | File | Symbol | Before | After | table");
        const tests = subsection(technical, "Tests");
        if (tests === null) problems.push("the Technical changes section needs a `### Tests` sub-section: the | File | Test | Asserts | table and a `**Run:**` bash block");
        else if (!/^\s*\**Run:?\**\s*\n+\s*```/im.test(tests)) problems.push("the Tests sub-section ends with `**Run:**` followed by a fenced ```bash block with the exact commands");
    }

    // STE sentence rules: prose outside code, tables, headings and inline code.
    const sentences = prose(md)
        .replace(/`[^`\n]*`/g, "x")
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.replace(/^\s*[-*]\s+/, "").replace(/\*\*[^*\n]+\*\*\s*[—–-]\s*/, "").trim())
        .filter(Boolean);
    const long = sentences.filter((s) => s.split(/\s+/).length > SENTENCE_MAX_WORDS);
    if (long.length) problems.push(`${long.length} sentence(s) are over ${SENTENCE_MAX_WORDS} words (STE) — split them: ${long.slice(0, 3).map((s) => `"${s.slice(0, 60)}…"`).join(", ")}`);
    const filler = DESIGN_FILLER.exec(prose(md).replace(/`[^`\n]*`/g, "x"));
    if (filler) problems.push(`design.md uses "${filler[0]}" — STE bans filler and hedging; use "must" for a requirement, "can" for a possibility, and state the fact`);
    if (/mempalace|research\.md|as research (found|showed)|per the ticket'?s? (own )?note/i.test(md)) problems.push("design.md refers to where facts came from (research.md, mempalace, ticket notes) — state the facts only");

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
    return problems.length ? problems.join("; ") : null;
};

// One paragraph for prompts: where the code lives and how the worktree is laid out.
const describeRepoLayout = (env: RepoLayout, worktree: string | null): string => {
    const subs = envRepos(env);
    if (subs.length === 0) return `The project is a single git repository at ${env.path} (base branch \`${baseOf(env, "")}\`).`;
    const bases = subs.map((d) => baseOf(env, d));
    const same = new Set(bases).size === 1;
    const list = subs.map((d, i) => `\`${d}/\`${same ? "" : ` (base branch \`${bases[i]}\`)`}`).join(", ");
    const wt = worktree ? ` The task worktree ${worktree} mirrors this layout: each of ${subs.map((d) => `\`${d}/\``).join(", ")} inside it is a separate checkout of the task branch.` : "";
    return `The project is a workspace at ${env.path} made of separate git repositories in ${list}${same ? ` (base branch \`${bases[0]}\` in each)` : " (each repository has its own base branch, named above)"}; the workspace root itself is NOT a git repository — run git commands inside the repository directory you are changing.${wt}`;
};

export class Engine extends EventEmitter {
    private readonly active = new Map<string, ClaudeRun>();
    // The QA baseline runs on base code: the worktree switched to the base for the pass (migrations.ts).
    private readonly baseCheckout: BaseCheckout;
    // Each task's own database, copied from the env's template (task-db.ts).
    readonly taskDbs: TaskDbs;
    // Ad-hoc instruction runs (Chat → Do), keyed by task: no `runs` row, so Stop finds them here.
    private readonly instructing = new Map<string, ClaudeRun>();
    private timer: NodeJS.Timeout | null = null;

    constructor(
        private readonly db: DB,
        private readonly cfg: Config,
        private readonly services: Services,
    ) {
        super();
        this.baseCheckout = new BaseCheckout(cfg.dataDir);
        this.taskDbs = new TaskDbs(db, cfg.dataDir);
    }

    // ---------- lifecycle ----------

    startScheduler(): void {
        this.timer = setInterval(() => {
            this.tick();
            void this.reapClones();
        }, 15_000);
        this.startCallbackHopWatcher();
        this.startCallbackRelay();
        // No run survives a restart, so no cloned Chrome profile should either.
        void sweepClones(new Set()).then((n) => n && console.log(`[stagehand] ${n} leftover cloned Chrome profile(s) removed`));
        void this.sweepGstackBrowsers();
        // A worktree a restart caught on the base goes back to its branch before any run resumes.
        this.recoverAutopilot();
        void this.restoreBaseCheckouts().then(() => this.recoverInterrupted());
        const n = backfillUsage(this.db, this.cfg.dataDir);
        if (n) console.log(`[stagehand] usage backfilled for ${n} run(s)`);
        const c = backfillCalibration(this.db, this.cfg.dataDir);
        if (c) console.log(`[stagehand] rate-limit windows calibrated from ${c} run(s)`);
    }

    stopScheduler(): void {
        if (this.timer) clearInterval(this.timer);
        for (const run of this.active.values()) run.kill();
    }

    private async recoverInterrupted(): Promise<void> {
        const stale = this.db.prepare(`SELECT * FROM runs WHERE status = 'running'`).all() as RunRow[];
        for (const run of stale) {
            // The claude child may have finished its work before the restart; if the stage's output already validates, complete it from disk.
            // A shard of a parallel QA pass never completes on its own: the shards that finished are in qa/<pass>.partial.json
            // and Retry drives the rest.
            if (!run.group_id && (await this.completeFromDisk(run.task_id, run.id, run.stage))) continue;
            this.db.prepare(`UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run("server restarted mid-run", now(), run.id);
            this.setTaskStatus(run.task_id, "failed", "run interrupted by server restart — retry to resume");
        }
        // A task can be "running" with no run row for more than just the ticket-fetch phase: bringing up BE/FE,
        // running shell seeds, or anything else between stages does the same before the run insert happens deep in
        // dispatch(). Name the actual stage rather than assuming ticket fetch.
        const fetching = this.db.prepare(`SELECT * FROM tasks WHERE status = 'running'`).all() as TaskRow[];
        for (const t of fetching) {
            const active = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status = 'running'`).get(t.id) as { n: number };
            if (active.n === 0) {
                const label = t.stage === "research" && !existsSync(join(this.taskDir(t.id), "ticket.json")) ? "fetching the ticket" : `${STAGE_DEFS[t.stage]?.label ?? t.stage} · getting ready to run`;
                this.setTaskStatus(t.id, "failed", `${label} — interrupted by a server restart, retry to resume`);
            }
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
                await this.ensurePoBrief(taskId);
                this.dispatch(taskId, "research");
            })
            .catch((e: unknown) => {
                const reason = String((e as Error).message ?? e).slice(0, 200);
                this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`ticket fetch failed (${reason}) — research will try the MCP itself`, now(), taskId);
                this.dispatch(taskId, "research");
            });
    }

    // The Product Owner's brief on a ticket (product-owners.ts briefTask), written before research starts when the task
    // has a PO: what to pay attention to beyond the ticket. At most a few minutes; research starts without it on failure.
    private poBriefer: ((task: TaskRow, taskDir: string) => Promise<void>) | null = null;
    setPoBriefer(fn: (task: TaskRow, taskDir: string) => Promise<void>): void {
        this.poBriefer = fn;
    }
    private async ensurePoBrief(taskId: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task?.product_owner_id || !this.poBriefer || existsSync(join(this.taskDir(taskId), "po-brief.md"))) return;
        this.setTaskStatus(taskId, "running", "the Product Owner is writing a brief on the ticket");
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.poBriefer(task, this.taskDir(taskId)), new Promise<void>((resolve) => (timer = setTimeout(resolve, 6 * 60_000)))])
            .catch((e: unknown) => console.warn(`[po] brief ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`))
            .finally(() => clearTimeout(timer));
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

    private async completeFromDisk(taskId: string, runId: string, stage: Stage): Promise<boolean> {
        const def = STAGE_DEFS[stage];
        if (!def.contract || !def.outputFile) return false;
        const validation = await this.validateOutput(taskId, def);
        if (!validation.ok) return false;
        this.db
            .prepare(`UPDATE runs SET status = 'done', finished_at = COALESCE(finished_at, ?), error = NULL, result_json = ? WHERE id = ?`)
            .run(now(), JSON.stringify(validation.data), runId);
        this.afterStage(taskId, def, validation.data);
        return true;
    }

    private tick(): void {
        this.pollPrs();
        this.processPendingRebases();
        const due = this.db
            .prepare(`SELECT * FROM tasks WHERE status IN ('rate_limited', 'queued')`)
            .all() as TaskRow[];
        for (const task of due) {
            const run = this.latestRun(task.id);
            if (task.status === "rate_limited" && run?.resume_at && new Date(run.resume_at).getTime() > Date.now()) continue;
            this.dispatch(task.id, task.stage, {
                ...(this.queuedOpts.get(`${task.id}:${task.stage}`) ?? {}),
                notes: "You were interrupted (rate limit or queue). Continue from the current state of the task directory; do not redo finished work.",
            });
        }
        // Shards of a QA pass or of a PR Fix round that waited for capacity get another go.
        for (const g of this.qaGroups.values()) this.pumpGroup(g);
        for (const g of this.prGroups.values()) this.pumpPrGroup(g);
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

    // The branch this task diffs, rebases and opens its PR against: its own base_branch (a stacked PR's parent branch)
    // or the env's. `layoutOf` is the env with that base substituted, for the git helpers and prompts that take an env.
    // `repo` = the sub-repository directory ("" for a single repo): a multi-repo task can be stacked per repository.
    baseBranchOf(task: Pick<TaskRow, "base_branch">, env: EnvRow, repo = ""): string {
        return baseBranchFor(task.base_branch, repo, env.base_branch);
    }
    // Every repository's base, keyed by directory ("" for a single repo).
    baseBranchesOf(task: Pick<TaskRow, "base_branch">, env: EnvRow): Record<string, string> {
        return Object.fromEntries(this.prRepos(env).map((repo) => [repo, this.baseBranchOf(task, env, repo)]));
    }
    // The distinct bases as one label: "dev", or "backend: x, frontend: dev" when repositories differ.
    baseBranchLabel(task: Pick<TaskRow, "base_branch">, env: EnvRow): string {
        const bases = this.baseBranchesOf(task, env);
        const distinct = [...new Set(Object.values(bases))];
        return distinct.length <= 1 ? (distinct[0] ?? env.base_branch) : Object.entries(bases).map(([r, b]) => `${repoLabel(r)}: ${b}`).join(", ");
    }
    // Whether any repository of the task is stacked on `branch`.
    private basedOn(task: Pick<TaskRow, "base_branch">, env: EnvRow, branch: string): string[] {
        return Object.entries(this.baseBranchesOf(task, env)).filter(([, b]) => b === branch).map(([r]) => r);
    }
    private layoutOf(task: Pick<TaskRow, "base_branch">, env: EnvRow): EnvRow & { base_branches: Record<string, string> } {
        const bases = this.baseBranchesOf(task, env);
        const distinct = [...new Set(Object.values(bases))];
        return { ...env, base_branch: distinct.length === 1 ? distinct[0]! : env.base_branch, base_branches: bases };
    }
    // The human changes what the task is based on (stacking it on another branch, or back to the env default = null),
    // for every repository (a string) or per repository (a map). Takes effect for diffs, prompts and the PR draft right
    // away; an already-created worktree keeps its start point.
    setBaseBranch(taskId: string, baseBranch: string | Record<string, string> | null): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const env = this.env(task.env_id);
        const base = normalizeBaseBranch(baseBranch, this.prRepos(env), env.base_branch);
        this.db.prepare(`UPDATE tasks SET base_branch = ?, updated_at = ? WHERE id = ?`).run(base, now(), taskId);
        this.emitTask(taskId);
    }

    // Whether a QA pass of this task drives a browser at all: a design whose scenarios are all `kind: "api"` runs with
    // Bash + curl only — no Chrome bridge, no probe, no one-browser-per-account serialization, no tab keeper.
    private qaNeedsBrowser(taskId: string): boolean {
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const scenarios = design?.qa ?? [];
        return scenarios.length === 0 || scenarios.some((s) => (s.kind ?? "browser") === "browser");
    }

    // The app URL browser stages and login prompts point at: the env's template with this task's own BE/FE filled in.
    appUrlFor(task: TaskRow, env: EnvRow): string {
        const be = this.services.get(task.id, "be");
        const fe = this.services.get(task.id, "fe");
        return (env.app_url ?? (fe ? "{{feUrl}}" : "{{beUrl}}")).replace(/\{\{feUrl\}\}/g, fe?.url ?? "").replace(/\{\{beUrl\}\}/g, be?.url ?? "");
    }

    // ---------- gstack's headless browser (config.gstackDir, envs.qa_browser = "gstack") ----------

    // The compiled `browse` CLI of the gstack checkout, when built (`bun install && bun run build` in gstackDir).
    private gstackBin(): string | null {
        const p = join(this.cfg.gstackDir, "browse", "dist", "browse");
        return existsSync(p) ? p : null;
    }

    private gstackWarned = false;
    // Which browser this env's QA runners drive; an env set to gstack without a built binary falls back to Chrome, once with a warning.
    private qaEngine(env: EnvRow): "chrome" | "gstack" {
        if (env.qa_browser !== "gstack") return "chrome";
        if (this.gstackBin()) return "gstack";
        if (!this.gstackWarned) {
            this.gstackWarned = true;
            console.warn(`[stagehand] env ${env.name} asks for the gstack QA browser but ${join(this.cfg.gstackDir, "browse", "dist", "browse")} is not built — using Chrome`);
        }
        return "chrome";
    }

    // One daemon per run: its state file names the port and token; the daemon's own profile dies with `browse stop`.
    private gstackStateFile(taskId: string, shard: QaShard | PrShard | undefined): string {
        return join(this.taskDir(taskId), "qa", "browser", shard?.id || "all", "browse.json");
    }

    private gstackEnv(stateFile: string): Record<string, string> {
        return { ...process.env, BROWSE_STATE_FILE: stateFile, GSTACK_TELEMETRY_OFF: "1" } as Record<string, string>;
    }

    // Starts the daemon for this run (the first `browse status` boots it) and imports the app's session cookies from the
    // QA account's Chrome profile through the daemon's own picker API, so the runner lands logged in. Returns a note for
    // the task chat when the cookies could not be imported (the run still starts; the runner reports the login wall).
    private async prepareGstackBrowser(task: TaskRow, env: EnvRow, stateFile: string): Promise<string | null> {
        const bin = this.gstackBin();
        if (!bin) throw new Error("gstack's browse binary is not built");
        mkdirSync(join(stateFile, ".."), { recursive: true });
        await execFileAsync(bin, ["status"], { env: this.gstackEnv(stateFile), cwd: join(stateFile, ".."), timeout: 90_000 });
        const state = JSON.parse(readFileSync(stateFile, "utf8")) as { port: number; token: string };
        await execFileAsync(bin, ["viewport", "1440x900"], { env: this.gstackEnv(stateFile), cwd: join(stateFile, ".."), timeout: 30_000 }).catch(() => undefined);
        let host: string;
        let origin: string;
        try {
            const u = new URL(this.appUrlFor(task, env));
            host = u.hostname;
            origin = u.origin;
        } catch {
            host = "localhost";
            origin = "http://localhost";
        }
        const run = (args: string[], timeout = 30_000) => execFileAsync(bin, args, { env: this.gstackEnv(stateFile), cwd: join(stateFile, ".."), timeout });
        // The browser's own session first: the env's QA session command signs a QA user in on its own, so nothing the
        // headless browser does (a token refresh that rotates the refresh token, a logout an app sends from a tab it
        // sees as orphaned) reaches the human's browser session (INV-155, 2026-10-05: every pass logged the human out).
        // Only without one are the QA Chrome profile's cookies copied.
        const session = env.qa_session_command?.trim() ? parseCookies(this.qaSessions.get(task.id)) : [];
        const extra = parseCookies(env.qa_browser_cookies);
        let source: string;
        let storage: Record<string, string> = {};
        if (session.length) {
            source = `${session.length} cookie(s) from the QA session command`;
        } else {
            const picked = this.qaBrowser(task, env);
            if ("error" in picked) return `Headless QA browser started without a session: ${picked.error}. The runner will meet the login page.`;
            const names: Record<string, string> = { Google: "chrome", Chromium: "chromium", Arc: "arc", Brave: "brave", "Microsoft Edge": "edge", Comet: "comet" };
            const browserName = names[picked.browser.browser ?? "Google"] ?? "chrome";
            const res = await fetch(`http://127.0.0.1:${state.port}/cookie-picker/import`, {
                method: "POST",
                headers: { Authorization: `Bearer ${state.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ browser: browserName, profile: picked.browser.profileDir, domains: [host] }),
                signal: AbortSignal.timeout(120_000),
            });
            const body = (await res.json().catch(() => ({}))) as { imported?: number; failed?: number; message?: string };
            // The profile's localStorage for the app's origin too: an app that keeps its session there is not signed in
            // by cookies alone.
            const profileDir = picked.browser.profileDir;
            storage = !profileDir ? {} : await readLocalStorage(picked.browser.browser ?? "Google", profileDir, origin).catch((e: unknown) => {
                console.warn(`[stagehand] ${task.ticket_id}: localStorage of "${chromeBrowserLabel(picked.browser)}" not read: ${String((e as Error).message ?? e).slice(0, 200)}`);
                return {};
            });
            const stored = Object.keys(storage).length;
            if ((!res.ok || !body.imported) && !stored) return `Headless QA browser started, but no ${host} cookies or localStorage came over from Chrome profile "${chromeBrowserLabel(picked.browser)}" (${body.message ?? `HTTP ${res.status}`}). The runner will meet the login page — log in there once and retry.`;
            source = `${body.imported ?? 0} ${host} cookie(s)${stored ? ` and ${stored} localStorage entr${stored === 1 ? "y" : "ies"}` : ""} from "${chromeBrowserLabel(picked.browser)}"`;
        }
        // The session's cookies and the env's extra ones (envs.qa_browser_cookies), set on the app's host. gstack sets
        // cookies only for the page it is on, so it first opens a static URL there — no app code runs before they are in.
        const toSet = [...session, ...extra];
        if (toSet.length) {
            const file = join(stateFile, "..", "qa-cookies.json");
            try {
                await run(["goto", `${origin}/favicon.ico`]).catch(() => undefined);
                writeFileSync(file, JSON.stringify(toSet.map((c) => ({ name: c.name, value: c.value, domain: host, path: "/" }))), { mode: 0o600 });
                await run(["cookie-import", file]);
            } catch (e) {
                return `Headless QA browser started, but its cookies could not be set: ${String((e as Error).message ?? e).split("\n").slice(-2).join(" ").slice(0, 200)}. The runner may meet the login page.`;
            } finally {
                rmSync(file, { force: true });
            }
        }
        if (Object.keys(storage).length) {
            try {
                await run(["goto", `${origin}/favicon.ico`]).catch(() => undefined);
                await run(["js", `(() => { const e = ${JSON.stringify(storage)}; for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v); return Object.keys(e).length; })()`]);
            } catch (e) {
                return `Headless QA browser started, but its localStorage could not be set: ${String((e as Error).message ?? e).split("\n").slice(-2).join(" ").slice(0, 200)}. The runner may meet the login page.`;
            }
        }
        console.log(`[stagehand] ${task.ticket_id}: gstack browser on port ${state.port}, ${source}${extra.length ? ` + ${extra.length} extra cookie(s)` : ""}`);
        return null;
    }

    async stopGstackBrowser(stateFile: string): Promise<void> {
        const bin = this.gstackBin();
        if (!bin || !existsSync(stateFile)) return;
        await execFileAsync(bin, ["stop"], { env: this.gstackEnv(stateFile), cwd: join(stateFile, ".."), timeout: 30_000 }).catch(() => undefined);
        rmSync(stateFile, { force: true });
    }

    // No run survives a restart, so no daemon should either (each has a 30-minute idle timeout of its own anyway).
    private async sweepGstackBrowsers(): Promise<void> {
        const tasksDir = join(this.cfg.dataDir, "tasks");
        if (!existsSync(tasksDir) || !this.gstackBin()) return;
        let n = 0;
        for (const id of readdirSync(tasksDir)) {
            const dir = join(tasksDir, id, "qa", "browser");
            if (!existsSync(dir)) continue;
            for (const slot of readdirSync(dir)) {
                const f = join(dir, slot, "browse.json");
                if (!existsSync(f)) continue;
                await this.stopGstackBrowser(f);
                n++;
            }
        }
        if (n) console.log(`[stagehand] ${n} leftover headless QA browser(s) stopped`);
    }

    // ---------- cloned Chrome profiles (chrome-clones.ts) ----------

    // Task id → the cloned Chrome started for its current browser run, on accounts with chrome_clone_qa on.
    private readonly clones = new Map<string, ChromeClone & { accountId: string }>();

    // The profile to copy when this account clones per run: the chosen Chrome profile, resolved to a directory.
    private cloneSourceFor(account: AccountRow): ChromeBrowser | null {
        if (account.chrome_clone_qa !== 1) return null;
        const b = chromeBrowsersOf(account).find((x) => x.deviceId === account.chrome_device_id);
        return b?.profileDir ? b : null;
    }

    // Copies up for this account PLUS copies being prepared for it: preparation takes about a minute and is
    // serialised, so without the second term every shard of a pass passed the cap before any copy was registered
    // (five Chromes at once on 2026-09-23, host down to 58 MB free).
    private readonly cloning = new Map<string, number>();
    private clonesOf(accountId: string): number {
        let n = this.cloning.get(accountId) ?? 0;
        for (const c of this.clones.values()) if (c.accountId === accountId) n++;
        return n;
    }

    // Copies the profile, starts a Chrome on the copy and waits until the copy's extension is listed as a connected
    // browser (the probe is the same `claude -p --chrome` round trip the shared-profile path pays for chromeVerified).
    // Copies are prepared one at a time: three started together (INV-63's shards, 2026-09-22) had their probes overlap
    // while the relay was still pairing, and none was recognised.
    private cloneLock: Promise<unknown> = Promise.resolve();
    private async prepareClone(task: TaskRow, account: AccountRow, source: ChromeBrowser, configDir: string, url: string): Promise<ChromeClone> {
        const previous = this.cloneLock;
        let release: () => void = () => undefined;
        this.cloneLock = new Promise<void>((r) => (release = r));
        await previous.catch(() => undefined);
        try {
            const port = await pickCdpPort(new Set([...this.clones.values()].map((c) => c.cdpPort)));
            const slot = `${task.ticket_id.toLowerCase()}-${randomUUID().slice(0, 6)}`;
            const bare = await cloneProfile(source.browser ?? "Google", source.profileDir!, slot, port);
            const clone = await launchClone(bare, url, this.clones.size);
            const usage = (res: ResultEvent) => recordUsage(this.db, { accountId: account.id, envId: task.env_id, taskId: task.id, runId: null, kind: "probe", stage: null }, res);
            for (let i = 0; i < 4; i++) {
                const r = await probeChrome(configDir, task.worktree_path ?? this.env(task.env_id).path, 1, usage);
                if (r.browsers.some((b) => b.deviceId === clone.deviceId)) return clone;
                await new Promise((res) => setTimeout(res, 3_000));
            }
            await quitClone(clone);
            throw new Error(`the copy's extension (${clone.deviceId.slice(0, 8)}…) did not connect as a browser within 4 probes`);
        } finally {
            release();
        }
    }

    // ---------- the task session (shared by Research, Design, Implementation, PR Fix, Chat, Do, fixes) ----------

    // Every config dir a task's session may have been written under.
    private transcriptDirs(task: TaskRow): string[] {
        const dirs = [this.configDirOf(this.env(task.env_id)).path, this.cfg.mainConfigDir];
        if (existsSync(this.cfg.accountsDir)) for (const d of readdirSync(this.cfg.accountsDir)) dirs.push(join(this.cfg.accountsDir, d));
        return dirs;
    }

    sessionInfo(taskId: string): { sessionId: string; transcriptMb: number | null; path: string | null; maxMb: number } {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const t = findTranscript(this.transcriptDirs(task), task.session_id);
        return { sessionId: task.session_id, transcriptMb: t?.sizeMb ?? null, path: t?.path ?? null, maxMb: this.cfg.resources.maxSessionMb };
    }

    // Gives the task a fresh session id. The old transcript stays on disk; the agent's next run starts without the
    // conversation and is told so through the task notes (every prompt carries them).
    rotateSession(taskId: string, reason: string): { previous: string; next: string; transcriptMb: number | null } {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const t = findTranscript(this.transcriptDirs(task), task.session_id);
        const next = randomUUID();
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const handover = `Session rotated ${stamp} UTC (${reason}): the earlier conversation is gone. Before acting, read ${this.taskDir(taskId)}/design.md, impl.json, review.json and the Chat tab for what was decided and done.`;
        const notes = task.notes?.trim() ? `${task.notes.trim().replace(/\n?Session rotated [^\n]*/g, "")}\n${handover}`.trim() : handover;
        this.db.prepare(`UPDATE tasks SET session_id = ?, notes = ?, updated_at = ? WHERE id = ?`).run(next, notes, now(), taskId);
        this.addMessage(taskId, "agent", `♻️ New task session: ${reason}. The previous transcript (${t ? `${t.sizeMb} MB` : "not found on disk"}, session ${task.session_id.slice(0, 8)}…) is kept on disk but no longer resumed — every resumed run was paying for the whole conversation.`);
        this.emitTask(taskId);
        return { previous: task.session_id, next, transcriptMb: t?.sizeMb ?? null };
    }

    // How the next run joins the task session: resume it, or — when there is no transcript yet, or it has grown past
    // resources.maxSessionMb (a 32 MB session cost ~$230 per resumed run, even for a one-turn chat, 2026-09-24) — a
    // fresh session under the task's name.
    private sessionArgs(task: TaskRow): { resume: string } | { sessionId: string; name: string } {
        const cur = this.getTask(task.id) ?? task;
        const t = findTranscript(this.transcriptDirs(cur), cur.session_id);
        if (!t) return { sessionId: cur.session_id, name: cur.ticket_id };
        const max = this.cfg.resources.maxSessionMb;
        if (max > 0 && t.sizeMb > max) {
            const r = this.rotateSession(cur.id, `the transcript reached ${t.sizeMb} MB (limit ${max} MB)`);
            return { sessionId: r.next, name: cur.ticket_id };
        }
        return { resume: cur.session_id };
    }

    // For the resource registry (resources.ts): the live clones with their task and map key.
    cloneList(): Array<{ key: string; taskId: string; slot: string; dir: string; pid: number | null; cdpPort: number }> {
        return [...this.clones.entries()].map(([key, c]) => ({ key, taskId: key.split(":")[0]!, slot: c.slot, dir: c.dir, pid: c.pid, cdpPort: c.cdpPort }));
    }

    async releaseClone(taskId: string): Promise<void> {
        const clone = this.clones.get(taskId);
        if (!clone) return;
        this.clones.delete(taskId);
        await quitClone(clone);
    }

    // A clone whose task stopped while parked, or was moved by the human, is ended (a run's own end releases its clone directly).
    private async reapClones(): Promise<void> {
        for (const taskId of [...this.clones.keys()]) {
            // The key is the task id, or `<task id>:<shard id>` for a shard of a parallel QA pass.
            const t = this.getTask(taskId.split(":")[0]!);
            // "queued" is written by parkQueued straight into the row (not part of TaskStatus).
            if (!t || !["running", "queued"].includes(t.status as string)) await this.releaseClone(taskId);
        }
    }

    // The clone map key of a dispatch: one copy per task, or one per shard of a parallel QA pass.
    private cloneKey(taskId: string, shard: QaShard | undefined): string {
        return shard ? `${taskId}:${shard.id}` : taskId;
    }

    // AI accounts page: one full copy → launch → bridge round trip on the account's profile, then cleanup.
    async testClone(account: AccountRow, configDir: string): Promise<{ ok: boolean; detail: string }> {
        const source = chromeBrowsersOf(account).find((b) => b.deviceId === account.chrome_device_id);
        if (!source?.profileDir) return { ok: false, detail: "pick the account's Chrome profile first (Probe Chrome, then the profile select)" };
        const started = Date.now();
        let clone: ChromeClone | null = null;
        try {
            const port = await pickCdpPort(new Set([...this.clones.values()].map((c) => c.cdpPort)));
            const c = await launchClone(await cloneProfile(source.browser ?? "Google", source.profileDir, `test-${randomUUID().slice(0, 6)}`, port), "about:blank", this.clones.size);
            clone = c;
            const launched = ((Date.now() - started) / 1000).toFixed(1);
            const usage = (res: ResultEvent) => recordUsage(this.db, { accountId: account.id, envId: null, taskId: null, runId: null, kind: "probe", stage: null }, res);
            for (let i = 0; i < 4; i++) {
                const r = await probeChrome(configDir, this.cfg.dataDir, 1, usage);
                if (r.browsers.some((b) => b.deviceId === c.deviceId)) {
                    return { ok: true, detail: `OK — profile "${chromeBrowserLabel(source)}" copied and started in ${launched} s; the copy's extension connected as its own browser (${c.deviceId.slice(0, 8)}…) after ${((Date.now() - started) / 1000).toFixed(0)} s; ${r.browsers.length} browser(s) connected in total` };
                }
                await new Promise((res) => setTimeout(res, 3_000));
            }
            return { ok: false, detail: `the copy started (CDP port ${port}) but its extension never appeared as a connected browser — is the extension in "${chromeBrowserLabel(source)}" signed into ${account.email ?? "this account"}?` };
        } catch (e) {
            return { ok: false, detail: String((e as Error).message ?? e).slice(0, 300) };
        } finally {
            if (clone) await quitClone(clone);
        }
    }

    private chromeSelectStep(account: AccountRow | null, clone?: ChromeClone): string {
        if (clone) {
            return `Before any other browser tool, load mcp__claude-in-chrome__select_browser with ToolSearch and call it with deviceId "${clone.deviceId}" (a copy of Chrome profile "${account?.chrome_browser_name ?? "QA"}" started for this run only — its own window). Never call switch_browser or AskUserQuestion.`;
        }
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
    createTask(envId: string, tickets: string[], accountId?: string, model?: string, notes?: string, baseBranch?: string | Record<string, string>): TaskRow {
        const env = this.env(envId);
        // Only a base that differs from the env's is stored; the env default stays the single source of truth otherwise.
        const base = normalizeBaseBranch(baseBranch, this.prRepos(env), env.base_branch);
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
                `INSERT INTO tasks (id, env_id, ticket_id, source, ticket_url, model, session_id, account_id, stage, status, status_line, pinned, notes, extra_tickets, base_branch, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'research', 'running', 'fetching ticket', 0, ?, ?, ?, ?, ?)`,
            )
            .run(id, env.id, ref.id, ref.source, ref.url, model ?? null, sessionId, accountId ?? accountOrderOf(env)[0] ?? null, notes?.trim() || null, extras.length ? JSON.stringify(extras) : null, base, ts, ts);
        this.taskDir(id);
        const task = this.getTask(id)!;
        this.recordTaskEvent(id, "research", "running");
        this.emit("task", task);
        this.fetchTicketThenResearch(id);
        return task;
    }

    // ---------- control ----------

    stop(taskId: string): void {
        const adhoc = this.instructing.get(taskId);
        if (adhoc) {
            // The instruction run restores the task's previous status itself when it exits.
            adhoc.kill();
            return;
        }
        this.killTaskRuns(taskId);
        this.setTaskStatus(taskId, "stopped", "stopped by user");
    }

    // Every run of the task that is still going (a parallel QA pass has several), and the shards still waiting to start.
    private killTaskRuns(taskId: string): void {
        for (const g of [...this.qaGroups.values()]) if (g.taskId === taskId) this.qaGroups.delete(g.id);
        for (const g of [...this.prGroups.values()]) if (g.taskId === taskId) this.prGroups.delete(g.id);
        this.queuedPrRounds.delete(taskId);
        const running = this.db.prepare(`SELECT id FROM runs WHERE task_id = ? AND status = 'running'`).all(taskId) as Array<{ id: string }>;
        for (const r of running) this.active.get(r.id)?.kill();
    }

    // A task at PR Fix that failed after its agent run finished and the human approved the fix: the only step in
    // between is the push, so that is what failed.
    private pushFailedAfterPrFix(taskId: string): boolean {
        const task = this.getTask(taskId);
        if (!task || task.stage !== "pr_fix" || task.status !== "failed") return false;
        const last = this.latestRun(taskId);
        if (!last || last.stage !== "pr_fix" || last.status !== "done") return false;
        const since = last.finished_at ?? last.started_at ?? "";
        return !!this.db.prepare(`SELECT 1 FROM reviews WHERE task_id = ? AND stage = 'pr_fix' AND verdict = 'approve' AND created_at >= ? LIMIT 1`).get(taskId, since);
    }

    retry(taskId: string): void {
        const task = this.getTask(taskId);
        if (!task) return;
        // A task parked in the separate QA baseline stage from before it was folded into the design stage (no loop pass
        // running): Retry moves on to Implementation instead of running it.
        if (task.stage === "qa_baseline" && task.status !== "running" && this.readArtifactJson<DesignBaseline>(taskId, "design-baseline.json")?.status !== "running") {
            this.killTaskRuns(taskId);
            if (this.baseCheckout.isOn(taskId)) {
                void this.fromBase(taskId).then((ok) => ok && this.advance(taskId, "qa_baseline"));
                return;
            }
            this.advance(taskId, "qa_baseline");
            return;
        }
        // A blocked stage (auth, app down, bridge) has a valid-but-useless output file; it must run again, not be "completed from disk".
        if (task.status === "blocked") {
            this.rerun(taskId, task.stage);
            return;
        }
        if (task.stage === "research" && !existsSync(join(this.taskDir(taskId), "ticket.json")) && !this.latestRun(taskId)) {
            this.fetchTicketThenResearch(taskId);
            return;
        }
        // An approved PR Fix whose push was rejected afterwards: the fix is committed, verified and reviewed, so the
        // push runs again — not the agent, and not the verification-and-review round (INV-133, 2026-09-23: Retry
        // re-verified the finished fix and asked for a second approval before it pushed).
        if (this.pushFailedAfterPrFix(taskId)) {
            void this.pushPrFix(taskId);
            return;
        }
        const last = this.latestRun(taskId);
        // Only an output file the failed run itself wrote can complete the stage from disk: an older one belongs to a
        // previous attempt (INV-132's Manual QA, 2026-09-20 — the first attempt's after.json, 2 scenarios blocked, was
        // taken as the result of a later run that died on a network error, and the task went blocked without a run).
        const outputFile = STAGE_DEFS[task.stage]?.outputFile;
        const fresh = !outputFile || (last ? this.outputWrittenDuringRun(taskId, outputFile, last.id) : false);
        const resume = (): void => {
            // A PR Fix round is replayed from its saved jobs (its runs may have been fresh per-repository sessions).
            if (task.stage === "pr_fix") {
                const spec = this.readArtifactJson<PrRoundSpec>(taskId, "pr_fix_round.json");
                if (spec && Object.keys(spec.jobs).length) {
                    this.startPrRound(taskId, spec.jobs, { attempt: spec.attempt, contractAttempt: spec.contractAttempt, operation: spec.operation, notes: "Previous attempt did not complete. Continue from the current state of the worktree; do not redo finished work." });
                    return;
                }
            }
            // A QA pass that stopped half-way (a restart, a Stop, a shard that died) keeps what its runs recorded in
            // qa/<pass>.partial.json; only the scenarios without a verdict are driven again.
            const extraVars = task.stage === "qa_baseline" || task.stage === "manual_qa" ? this.resumeFromPartial(taskId, task.stage) : null;
            this.dispatch(taskId, task.stage, { notes: "Previous attempt did not complete. Continue from the current state of the task directory.", ...(extraVars ? { extraVars } : {}) });
        };
        // A shard of a parallel pass is never completed from disk: the pass file, if any, belongs to an earlier pass.
        if (last && last.stage === task.stage && fresh && !last.group_id) {
            void this.completeFromDisk(taskId, last.id, task.stage).then((done) => {
                if (!done) resume();
            });
            return;
        }
        resume();
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
    // tabs through osascript. The profile persists, so this is needed once per app session lifetime. A provider that
    // sends the browser back to the env's fixed callback port is handled by the hop watcher (startCallbackHopWatcher).
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
    // What a browser-stage dispatch had already paid for (seeds run, Chrome bridge probed) when it was parked behind a
    // busy Chrome profile or the concurrency cap, keyed `taskId:stage`. tick() re-dispatches with it, so a queued task
    // re-checks the queue every 15 s instead of re-seeding and re-probing (a `claude -p --chrome` session) each time.
    // Services are deliberately not carried over: bringUpServices is cheap when they are alive and restarts them if not.
    private readonly queuedOpts = new Map<string, DispatchOpts>();
    private parkQueued(taskId: string, stage: Stage, opts: DispatchOpts): void {
        const { notes: _notes, servicesReady: _services, ...rest } = opts;
        this.queuedOpts.set(`${taskId}:${stage}`, rest);
        const prev = this.getTask(taskId);
        this.db.prepare(`UPDATE tasks SET status = 'queued' WHERE id = ?`).run(taskId);
        if (prev && (prev.status as string) !== "queued") this.recordTaskEvent(taskId, stage, "queued");
    }

    // ---------- the login callback hop, always on ----------
    //
    // Identity providers typically accept only the app's usual port as a callback (https://localhost:<port>), so an app
    // on a Stagehand port pins that redirect and the browser lands on whatever holds that port after logging in (an
    // error page, or another app). Each env names its provider's fixed callback ports (envs.callback_ports, JSON
    // [{ port, relay }]); Stagehand knows no port of its own. The QA prompt and the login helper move such a tab to the
    // right port themselves — but a human who opens the app from the App widget or a Session and logs in by hand had
    // nobody doing it, and the login failed. This watcher does it for every Chrome tab (all profiles) while an app of
    // such an env is up. It remembers which Stagehand app origin each tab was on, and handles both ways a login can end
    // on a callback port:
    // - nothing (or a foreign app) holds the port → the tab sits on the callback URL (`/?code=…` for an SPA,
    //   `/auth/callback?code=…` for a server-side flow); once it has been there for two polls (an app that genuinely
    //   lives there consumes that query within a second) the same path+query is re-opened on the origin the tab came
    //   from, where the app finishes the exchange (the state cookie is host-scoped, so it is there on any port);
    // - another instance of the same app holds the port (the human's own dev server) → it consumes the callback at once,
    //   sets the login cookie (host-scoped: valid on every port) and lands the tab on its own pages. The tab is moved
    //   to the same path on the origin it came from, where it is now logged in. Recognised by the sequence
    //   task app → identity provider → callback port, and done at most once a minute per tab so an app whose login is
    //   per-origin (an SPA with tokens in storage) cannot ping-pong between the two ports.
    // Any browser (Safari too): for a port the env marks `relay`, Stagehand holds the port while one of its apps is up
    // and redirects the callback to that app — see CallbackRelay. TLS from the same locally trusted pair the dev UI uses.

    // The running apps of envs with callback ports: each app's origin (its FE, or its BE when the env's app URL is the
    // BE) with its env's ports.
    private callbackApps(): Array<{ origin: string; ports: Array<{ port: number; relay: boolean }> }> {
        const rows = this.db
            .prepare(
                `SELECT s.url, e.callback_ports FROM services s JOIN tasks t ON t.id = s.task_id JOIN envs e ON e.id = t.env_id
                 WHERE s.stopped_at IS NULL AND s.failed_at IS NULL AND e.callback_ports IS NOT NULL
                   AND ((s.kind = 'fe' AND COALESCE(e.app_url, '') NOT LIKE '%{{beUrl}}%') OR (s.kind = 'be' AND e.app_url LIKE '%{{beUrl}}%'))`,
            )
            .all() as Array<{ url: string; callback_ports: string }>;
        return rows.map((r) => ({ origin: new URL(r.url).origin, ports: callbackPortsOf(r.callback_ports) })).filter((a) => a.ports.length);
    }

    private readonly relays = new Map<number, CallbackRelay>();
    private startCallbackRelay(): void {
        const tlsDir = join(this.cfg.dataDir, "tls");
        const tls = () => {
            const cert = join(tlsDir, "cert.pem");
            const key = join(tlsDir, "key.pem");
            return existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : null;
        };
        const sync = (): void => {
            const declared = new Set<number>();
            for (const e of this.db.prepare(`SELECT callback_ports FROM envs WHERE callback_ports IS NOT NULL`).all() as Array<{ callback_ports: string }>)
                for (const p of callbackPortsOf(e.callback_ports)) if (p.relay) declared.add(p.port);
            for (const port of declared) {
                if (this.relays.has(port)) continue;
                this.relays.set(port, new CallbackRelay(port, tls, () => [...new Set(this.callbackApps().filter((a) => a.ports.some((p) => p.port === port && p.relay)).map((a) => a.origin))].filter((o) => !o.endsWith(`:${port}`))));
            }
            for (const r of this.relays.values()) r.sync();
        };
        sync();
        setInterval(sync, 5_000).unref();
    }

    private readonly tabOrigins = new Map<string, { origin: string; at: number }>();
    private readonly tabPrevUrl = new Map<string, string>();
    private readonly tabHoppedAt = new Map<string, number>();
    private hopSeen = "";
    private startCallbackHopWatcher(): void {
        let ports = new Set<number>();
        const portOf = (u: string): number | null => {
            const m = /^https?:\/\/localhost:(\d+)(\/|$)/.exec(u);
            return m ? Number(m[1]) : null;
        };
        const onCallbackPort = (u: string) => ports.has(portOf(u) ?? -1);
        const isCallback = (u: string) => onCallbackPort(u) && /\?(?=.*\bcode=)(?=.*\bstate=)/.test(u);
        const isIdp = (u: string) => /^https:\/\/[^/]*(auth0\.com|authkit\.app|workos\.com|okta\.com|login\.microsoftonline\.com|accounts\.google\.com)\//.test(u);
        const pathAndQuery = (u: string): string => {
            const x = new URL(u);
            return `${x.pathname}${x.search}${x.hash}`;
        };
        const tick = async (): Promise<void> => {
            // The app of each running task of an env with callback ports, and those ports.
            const apps = this.callbackApps();
            ports = new Set(apps.flatMap((a) => a.ports.map((p) => p.port)));
            const origins = [...new Set(apps.map((a) => a.origin))].filter((o) => !onCallbackPort(`${o}/`));
            if (origins.length === 0) {
                this.tabOrigins.clear();
                this.tabPrevUrl.clear();
                this.hopSeen = "";
                return;
            }
            const tabs = await listChromeTabs("Google");
            const now_ = Date.now();
            const seen = new Set<string>();
            for (const t of tabs) {
                const key = `${t.window}:${t.tab}`;
                seen.add(key);
                const on = origins.find((o) => t.url.startsWith(`${o}/`) || t.url === o);
                if (on) this.tabOrigins.set(key, { origin: on, at: now_ });
            }
            for (const [key, v] of this.tabOrigins) if (now_ - v.at > 30 * 60_000) this.tabOrigins.delete(key);
            for (const key of this.tabPrevUrl.keys()) if (!seen.has(key)) this.tabPrevUrl.delete(key);
            const remember = (): void => {
                for (const t of tabs) this.tabPrevUrl.set(`${t.window}:${t.tab}`, t.url);
            };
            // Case 2: the callback was consumed by the app on the callback port — the tab came from a task app, went through
            // the identity provider, and is now on the callback port without a callback query.
            for (const t of tabs) {
                const key = `${t.window}:${t.tab}`;
                if (!onCallbackPort(t.url) || isCallback(t.url)) continue;
                const prev = this.tabPrevUrl.get(key) ?? "";
                const from = this.tabOrigins.get(key);
                if (!from || now_ - from.at > 10 * 60_000) continue;
                // A provider with a live SSO session bounces faster than one poll: the previous poll then still shows
                // the task FE itself, so a tab that was on it a moment ago and is on the callback port now counts as well.
                const straightFromFe = prev.startsWith(from.origin) && now_ - from.at <= 2 * LOGIN_POLL_MS + 500;
                if (!(isIdp(prev) || isCallback(prev) || straightFromFe)) continue;
                if (now_ - (this.tabHoppedAt.get(key) ?? 0) < 60_000) continue;
                this.tabHoppedAt.set(key, now_);
                await setChromeTabUrl(t, `${from.origin}${pathAndQuery(t.url)}`, "Google");
                console.log(`[stagehand] login landed on callback port ${portOf(t.url)} (consumed by the app there); tab moved back to ${from.origin}${pathAndQuery(t.url)}`);
                remember();
                return;
            }
            // Case 1: the callback is sitting unconsumed on the callback port.
            const cb = tabs.find((t) => isCallback(t.url));
            if (!cb) {
                this.hopSeen = "";
                remember();
                return;
            }
            const mark = `${cb.window}:${cb.tab}:${cb.url}`;
            if (this.hopSeen !== mark) {
                this.hopSeen = mark;
                remember();
                return;
            }
            this.hopSeen = "";
            const target = this.tabOrigins.get(`${cb.window}:${cb.tab}`)?.origin ?? (origins.length === 1 ? origins[0] : undefined);
            if (!target) {
                console.warn(`[stagehand] login callback on port ${portOf(cb.url)} in a tab never seen on a task app and ${origins.length} task apps are up — not hopping`);
                remember();
                return;
            }
            await setChromeTabUrl(cb, `${target}${pathAndQuery(cb.url)}`, "Google");
            console.log(`[stagehand] login callback hopped from port ${portOf(cb.url)} to ${target}${pathAndQuery(cb.url)}`);
            remember();
        };
        let busy = false;
        setInterval(() => {
            if (busy) return;
            busy = true;
            void tick()
                .catch((e: unknown) => console.warn(`[stagehand] callback hop watcher: ${String((e as Error).message ?? e).slice(0, 160)}`))
                .finally(() => {
                    busy = false;
                });
        }, LOGIN_POLL_MS).unref();
    }

    // Polls every tab (all profiles) until one sits on the app, not on a login page and not on an Auth0 callback, for
    // three consecutive polls. A callback that landed on the env's fixed callback port is moved to the app's port by the
    // always-on hop watcher (startCallbackHopWatcher) — this loop only waits for the result.
    private async waitForLogin(appUrl: string, browserKind: string, budgetMs: number, stale: Set<string>): Promise<"logged_in" | "timeout"> {
        const origin = new URL(appUrl).origin;
        const loginish = (t: ChromeTabLike) => /auth0\.com|\/callback|[?&](code|error)=/.test(t.url) || /welcome|log ?in|sign ?in/i.test(t.title);
        let stableSince = 0;
        let stableUrl = "";
        const until = Date.now() + budgetMs;
        while (Date.now() < until) {
            const tabs = (await listChromeTabs(browserKind)).filter((t) => !stale.has(tabKey(t)));
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

    // "Skip Manual QA": the human's way out of a Manual QA pass that cannot finish on its own — blocked on the
    // environment (a migration not applied, a seed that cannot run) with nothing left to retry but the same wall
    // (2026-09-29: "these types of situations are deadlocks from my end"). The task goes on to User Review without an
    // after-state for this pass; the human QAs by hand there. Open questions of the pass are dismissed.
    skipManualQa(taskId: string): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.stage !== "manual_qa") throw new Error("the task is not at Manual QA");
        if (task.status === "running") throw new Error("Manual QA is running — stop it first");
        this.killTaskRuns(taskId);
        this.dismissPendingQuestions(taskId);
        this.addAgentNote(taskId, `Manual QA skipped by you (it was ${task.status}: ${(task.status_line ?? "").slice(0, 200)}) — no after-state for this pass; QA by hand in User Review`);
        this.advance(taskId, "user_review");
    }

    // The human discards a pending PR Fix (they undid it, or handled it by hand): nothing is pushed, the proposal is
    // archived, and the task's stage comes from its PRs again (INV-149, 2026-10-06: the human deleted the fix commit,
    // but the task kept waiting on it).
    discardPrFix(taskId: string): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.stage !== "pr_fix") throw new Error("the task is not at PR Fix");
        if (task.status === "running" || this.hasLiveRun(taskId)) throw new Error("PR Fix is running — stop it first");
        this.killTaskRuns(taskId);
        this.dismissPendingQuestions(taskId);
        for (const f of ["pr_fix.json", "pr_fix_round.json"]) {
            const p = join(this.taskDir(taskId), f);
            if (existsSync(p)) renameSync(p, `${p}.discarded-${Date.now()}`);
        }
        this.addAgentNote(taskId, "PR Fix discarded by you — nothing pushed; the task follows its PRs again");
        this.setStage(taskId, "pr_waiting");
        this.setTaskStatus(taskId, "idle", "PR Waiting · fix discarded — reading the PRs");
        this.syncPrTaskState(taskId, { force: true });
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
        // The QA baseline is part of the Design Proposal: it runs again only there.
        if (stage === "qa_baseline" && task.stage !== "design_proposal" && task.stage !== "qa_baseline") throw new Error("the QA baseline runs only in the Design Proposal stage");
        // A re-run from scratch: nothing of an earlier pass is resumed (partial results, shard outputs) — except the
        // results the design loop's pass reuses (qa/before.carry.json) when that pass is re-run (Retry on a blocked one).
        const carry = stage === "qa_baseline" && task.stage === "qa_baseline" ? this.readArtifactJson<unknown>(taskId, "qa/before.carry.json") : null;
        if (stage === "qa_baseline" || stage === "manual_qa") this.clearPassFiles(taskId, stage === "qa_baseline" ? "before" : "after");
        if (carry) writeFileSync(join(this.taskDir(taskId), "qa", "before.carry.json"), JSON.stringify(carry, null, 2));
        // A baseline re-run before the design is approved ends in the design agent's review, like the loop's own passes.
        if (stage === "qa_baseline" && task.stage === "design_proposal") {
            const prev = this.readArtifactJson<DesignBaseline>(taskId, "design-baseline.json");
            this.writeDesignBaseline(taskId, { status: "running", round: prev?.round ?? 1, qaHash: qaHashOf(this.readArtifactJson<DesignResult>(taskId, "design.json")), ...(prev?.hashes ? { hashes: prev.hashes } : {}) });
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
        this.killTaskRuns(taskId);
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
        return worktreeDiff(this.layoutOf(task, env), task.worktree_path, parseEnvVars(env.env_vars));
    }

    // Sub-repos ("" for a single-repo env) whose base branch was rewritten under this branch — see git.baseDrift.
    async baseDrift(taskId: string): Promise<string[]> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path) return [];
        const env = this.env(task.env_id);
        return baseDrift(this.layoutOf(task, env), task.worktree_path, parseEnvVars(env.env_vars));
    }

    // The same changes narrowed to a set of commits, or to what is not committed yet.
    async diffFiltered(taskId: string, filter: { shas: string[] } | { uncommitted: true }): Promise<DiffGroup[]> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path) return [];
        const env = this.env(task.env_id);
        const vars = parseEnvVars(env.env_vars);
        const layout = this.layoutOf(task, env);
        return "uncommitted" in filter ? [await uncommittedGroup(layout, task.worktree_path, vars)] : commitsDiff(layout, task.worktree_path, filter.shas, vars);
    }

    async commits(taskId: string): Promise<{ commits: BranchCommit[]; uncommitted: boolean; dirty: string[] }> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path) return { commits: [], uncommitted: false, dirty: [] };
        const env = this.env(task.env_id);
        return branchCommits(this.layoutOf(task, env), task.worktree_path, parseEnvVars(env.env_vars));
    }

    setAccount(taskId: string, accountId: string): void {
        this.db.prepare(`UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?`).run(accountId, now(), taskId);
        this.emitTask(taskId);
    }

    // The task's Product Owner (product-owners.ts): null clears it.
    setProductOwner(taskId: string, poId: string | null): void {
        this.db.prepare(`UPDATE tasks SET product_owner_id = ?, updated_at = ? WHERE id = ?`).run(poId, now(), taskId);
        this.emitTask(taskId);
    }

    // A change to what the task page shows that is not a column of the task (a PO review file): the page re-reads.
    touchTask(taskId: string): void {
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
    returnTo(taskId: string, stage: Stage, notes?: string, comments?: LineComment[], skipQa = false, files: SharedFile[] = []): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        this.autopilotHuman(taskId);
        const idx = STAGES.indexOf(stage);
        const cur = STAGES.indexOf(task.stage);
        if (idx < 0 || idx > cur) throw new Error(`cannot return to ${stage} from ${task.stage}`);
        const def = STAGE_DEFS[stage];
        this.setSkipQa(taskId, skipQa);
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
        const hasContent = !!notes?.trim() || cs.length > 0 || files.length > 0;
        this.dispatch(taskId, stage, {
            notes: hasContent
                ? `${renderReviewNotes(prior.n + 1, notes, cs, stage)}${renderSharedFiles(files, this.taskDir(taskId))}\n\n(The task was sent back to this stage by the human after a later stage; later stages will run again after you.)`
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
                    const repo = task.worktree_path === cwd ? "" : relative(task.worktree_path, cwd);
                    const ahead = await this.git(cwd, ["log", "--oneline", remote ? `origin/${task.branch}..HEAD` : `origin/${this.baseBranchOf(task, env, repo)}..HEAD`], env).catch(() => "");
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
        if (opts.removeWorktree && taskDbRow(this.db, task.id)) {
            const dropped = await this.taskDbs.drop(task, env).catch((e: unknown) => {
                skipped.push(`task database not dropped: ${String((e as Error).message ?? e).slice(0, 160)}`);
                return null;
            });
            if (dropped?.length) done.push(`task database${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")} dropped`);
        }
        if (opts.removeWorktree && task.worktree_path && existsSync(task.worktree_path)) {
            if (env.cleanup_command) {
                this.setTaskStatus(task.id, task.status, "cleanup · running the environment's cleanup command");
                const error = await this.runCleanupCommand(task, env, vars);
                if (error) skipped.push(`cleanup command failed: ${error}`);
                else done.push("cleanup command ran");
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

    // Runs the env's cleanup command from the task's worktree (drop the per-task databases, free caches, …). Returns the
    // error text when it failed, null when it ran. The command must be idempotent: it runs when the task reaches Done
    // and again from "Clean up" / Delete before the worktree goes.
    private async runCleanupCommand(task: TaskRow, env: EnvRow, vars: Record<string, string>): Promise<string | null> {
        if (!env.cleanup_command || !task.worktree_path || !existsSync(task.worktree_path)) return null;
        try {
            await runWorktreeSetup(task.worktree_path, env.path, withPrepare(env, env.cleanup_command), { ...vars, ...taskDbEnv(this.db, task.id) });
            return null;
        } catch (e) {
            return String((e as Error).message ?? e).slice(0, 160);
        }
    }

    // ---------- task databases (task-db.ts, docs/db-isolation.md) ----------

    // Recreate (a task on its own database) and Adopt (a task still on the shared one) are the same step: stop the
    // task's services, refresh the template, copy it into the task's database, point the worktree at it. The next BE
    // start migrates it to the branch.
    async recreateTaskDb(taskId: string): Promise<TaskDbRow> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const env = this.env(task.env_id);
        if (!taskDbActive(taskDbOf(env))) throw new Error("this environment has no task databases configured (env page → Task databases)");
        if (!task.worktree_path || !existsSync(task.worktree_path)) throw new Error("the task has no worktree");
        if (task.status === "running" || this.hasLiveRun(taskId)) throw new Error("the task is running — wait for it or stop it first");
        if (this.baseCheckout.isOn(taskId)) throw new Error("the worktree is on the base for the QA baseline — Retry the task so it returns to its branch first");
        const adopt = taskDbRow(this.db, taskId)?.status !== "ready";
        // A task blocked at the start because its database could not be created never ran the env's setup either
        // (INV-156, 2026-10-06: no .env to point at the database): it runs now, before connect.
        const setupPending = task.stage === "research" && task.status === "blocked" && !!task.status_line?.startsWith("Task database");
        await this.services.stopAll(taskId);
        const row = await this.taskDbs.create({ id: task.id, slug: task.ticket_id, kind: "task" }, env);
        if (setupPending && env.setup_command) {
            const out = await runWorktreeSetup(task.worktree_path, env.path, withPrepare(env, env.setup_command), { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId) });
            if (out) console.error(`[setup] ${task.ticket_id} ${task.worktree_path} (after its database)\n${out.slice(-1500)}`);
        }
        await this.taskDbs.connect(this.getTask(taskId)!, env);
        const stale = this.taskDbs.lastRefreshError.get(env.id);
        this.addAgentNote(taskId, `🗄️ ${adopt ? "Moved to its own database" : "Database recreated"}: ${row.name}, copied from ${row.template}${stale ? ` as it was — migrating it to ${env.base_branch} failed (${stale})` : ` after migrating it to ${env.base_branch}`}. The next BE start migrates it to this branch.`);
        const cur = this.getTask(taskId)!;
        // A task blocked at the start because its database could not be created continues where it stopped.
        if (cur.stage === "research" && cur.status === "blocked" && cur.status_line?.startsWith("Task database")) this.advance(taskId, "design_proposal");
        else this.emitTask(taskId);
        return row;
    }

    taskDbInfo(taskId: string): { row: TaskDbRow | null; active: boolean; template: string | null; sizeMb: number | null } {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        const env = this.env(task.env_id);
        const c = taskDbOf(env);
        const row = taskDbRow(this.db, taskId) ?? null;
        const listed = this.taskDbs.cachedList(env);
        return { row, active: taskDbActive(c), template: c?.template || null, sizeMb: row ? (listed?.dbs.find((d) => d.name === row.name)?.sizeMb ?? null) : null };
    }

    async envDbOverview(envId: string, force = false) {
        const env = this.env(envId);
        const c = taskDbOf(env);
        const listed = await this.taskDbs.list(env, force);
        const rows = this.taskDbs.rows(envId);
        const tasks = this.db.prepare(`SELECT * FROM tasks WHERE env_id = ?`).all(envId) as TaskRow[];
        const size = (n: string): number | null => listed.dbs.find((d) => d.name === n)?.sizeMb ?? null;
        const wt = this.taskDbs.templateWorktree(env);
        return {
            active: taskDbActive(c),
            template: c?.template ? { name: c.template, sizeMb: size(c.template), worktree: existsSync(wt) ? wt : null, refreshError: this.taskDbs.lastRefreshError.get(envId) ?? null } : null,
            extraTemplates: (c?.extraTemplates ?? []).map((t) => ({ name: t.template, sizeMb: size(t.template), copies: t.copies, refresh: t.refresh })),
            taskDbs: rows.map((r) => {
                const derived = [...new Set([...ownedDbNames(r.name, listed.dbs.map((d) => d.name), rows.filter((o) => o.task_id !== r.task_id).map((o) => o.name)), ...(c ? copyNames(c, r.name).map(([n]) => n) : [])])].filter((n) => n !== r.name && listed.dbs.some((d) => d.name === n));
                return { ...r, ticketId: this.dbOwnerName(r), sizeMb: size(r.name), derived: derived.map((n) => ({ name: n, sizeMb: size(n) })) };
            }),
            // Tasks with a worktree still on the shared database: Adopt moves them.
            shared: tasks.filter((t) => t.worktree_path && existsSync(t.worktree_path) && !rows.some((r) => r.task_id === t.id && r.status === "ready")).map((t) => ({ taskId: t.id, ticketId: t.ticket_id, stage: t.stage, status: t.status })),
            orphans: listed.dbs.filter((d) => !(c ? templatesOf(c) : []).includes(d.name) && !rows.some((r) => r.name === d.name || d.name.startsWith(`${r.name}_`) || (c ? copyNames(c, r.name).some(([n]) => n === d.name) : false))),
            listedAt: new Date(listed.at).toISOString(),
            listError: listed.error,
        };
    }

    // For the Resources page: the template and the task databases of every env that has them (sizes from the last list).
    // A database owner's label: the task's ticket id or the session's name.
    private dbOwnerName(r: TaskDbRow): string | null {
        if (r.owner_kind === "session") return ((this.db.prepare(`SELECT name FROM sessions WHERE id = ?`).get(r.task_id) as { name: string } | undefined)?.name ?? null);
        return this.getTask(r.task_id)?.ticket_id ?? null;
    }

    databaseResources(): Array<{ envId: string; envName: string; name: string; role: "template" | "task" | "orphan"; taskId: string | null; ownerKind: "task" | "session"; ownerName: string | null; sizeMb: number | null; createdAt: string | null }> {
        const out: ReturnType<Engine["databaseResources"]> = [];
        for (const env of this.db.prepare(`SELECT * FROM envs`).all() as EnvRow[]) {
            const c = taskDbOf(env);
            const rows = this.taskDbs.rows(env.id);
            if (!c?.template && !rows.length) continue;
            const listed = this.taskDbs.cachedList(env);
            const size = (n: string): number | null => listed?.dbs.find((d) => d.name === n)?.sizeMb ?? null;
            for (const t of c ? templatesOf(c) : []) out.push({ envId: env.id, envName: env.name, name: t, role: "template", taskId: null, ownerKind: "task", ownerName: null, sizeMb: size(t), createdAt: null });
            const names = (listed?.dbs ?? []).map((d) => d.name);
            for (const r of rows) {
                const owned = [...new Set([...ownedDbNames(r.name, names, rows.filter((o) => o.task_id !== r.task_id).map((o) => o.name)), ...(c ? copyNames(c, r.name).map(([n]) => n).filter((n) => names.includes(n)) : [])])];
                for (const n of owned) out.push({ envId: env.id, envName: env.name, name: n, role: "task", taskId: r.task_id, ownerKind: r.owner_kind ?? "task", ownerName: this.dbOwnerName(r), sizeMb: size(n), createdAt: r.created_at });
            }
            for (const d of listed?.dbs ?? []) if (!(c ? templatesOf(c) : []).includes(d.name) && !rows.some((r) => r.name === d.name || d.name.startsWith(`${r.name}_`) || (c ? copyNames(c, r.name).some(([n]) => n === d.name) : false))) out.push({ envId: env.id, envName: env.name, name: d.name, role: "orphan", taskId: null, ownerKind: "task", ownerName: null, sizeMb: d.sizeMb, createdAt: null });
        }
        return out;
    }

    review(taskId: string, input: ReviewInput): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        // A repository whose draft was never approved can be approved from any later PR stage (the task moved on when
        // another repository's PR was opened or fixed): its PR is opened right away, nothing else about the task changes.
        const lateDraftApproval =
            input.verdict === "approve" && input.repo !== undefined && task.status !== "running" && (task.stage === "pr_waiting" || task.stage === "pr_fix" || task.stage === "pr_green") && !this.prRow(taskId, input.repo)?.number;
        if (task.status !== "waiting_user" && !lateDraftApproval) throw new Error("task is not waiting for review");
        if (this.pendingQuestions(taskId)) throw new Error("the agent is waiting for answers to its questions — answer (or dismiss) them first");
        this.autopilotHuman(taskId);
        const comments = input.comments ?? [];
        const prior = this.db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND stage = ? AND verdict = 'changes'`).get(taskId, task.stage) as { n: number };
        this.db
            .prepare(`INSERT INTO reviews (id, task_id, stage, verdict, route_to, notes, comments, repo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), taskId, task.stage, input.verdict, input.routeTo ?? null, input.notes ?? null, comments.length ? JSON.stringify(comments) : null, input.repo ?? null, now());

        if (task.stage === "pr_creation_review" || lateDraftApproval) {
            this.reviewPrDraft(task, input, prior.n + 1);
            return;
        }
        if (input.verdict === "changes") {
            const target: Stage = task.stage === "design_proposal" || task.stage === "pr_fix" ? task.stage : (input.routeTo ?? "implementation");
            if (task.stage === "user_review") this.setSkipQa(taskId, input.skipQa === true);
            this.setStage(taskId, target);
            const files = input.files ?? [];
            const hasContent = !!input.notes?.trim() || comments.length > 0 || files.length > 0;
            this.dispatch(taskId, target, {
                notes: hasContent ? renderReviewNotes(prior.n + 1, input.notes, comments, target) + renderSharedFiles(files, this.taskDir(taskId)) : "The reviewer requested changes without notes; re-examine the work and improve it.",
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

    // Pushes the task branch after integrating the remote first (the user's rule: "it should pull --rebase first"):
    // fetch; when the remote has commits this checkout lacks, the local history was rewritten and the push is forced
    // with lease when either every remote commit is already here by content (a clean rebase onto a newer base, a
    // folded fix) or the remote still sits on the commit Stagehand itself pushed last (`lastPushed`: nobody else
    // pushed since, so the remote commits are the old shape of the local ones even when a conflict resolution or a
    // merge commit changed their content); otherwise they are genuinely new and are rebased under the local commits
    // with `git pull --rebase` (aborted and reported on conflict). A plain push otherwise. Returns a one-line note of
    // what happened. Seen on INV-130 (2026-09-18): the frontend checkout had been rebased onto newer dev, the remote
    // still held the 7 old commits, and the plain push was rejected as non-fast-forward. Seen on INV-133 (2026-09-23):
    // the backend fix rebased onto dev with a resolved conflict and a merge migration, so `git cherry` saw new content,
    // `pull --rebase` replayed 23 stale remote commits onto the rewritten branch and conflicted, and the task failed
    // although nothing but Stagehand's own old push was on the remote.
    private async pushBranch(cwd: string, env: EnvRow, branch: string, lastPushed: string | null = null): Promise<string> {
        await this.git(cwd, ["fetch", "origin", branch], env).catch(() => "");
        const remote = (await this.git(cwd, ["rev-parse", "-q", "--verify", `origin/${branch}`], env).catch(() => "")).trim();
        if (remote) {
            const remoteOnly = Number(await this.git(cwd, ["rev-list", "--count", `HEAD..origin/${branch}`], env).catch(() => "0")) || 0;
            if (remoteOnly > 0) {
                const unique = await this.remoteOnlyByContent(cwd, env, `origin/${branch}`);
                const ownOldPush = !!lastPushed && remote === lastPushed;
                if (unique === 0 || ownOldPush) {
                    await this.git(cwd, ["push", `--force-with-lease=${branch}:${remote}`, "-u", "origin", branch], env);
                    this.onBranchRewritten(env, branch);
                    return unique === 0
                        ? `force-pushed with lease — the ${remoteOnly} remote commit(s) were already here by content (history rewritten locally)`
                        : `force-pushed with lease — the ${remoteOnly} remote commit(s) were Stagehand's own last push (${remote.slice(0, 7)}), replaced by the rewritten local history`;
                }
                try {
                    await this.git(cwd, ["pull", "--rebase", "origin", branch], env);
                } catch (e) {
                    await this.git(cwd, ["rebase", "--abort"], env).catch(() => "");
                    throw new Error(`the remote has ${remoteOnly} commit(s) not here and rebasing onto them conflicted — pull and resolve by hand (${gitErrorTail(e)})`);
                }
                await this.git(cwd, ["push", "-u", "origin", branch], env);
                return `pulled ${remoteOnly} remote commit(s) with --rebase, then pushed`;
            }
        }
        await this.git(cwd, ["push", "-u", "origin", branch], env);
        return "pushed";
    }

    // How many commits of `remote` (not on HEAD) have no local counterpart by content. Like `git cherry`, but the
    // patch-ids come from diffs without context lines (-U0): a commit replayed next to a line the new base added still
    // adds and removes exactly the same lines, yet its default patch-id differs (INV-151, 2026-09-29: the rebase put
    // dev's new import beside the import the commit removes, `git cherry` called it new, and the push fell through to
    // a `pull --rebase` that conflicted). Any failure counts as "unknown", never as "all here".
    private async remoteOnlyByContent(cwd: string, env: EnvRow, remote: string): Promise<number> {
        const ids = async (range: string[]): Promise<{ ids: Set<string>; commits: number }> => {
            const log = await this.git(cwd, ["log", "-p", "-U0", "--no-merges", "--format=commit %H", ...range], env);
            const commits = (await this.git(cwd, ["rev-list", "--count", "--no-merges", ...range], env).then(Number)) || 0;
            const out = await new Promise<string>((resolve, reject) => {
                const p = spawn("git", ["-C", cwd, "patch-id", "--stable"], { env: { ...process.env, ...parseEnvVars(env.env_vars) } });
                let text = "";
                p.stdout.on("data", (d: Buffer) => (text += d.toString()));
                p.on("error", reject);
                p.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error(`git patch-id exited ${code}`))));
                p.stdin.end(`${log}\n`);
            });
            return { ids: new Set(out.split("\n").map((l) => l.split(" ")[0]).filter((x): x is string => !!x)), commits };
        };
        try {
            const theirs = await ids(["HEAD.." + remote]);
            const ours = await ids([remote + "..HEAD"]);
            // A remote commit with an empty diff gets no patch-id: it cannot be matched, so it counts as not here.
            // A merge commit on the remote carries its own resolution: never "here by content".
            const merges = (await this.git(cwd, ["rev-list", "--count", "--merges", "HEAD.." + remote], env).then(Number)) || 0;
            const unmatched = [...theirs.ids].filter((id) => !ours.ids.has(id)).length;
            return unmatched + merges + Math.max(0, theirs.commits - theirs.ids.size);
        } catch {
            return Number.MAX_SAFE_INTEGER;
        }
    }

    // The checkout's current commit, recorded as `pushed_sha` right after a push so a later push can tell Stagehand's
    // own old push from somebody else's commits.
    private async headSha(cwd: string, env: EnvRow): Promise<string | null> {
        return (await this.git(cwd, ["rev-parse", "HEAD"], env).catch(() => "")).trim() || null;
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
        const next = { number: null, url: null, checks_json: null, review_decision: null, merged_at: null, pushed_at: null, pushed_sha: null, approved_at: null, state: null, ...(cur ?? {}), ...patch };
        this.db
            .prepare(
                `INSERT INTO pr_state (task_id, repo, number, url, checks_json, review_decision, merged_at, pushed_at, pushed_sha, approved_at, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(task_id, repo) DO UPDATE SET number = excluded.number, url = excluded.url, checks_json = excluded.checks_json, review_decision = excluded.review_decision, merged_at = excluded.merged_at, pushed_at = excluded.pushed_at, pushed_sha = excluded.pushed_sha, approved_at = excluded.approved_at, state = excluded.state, updated_at = excluded.updated_at`,
            )
            .run(taskId, repo, next.number, next.url, next.checks_json, next.review_decision, next.merged_at, next.pushed_at, next.pushed_sha, next.approved_at, next.state, now());
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
        return { legacy: true, base: typeof old.base === "string" && old.base ? old.base : (task && env ? this.baseBranchOf(task, env) : "main"), drafts: repos.map((repo) => ({ repo, title: old.title as string, body: typeof old.body === "string" ? old.body : "" })) };
    }

    // Which repositories this task's PR review covers: the drafted ones, else every repository of the env.
    private draftRepos(taskId: string, env: EnvRow): string[] {
        const draft = this.readPrDraft(taskId);
        return draft?.drafts.length ? draft.drafts.map((d) => d.repo) : this.prRepos(env);
    }

    // The open PR whose head is `branch` in this repository — the parent of a stacked PR — or null.
    private async openPrForBranch(cwd: string, env: EnvRow, branch: string): Promise<{ number: number; url: string; title: string } | null> {
        const out = await this.gh(cwd, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,title", "--limit", "1"], env).catch(() => "[]");
        const list = JSON.parse(out || "[]") as Array<{ number: number; url: string; title: string }>;
        return list[0] ?? null;
    }

    // A draft whose base is not the env's trunk is a stacked PR. Record on each draft the parent branch's open PR
    // (so the reviewer sees "stacked on #n" and the body says so on creation), or a note when that branch has no PR
    // yet — the human then opens the parent's PR first or changes the base. Runs when the draft lands and whenever
    // the base is edited; PR creation re-checks live.
    private async annotateStackedDrafts(taskId: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) return;
        const env = this.env(task.env_id);
        const p = join(this.taskDir(taskId), "pr.json");
        if (!existsSync(p)) return;
        const draft = this.readPrDraft(taskId);
        if (!draft) return;
        const base = draft.base?.trim() || this.baseBranchOf(task, env);
        const drafts = [];
        for (const entry of draft.drafts) {
            // Each repository targets its own base: the draft's per-repo override, else the task's base for that repo.
            const entryBase = entry.base?.trim() || this.baseBranchOf(task, env, entry.repo);
            const stacked = entryBase !== env.base_branch;
            const cwd = this.checkoutOf(task, env, entry.repo);
            const parent = stacked && existsSync(cwd) ? await this.openPrForBranch(cwd, env, entryBase) : null;
            const stackNote = stacked && !parent ? `base branch \`${entryBase}\` has no open pull request yet — open the parent task's PR first (this one is stacked on it), or change the base to \`${env.base_branch}\`` : null;
            drafts.push({ ...entry, ...(entryBase !== base ? { base: entryBase } : {}), stackedOn: parent, stackNote });
        }
        writeFileSync(p, JSON.stringify({ base, drafts }, null, 2));
        this.emitTask(taskId);
    }

    // The line a stacked PR's body opens with, so GitHub readers know what to merge first and what the diff is against.
    private stackedBodyPrefix(parent: { number: number; title: string } | null, base: string, trunk: string): string {
        if (parent) return `> **Stacked on #${parent.number}** — ${parent.title}. Merge that first; this diff is relative to \`${base}\`.\n\n`;
        return base !== trunk ? `> Targets \`${base}\` (not \`${trunk}\`); this diff is relative to that branch.\n\n` : "";
    }

    // The human edits one repository's drafted PR (title / markdown body) or the shared base before approving it.
    setPrDraft(taskId: string, patch: { repo?: string | undefined; title?: string | undefined; body?: string | undefined; base?: string | undefined }): PrDraft {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — wait for it to finish");
        const env = this.env(task.env_id);
        const current = this.readPrDraft(taskId) ?? { base: this.baseBranchOf(task, env), drafts: [] };
        const repo = patch.repo ?? current.drafts[0]?.repo ?? "";
        if (this.prRow(taskId, repo)?.number) throw new Error(`the ${repoLabel(repo)} PR already exists on GitHub — edit it there`);
        const idx = current.drafts.findIndex((d) => d.repo === repo);
        const cur = idx >= 0 ? current.drafts[idx]! : { repo, title: "", body: "" };
        // In a multi-repo env an edited base belongs to the repository being edited; a single repo edits the shared base.
        const perRepo = this.prRepos(env).length > 1;
        const entry: PrDraft["drafts"][number] = { ...cur, repo, title: (patch.title ?? cur.title).trim(), body: patch.body ?? cur.body, ...(perRepo && patch.base !== undefined ? { base: patch.base.trim() || undefined } : {}) };
        if (!entry.title) throw new Error("the PR title cannot be empty");
        const drafts = idx >= 0 ? current.drafts.map((d, i) => (i === idx ? entry : d)) : [...current.drafts, entry];
        const sharedBase = perRepo ? current.base : patch.base ?? current.base;
        const next: PrDraft = { base: (sharedBase ?? this.baseBranchOf(task, env)).trim() || this.baseBranchOf(task, env), drafts };
        writeFileSync(join(this.taskDir(taskId), "pr.json"), JSON.stringify(next, null, 2));
        // An edited draft is no longer the approved one (only matters while its PR does not exist yet).
        if (patch.title !== undefined || patch.body !== undefined) this.db.prepare(`UPDATE pr_state SET approved_at = NULL, updated_at = ? WHERE task_id = ? AND repo = ? AND number IS NULL`).run(now(), taskId, repo);
        this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
        this.emitTask(taskId);
        // A changed base may now point at a branch with (or without) an open PR: refresh the stacked-PR annotation.
        if (patch.base !== undefined) void this.annotateStackedDrafts(taskId);
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
            const notes = (input.notes?.trim() ? renderReviewNotes(round, input.notes, [], "pr_creation_review") : "The reviewer requested changes without notes; re-examine the draft and improve it.") + renderSharedFiles(input.files ?? [], this.taskDir(task.id));
            this.dispatch(task.id, "pr_creation_review", { notes: `${notes}${scope}` });
            return;
        }
        if (repo === undefined) throw new Error("say which repository's draft you approve");
        if (!repos.includes(repo)) throw new Error(`no draft for repository ${repo || "(root)"}`);
        void this.approvePrRepo(task.id, repo).catch((e: unknown) => console.warn(`[stagehand] approve PR ${task.ticket_id} ${repo}: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }

    // A task that comes back to PR Creation Review after its PR(s) already exist (returned from a later stage, a
    // re-run, a "changes" verdict) has nothing left to draft or approve — the open PR simply takes the branch's new
    // commits. Every entry path funnels through dispatch(), which asks this first: when every repository the review
    // covers already has a PR, mark them approved and go straight to PR Waiting. A partially-opened multi-repo task
    // still gets the drafting run for the repositories that have no PR yet.
    private skipPrCreationIfDone(taskId: string): boolean {
        const task = this.getTask(taskId);
        if (!task) return false;
        const env = this.env(task.env_id);
        const rows = this.prRows(taskId);
        const repos = this.draftRepos(taskId, env);
        const opened = repos.filter((r) => rows.find((x) => x.repo === r)?.number);
        for (const r of opened) if (!rows.find((x) => x.repo === r)?.approved_at) this.upsertPrRow(taskId, r, { approved_at: now() });
        if (opened.length < repos.length) return false;
        // The PRs are open from an earlier round (the task went back to an earlier stage): the approved commits still
        // have to reach them (INV-154, 2026-10-02: approved at User Review, both repositories stayed ahead of their PRs).
        void this.pushPrFix(taskId, { approved: true }).catch((e: unknown) => console.warn(`[stagehand] push approved ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`));
        return true;
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
        // createPrForRepo leaves the task "running · pushing …"; finish the same way an approve does — on to PR Waiting
        // once every repository has its PR, otherwise back to waiting for the human on the ones that still have none.
        const env = this.env(task.env_id);
        const repos = this.draftRepos(taskId, env);
        const rows = this.prRows(taskId);
        const missing = repos.filter((r) => !rows.find((x) => x.repo === r)?.number);
        if (missing.length) {
            this.setStage(taskId, "pr_creation_review");
            this.setTaskStatus(taskId, "waiting_user", `PR Creation Review · ${out.join("; ")} — still without a PR: ${missing.map((r) => repoLabel(r)).join(", ")}`);
            return out;
        }
        this.setStage(taskId, "pr_waiting");
        this.syncPrTaskState(taskId, { force: true });
        this.pollPrSoon(taskId);
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
        const repoBase = this.baseBranchOf(task, env, repo);
        const ahead = await this.git(cwd, ["log", "--oneline", `origin/${repoBase}..HEAD`], env).catch(() => "");
        const dirty = await this.git(cwd, ["status", "--porcelain"], env).catch(() => "");
        // Nothing committed but changes on disk: an env that forbids agent commits (or an agent that left work
        // uncommitted) — the human has to commit before anything can be pushed or opened.
        if (!ahead && dirty.trim()) return `${dirty.trim().split("\n").length} changed file(s) are not committed — commit and push \`${task.branch}\` yourself, then open the PR (draft below)`;
        if (!ahead) return `nothing to ship: no commits ahead of ${repoBase}`;
        if (!rules.allowPush) {
            return existing?.number
                ? `push \`${task.branch}\` yourself — PR #${existing.number} picks the commits up`
                : `this env forbids agent pushes — push \`${task.branch}\` and open the PR yourself (draft below); Stagehand picks it up by branch`;
        }
        this.setTaskStatus(taskId, "running", `PR Creation Review · pushing ${repoLabel(repo)} (${task.branch})`);
        let pushed: string | null = null;
        try {
            const how = await this.pushBranch(cwd, env, task.branch, existing?.pushed_sha ?? null);
            pushed = await this.headSha(cwd, env);
            if (how !== "pushed") this.addAgentNote(taskId, `${repoLabel(repo)}: ${how}`);
        } catch (e) {
            this.setTaskStatus(taskId, "failed", `${repoLabel(repo)}: push failed — ${gitErrorTail(e)} · fix the checkout (or force-push from Code changes), then approve the draft again`);
            return null;
        }
        // A task sent back after its PR existed just needs the push; the open PR picks the new commits up.
        if (existing?.number) {
            this.resetPrState(taskId, repo, pushed);
            return `pushed to PR #${existing.number}`;
        }
        if (!rules.allowPrCreate || !entry) {
            this.upsertPrRow(taskId, repo, { pushed_at: now(), pushed_sha: pushed });
            return `pushed \`${task.branch}\` — this env forbids agent PR creation: open the PR yourself (draft below); Stagehand picks it up by branch`;
        }
        try {
            // A PR against a non-trunk base is stacked: say what it sits on (checked live — the parent PR may have been
            // opened after the draft landed) so reviewers merge the parent first and read the diff against the right branch.
            const prBase = entry.base?.trim() || this.baseBranchOf(task, env, repo);
            const parent = prBase !== env.base_branch ? await this.openPrForBranch(cwd, env, prBase) : null;
            const body = this.stackedBodyPrefix(parent, prBase, env.base_branch) + entry.body;
            const url = await this.gh(cwd, ["pr", "create", "--base", prBase, "--head", task.branch, "--title", entry.title, "--body", body, ...(rulesOf(this.configDirOf(env)).prDraft ? ["--draft"] : [])], env);
            const number = Number(url.split("/").pop());
            this.upsertPrRow(taskId, repo, { number: Number.isFinite(number) ? number : null, url, pushed_at: now(), pushed_sha: pushed, state: "OPEN" });
            return `PR #${Number.isFinite(number) ? number : "?"} created`;
        } catch (e) {
            this.setTaskStatus(taskId, "failed", `${repoLabel(repo)}: gh pr create failed — ${gitErrorTail(e)}`);
            return null;
        }
    }

    // A push changed the PR's head: what was known about checks and review verdicts describes the old commit. Drop it and
    // remember when the push happened, so the next poll starts from "nothing reported yet" instead of stale green/red.
    private resetPrState(taskId: string, repo: string, pushedSha: string | null = null): void {
        this.upsertPrRow(taskId, repo, { checks_json: null, review_decision: null, pushed_at: now(), ...(pushedSha ? { pushed_sha: pushedSha } : {}) });
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
            const note = await this.syncRemoteBranch(task, env, repo).catch((e: unknown) => {
                console.warn(`[stagehand] pull ${task.ticket_id} ${repo || "(root)"}: ${String((e as Error).message ?? e).slice(0, 160)}`);
                return null;
            });
            if (note) this.addAgentNote(task.id, `${repoLabel(repo)}: ${note}`);
            await this.pollPr(task, repo).catch((e: unknown) => console.warn(`[stagehand] PR poll ${task.ticket_id} ${repo || "(root)"}: ${String((e as Error).message ?? e).slice(0, 160)}`));
        }
        this.syncPrTaskState(task.id, opts);
    }

    // The last remote SHA of each (task, repository) branch we've already pulled or flagged, so a poll that finds
    // nothing new stays silent — only a change from what was last seen is worth a note.
    private readonly ackedRemoteSha = new Map<string, string>();

    // When someone pushes straight to the PR's branch on GitHub (a reviewer's suggested-change commit, the human
    // pushing a fix themselves, a collaborator) the worktree checkout falls behind what the PR actually contains.
    // Pull it in automatically so Code changes, PR Fix and the next merge all see the real head, and leave a chat
    // note acknowledging what arrived. Never overwrites local work: skipped while the task is running, while the
    // worktree has uncommitted changes (tried again next poll), or when local and remote have genuinely diverged
    // (unpushed local commits alongside new remote ones) — that case is only flagged, never force-resolved.
    private async syncRemoteBranch(task: TaskRow, env: EnvRow, repo: string): Promise<string | null> {
        if (!task.branch || !task.worktree_path) return null;
        if (this.getTask(task.id)?.status === "running") return null;
        const cwd = this.checkoutOf(task, env, repo);
        if (!existsSync(cwd)) return null;
        const key = `${task.id}:${repo}`;
        await this.git(cwd, ["fetch", "origin", task.branch], env).catch(() => "");
        const remoteRef = `origin/${task.branch}`;
        const remoteSha = await this.git(cwd, ["rev-parse", "-q", "--verify", remoteRef], env).catch(() => "");
        if (!remoteSha || this.ackedRemoteSha.get(key) === remoteSha) return null;
        const behind = Number(await this.git(cwd, ["rev-list", "--count", `HEAD..${remoteRef}`], env).catch(() => "0")) || 0;
        if (behind === 0) {
            this.ackedRemoteSha.set(key, remoteSha);
            return null;
        }
        const ahead = Number(await this.git(cwd, ["rev-list", "--count", `${remoteRef}..HEAD`], env).catch(() => "0")) || 0;
        const dirty = await this.git(cwd, ["status", "--porcelain"], env).catch(() => "");
        if (ahead > 0) {
            // Local commits the remote does not have by SHA may still be there by content: the branch was rebased on
            // GitHub (a stacked PR whose parent merged, "Update branch" with rebase, a rebase pushed from elsewhere).
            // `git cherry` marks a local commit `+` only when no upstream commit has the same patch — none of those
            // means every local commit is already in the rewritten remote, and the remote can be adopted outright.
            const cherry = (await this.git(cwd, ["cherry", remoteRef, "HEAD"], env).catch(() => "+ unknown")).split("\n").filter(Boolean);
            const unique = cherry.filter((l) => l.startsWith("+")).length;
            if (unique > 0) {
                this.ackedRemoteSha.set(key, remoteSha);
                return `diverged from GitHub — ${behind} commit(s) pushed there, ${unique} committed here that aren't there; resolve by hand (push, or pull and rebase)`;
            }
            if (dirty.trim()) return null; // uncommitted work on top of the old history — try again once it clears
            await this.git(cwd, ["reset", "--hard", remoteRef], env);
            this.ackedRemoteSha.set(key, remoteSha);
            return `adopted the rebased branch from GitHub (${ahead} local commit(s) were rewritten there with the same content; now at ${remoteSha.slice(0, 7)})`;
        }
        if (dirty.trim()) return null; // uncommitted work in the way — try again once it clears, don't acknowledge yet
        const subjects = (await this.git(cwd, ["log", "--format=%h %s", `HEAD..${remoteRef}`], env).catch(() => "")).split("\n").filter(Boolean);
        await this.git(cwd, ["merge", "--ff-only", remoteRef], env);
        this.ackedRemoteSha.set(key, remoteSha);
        return `pulled ${behind} commit(s) pushed on GitHub — ${subjects.slice(0, 5).join("; ")}${subjects.length > 5 ? "; …" : ""}`;
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
        const pr = JSON.parse(await this.gh(cwd, ["pr", "view", String(number), "--json", "url,state,mergedAt,reviewDecision,statusCheckRollup,baseRefName"], env)) as {
            url: string;
            state: string;
            mergedAt: string | null;
            reviewDecision: string;
            baseRefName?: string;
            statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string; status?: string; startedAt?: string; completedAt?: string; detailsUrl?: string; targetUrl?: string; workflowName?: string }>;
        };
        // A stacked PR's base is retargeted by GitHub once its parent PR merges (e.g. feature-a → dev). Follow it: the
        // task's diffs, ahead-counts and the next PR fix then compare against the branch the PR really targets.
        const knownBase = this.baseBranchOf(task, env, repo);
        if (pr.state === "OPEN" && pr.baseRefName && pr.baseRefName !== knownBase) {
            const bases = { ...this.baseBranchesOf(task, env), [repo]: pr.baseRefName };
            this.db.prepare(`UPDATE tasks SET base_branch = ?, updated_at = ? WHERE id = ?`).run(normalizeBaseBranch(bases, this.prRepos(env), env.base_branch), now(), task.id);
            this.addAgentNote(task.id, `${repoLabel(repo)}: GitHub moved PR #${number}'s base from \`${knownBase}\` to \`${pr.baseRefName}\` (the branch it was stacked on was merged) — the task now compares against \`${pr.baseRefName}\`; rebasing the branch onto it so the PR stops carrying the merged parent's commits`);
            // The branch still carries the merged parent's commits (by content already on the new base, or as a squash):
            // rebase onto the new base now — plain first, agent on conflict — and force-push, before anything else pushes
            // this branch (INV-131, 2026-09-20: a pr_fix push after the retarget replayed the stale history onto the remote).
            this.queueRebase(task.id, `GitHub moved PR #${number}'s base to \`${pr.baseRefName}\` after the parent branch merged`, [repo]);
            this.processPendingRebases();
        }
        this.upsertPrRow(task.id, repo, { url: pr.url, checks_json: JSON.stringify(pr.statusCheckRollup ?? []), review_decision: pr.reviewDecision ?? null, merged_at: pr.mergedAt ?? null, state: pr.state ?? null });
        return true;
    }

    // One repository's PR in a word, from its stored row.
    private prRepoSummary(row: PrStateRow | undefined): { kind: "none" | "manual" | "pending" | "failed" | "green" | "approved" | "merged" | "closed"; text: string; pending: number } {
        return { pending: 0, ...this.prRepoSummaryOf(row) };
    }
    private prRepoSummaryOf(row: PrStateRow | undefined): { kind: "none" | "manual" | "pending" | "failed" | "green" | "approved" | "merged" | "closed"; text: string; pending?: number } {
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
        if (failed.length) return { kind: "failed", pending: pending.length, text: `${n} ${failed.length} check(s) failing (${failed.map((c) => c.name ?? c.context ?? "check").join(", ")})${pending.length ? `, ${pending.length} running` : ""}` };
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
        if (!["pr_waiting", "pr_green", "pr_approved", "pr_fix"].includes(cur.stage)) return;
        if (!opts.force && cur.stage !== "pr_fix" && cur.status !== "idle" && cur.status !== "blocked") {
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
        // PR Fix is left alone — except when every PR merged meanwhile (on GitHub, by hand) and no run is going: the
        // round waiting for review is moot then, and the task is done (INV-136, 2026-09-28: both PRs merged while the
        // task sat in PR Fix · needs you, and no refresh ever finished it).
        if (cur.stage === "pr_fix" && (cur.status === "running" || !all("merged"))) {
            this.emitTask(taskId);
            return;
        }
        // A repository whose PR merged releases the children stacked on it in that repository right away — the other
        // repositories' PRs may stay open for days (INV-132, 2026-09-21: backend merged, frontend still in review).
        for (const s of summaries) if (s.kind === "merged") this.onParentRepoMerged(cur, env, s.repo);
        // The poll runs every two minutes and the line moves with every check that finishes. The human hears only the
        // two transitions that matter: a check failed (blocked — once, not again while the failing set changes) and
        // every check passed (green — once). Intermediate states are recorded, not pushed (2026-09-25: a push per poll
        // for a PR waiting on checks).
        const set = (stage: Stage, status: TaskStatus, text: string): void => {
            if (cur.stage !== stage) this.setStage(taskId, stage);
            if (cur.status === status && cur.status_line === text) {
                this.emitTask(taskId);
                return;
            }
            this.setTaskStatus(taskId, status, text, { notify: status === "blocked" && cur.status !== "blocked" });
            if ((stage === "pr_green" || stage === "pr_approved") && cur.stage === "pr_waiting") this.notifyChecksPassed(cur, text);
        };
        if (all("merged")) {
            if (cur.stage !== "done") {
                this.onParentMerged(cur, env);
                // Nothing needs the task's BE/FE (or components) once its PRs are merged — also the end of "keep services".
                void this.services.stopAll(cur.id).catch((e: unknown) => console.warn(`[stagehand] stop services of merged ${cur.ticket_id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
                // Nor its per-task databases and caches: run the env's cleanup command now instead of waiting for "Clean up"
                // (DualEntry, 2026-09-22: 20 test-database clones of done and parked tasks sat on the shared Postgres).
                // The worktree stays for the human; the command runs again, harmlessly, when they clean up or delete.
                void this.runCleanupCommand(cur, env, parseEnvVars(env.env_vars)).then((error) => {
                    if (error) this.addAgentNote(cur.id, `cleanup command failed after merge: ${error}`);
                });
            }
            return set("done", "done", `merged · ${rows.map((r) => r.url).filter(Boolean).join(" ")}`);
        }
        if (kinds.has("failed")) {
            if (cur.stage !== "pr_fix" && this.autopilotGate(cur, env, summaries)) {
                if (cur.stage !== "pr_waiting") this.setStage(taskId, "pr_waiting");
                return;
            }
            return set("pr_waiting", "blocked", `PR Waiting · ${line} — click Fix CI on the failing PR, or fix it yourself`);
        }
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
        this.autopilotHuman(taskId);
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        const names = failed.map((c) => c.name ?? c.context ?? "check").join(", ");
        await this.recordFixComments(task, []);
        this.setStage(taskId, "pr_fix");
        this.startPrRound(taskId, { [repo]: `${repoScopeNote(repo)}Failing checks on PR #${row.number}: ${names}. Read their logs with \`gh pr checks ${row.number}\` and \`gh run view --log-failed <run-id>\` (run inside that repository) before changing anything.` }, { attempt: rounds.n + 1, operation: "pr_fix_ci" });
    }

    // ---------- CI autopilot (ci-autopilot.ts, docs/ci-autopilot.md) ----------

    // Tasks whose autopilot step is in flight (a triage, a fix review, a push) — headless work outside the stage machinery.
    private readonly autopilotRuns = new Set<string>();
    private async autopilotStep(taskId: string, fn: () => Promise<void>): Promise<void> {
        this.autopilotRuns.add(taskId);
        try {
            await fn();
        } finally {
            this.autopilotRuns.delete(taskId);
            this.emitTask(taskId);
        }
    }

    autopilotOn(task: TaskRow): boolean {
        if (task.ci_autopilot === 0) return false;
        if (task.ci_autopilot === 1) return true;
        return (this.env(task.env_id).ci_autopilot ?? 1) !== 0;
    }
    setAutopilot(taskId: string, on: boolean | null): void {
        this.db.prepare(`UPDATE tasks SET ci_autopilot = ?, updated_at = ? WHERE id = ?`).run(on === null ? null : on ? 1 : 0, now(), taskId);
        this.autopilotHuman(taskId);
        this.emitTask(taskId);
    }
    autopilotState(taskId: string): AutopilotState & { on: boolean; busy: boolean } {
        const task = this.getTask(taskId);
        return { ...readAutopilot(this.taskDir(taskId)), on: task ? this.autopilotOn(task) : false, busy: this.autopilotRuns.has(taskId) };
    }
    // The human acted on the task: the autopilot's run count starts again, and a stop is lifted.
    private autopilotHuman(taskId: string): void {
        const dir = this.taskDir(taskId);
        if (!existsSync(join(dir, "ci-autopilot.json"))) return;
        const s = readAutopilot(dir);
        const r = activeRound(s);
        if (r && !this.autopilotRuns.has(taskId)) {
            r.phase = "stopped";
            r.error = "the human took over";
            r.endedAt = now();
        }
        writeAutopilot(dir, { ...s, consecutive: 0, stopped: null });
    }
    private autopilotSave(taskId: string, fn: (s: AutopilotState) => void): AutopilotState {
        const dir = this.taskDir(taskId);
        const s = readAutopilot(dir);
        fn(s);
        writeAutopilot(dir, s);
        this.emitTask(taskId);
        return s;
    }
    // A restart ends every triage and fix review: their rounds are dropped (triage) or failed, and the next poll looks again.
    private recoverAutopilot(): void {
        for (const t of this.db.prepare(`SELECT id FROM tasks WHERE stage IN ('pr_waiting', 'pr_fix', 'pr_green')`).all() as Array<{ id: string }>) {
            const dir = this.taskDir(t.id);
            if (!existsSync(join(dir, "ci-autopilot.json"))) continue;
            const s = readAutopilot(dir);
            const before = s.rounds.length;
            s.rounds = s.rounds.filter((r) => r.phase !== "triage");
            for (const r of s.rounds) if (r.phase === "reviewing") { r.phase = "failed"; r.error = "the fix review was interrupted by a restart — Retry"; r.endedAt = now(); }
            if (before !== s.rounds.length || s.rounds.some((r) => r.error?.includes("restart"))) writeAutopilot(dir, s);
        }
    }

    // From syncPrTaskState, for a task whose PRs have a red check: true when the autopilot holds the task (waiting for the
    // run to finish, triaging, fixing) — the caller then does not mark it blocked.
    private autopilotGate(task: TaskRow, env: EnvRow, summaries: Array<{ repo: string; kind: string; pending: number; text: string }>): boolean {
        if (!this.autopilotOn(task) || task.status === "running") return false;
        // The autopilot ends in a push: an env that forbids agent pushes leaves CI to the human.
        if (!rulesOf(this.configDirOf(env)).allowPush) return false;
        const dir = this.taskDir(task.id);
        const s = readAutopilot(dir);
        if (this.autopilotRuns.has(task.id)) return true;
        const stale = activeRound(s);
        if (stale) {
            // Its PR Fix round was stopped or failed and the task moved on: the round is over.
            stale.phase = "stopped";
            stale.error = "its fix round ended without the autopilot";
            stale.endedAt = now();
            writeAutopilot(dir, s);
        }
        const red = summaries.filter((x) => x.kind === "failed");
        // Not partially red: a PR with checks still running waits for them.
        if (red.some((x) => x.pending > 0)) {
            const line = `PR Waiting · ${summaries.map((x) => x.text).join(" · ")} — CI autopilot waits for the run to finish`;
            if (task.status !== "idle" || task.status_line !== line) this.setTaskStatus(task.id, "idle", line);
            return true;
        }
        if (s.stopped) return false;
        if (s.consecutive >= MAX_AUTOPILOT_ROUNDS) {
            this.autopilotSave(task.id, (x) => { x.stopped = `${MAX_AUTOPILOT_ROUNDS} autopilot rounds in a row — the next red run is yours`; });
            this.addAgentNote(task.id, `CI autopilot paused: ${MAX_AUTOPILOT_ROUNDS} rounds in a row. Fix CI yourself, or act on the task to let it run again.`);
            return false;
        }
        for (const x of red) {
            const row = this.prRow(task.id, x.repo);
            if (!row?.number) continue;
            const cwd = this.checkoutOf(task, env, x.repo);
            let head = "";
            try {
                head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
            } catch {
                continue;
            }
            // Once per head commit: a run the autopilot already looked at is the human's.
            if (s.rounds.some((r) => r.repo === x.repo && r.headSha === head)) continue;
            void this.autopilotStep(task.id, () => this.autopilotTriage(task.id, x.repo, row.number!, head)).catch((e: unknown) => console.warn(`[autopilot] ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`));
            // One repository at a time; the next poll takes the next one.
            return true;
        }
        return false;
    }

    private autopilotAccount(task: TaskRow, env: EnvRow): { acc: AccountRow; cd: ConfigDirRow } {
        const cd = this.configDirOf(env);
        const usable = this.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === accountOrderOf(env)[0]) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        return { acc, cd };
    }

    // A fresh read-only session that reads the failed logs and the branch diff, and writes ci-triage.json.
    private async autopilotTriage(taskId: string, repo: string, prNumber: number, headSha: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task?.branch) return;
        const env = this.env(task.env_id);
        const cwd = this.checkoutOf(task, env, repo);
        const row = this.prRow(taskId, repo);
        let checks: Array<{ name?: string; context?: string; conclusion?: string; state?: string }> = [];
        try {
            checks = row?.checks_json ? JSON.parse(row.checks_json) : [];
        } catch {
            checks = [];
        }
        const failed = checks.filter((c) => !isApprovalGateCheck(c) && isFailedCheck(c)).map((c) => c.name ?? c.context ?? "check");
        if (!failed.length) return;
        const round: AutopilotRound = { id: randomUUID(), repo, prNumber, headSha, at: now(), phase: "triage" };
        this.autopilotSave(taskId, (s) => { s.rounds.push(round); });
        this.setTaskStatus(taskId, "idle", `PR Waiting · #${prNumber} ${failed.length} check(s) failed — CI autopilot is triaging`);
        const dir = this.taskDir(taskId);
        const out = join(dir, `ci-triage-${round.id.slice(0, 8)}.json`);
        const fail = (error: string): void => {
            this.autopilotSave(taskId, (s) => { const r = s.rounds.find((x) => x.id === round.id); if (r) { r.phase = "failed"; r.error = error; r.endedAt = now(); } });
            this.setTaskStatus(taskId, "blocked", `PR Waiting · #${prNumber} ${failed.length} check(s) failing — CI autopilot could not triage (${error.slice(0, 120)}); click Fix CI, or fix it yourself`, { notify: true });
        };
        let acc: AccountRow;
        let cd: ConfigDirRow;
        try {
            ({ acc, cd } = this.autopilotAccount(task, env));
        } catch (e) {
            fail(String((e as Error).message ?? e));
            return;
        }
        const prompt = renderPrompt("ci-triage.md", {
            ticketId: task.ticket_id, prNumber: String(prNumber), cwd, branch: task.branch, baseBranch: this.baseBranchOf(task, env, repo), headSha, failedChecks: failed.map((f) => `\`${f}\``).join(", "), outputFile: out, rules: describeRules(autopilotRulesOf(env.ci_autopilot_rules)),
        });
        const rulesMat = materializeRules(rulesOf(cd), env, task.worktree_path ?? cwd, this.cfg.dataDir);
        const model = this.modelForOperation(task, "pr_fix_ci", acc);
        const run = startClaude({
            prompt, cwd, configDir: cd.path, extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId), ...authEnv(acc) }, settingsPath: rulesMat.settingsPath, appendSystemPrompt: rulesMat.systemPrompt,
            sessionId: randomUUID(), maxTurns: 60, addDirs: [dir], eventLogPath: join(dir, `ci-triage-${round.id.slice(0, 8)}.ndjson`), ...(model ? { model } : {}),
        });
        const outcome = await run.done;
        if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "pr_fix", stage: "pr_fix" }, outcome.result);
        if (!existsSync(out)) return fail(`no ${out.split("/").pop()} written (${outcome.stderr.trim().split("\n").pop()?.slice(0, 120) || `exit ${outcome.exitCode}`})`);
        let triage: TriageResult;
        try {
            triage = TriageResult.parse(JSON.parse(readFileSync(out, "utf8")));
        } catch (e) {
            return fail(`the triage does not match its shape: ${String((e as Error).message ?? e).slice(0, 160)}`);
        }
        const current = this.getTask(taskId);
        // Meanwhile the human (or a push) moved the task on: the triage is kept, nothing is fixed.
        if (!current || current.status === "running" || !["pr_waiting", "pr_green"].includes(current.stage) || (await this.headSha(cwd, env)) !== headSha) {
            this.autopilotSave(taskId, (s) => { const r = s.rounds.find((x) => x.id === round.id); if (r) { r.triage = triage; r.phase = "stopped"; r.error = "the task moved on during the triage"; r.endedAt = now(); } });
            return;
        }
        const verified = await this.autopilotVerify(current, env, repo, cwd, triage);
        const ok = verified.filter((v) => v.allowed);
        const prev = readAutopilot(dir).rounds.filter((r) => r.id !== round.id && r.phase === "pushed").pop();
        const again = prev ? ok.filter((v) => prev.verified?.some((p) => p.allowed && failureKey(p) === failureKey(v))) : [];
        if (again.length) {
            this.autopilotSave(taskId, (s) => {
                const r = s.rounds.find((x) => x.id === round.id)!;
                Object.assign(r, { triage, verified, phase: "stopped", error: `the same failure came back after the last autopilot fix: ${again.map((v) => v.what || v.check).join("; ")}`, endedAt: now() });
                s.stopped = r.error!;
            });
            this.setTaskStatus(taskId, "blocked", `PR Waiting · #${prNumber} — CI autopilot stopped: the failure it fixed came back · click Fix CI, or fix it yourself`, { notify: true });
            return;
        }
        if (!ok.length) {
            this.autopilotSave(taskId, (s) => { Object.assign(s.rounds.find((x) => x.id === round.id)!, { triage, verified, phase: "denied", endedAt: now() }); });
            const no = verified.map((v) => `${v.check}: ${v.why}`).join("; ");
            this.addAgentNote(taskId, `CI autopilot — PR #${prNumber}: nothing on its list, left for you.\n\n${verified.map((v) => `- **${v.check}** (${v.kind.replace(/_/g, " ")}) ${v.what} — ${v.why}`).join("\n")}`);
            this.setTaskStatus(taskId, "blocked", `PR Waiting · #${prNumber} ${verified.length} failure(s) outside the CI autopilot's list (${no.slice(0, 140)}) — click Fix CI, or fix it yourself`, { notify: true });
            return;
        }
        const fixFrom: Record<string, string> = {};
        for (const r of this.prRepos(env)) {
            const p = this.checkoutOf(current, env, r);
            if (existsSync(p)) fixFrom[r] = (await this.headSha(p, env)) ?? "";
        }
        this.autopilotSave(taskId, (s) => {
            Object.assign(s.rounds.find((x) => x.id === round.id)!, { triage, verified, fixFrom, phase: "fixing" });
            s.consecutive += 1;
        });
        this.addAgentNote(taskId, `CI autopilot — PR #${prNumber}: fixing ${ok.length} failure(s) this branch caused${verified.length > ok.length ? `; ${verified.length - ok.length} left for you` : ""}.\n\n${verified.map((v) => `- ${v.allowed ? "fix" : "yours"} · **${v.check}** (${v.kind.replace(/_/g, " ")}) ${v.what} — ${v.why}`).join("\n")}`);
        await this.recordFixComments(current, []);
        this.setStage(taskId, "pr_fix");
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        this.startPrRound(taskId, { [repo]: `${repoScopeNote(repo)}${fixBrief(prNumber, verified, autopilotRulesOf(env.ci_autopilot_rules))}` }, { attempt: rounds.n + 1, operation: "pr_fix_ci" });
    }

    // Every "allow" of the triage, checked against the branch diff and the base (ci-autopilot.ts verifyFailure).
    private async autopilotVerify(task: TaskRow, env: EnvRow, repo: string, cwd: string, triage: TriageResult): Promise<VerifiedFailure[]> {
        const baseBranch = this.baseBranchOf(task, env, repo);
        const base = await this.git(cwd, ["merge-base", "HEAD", `origin/${baseBranch}`], env).catch(() => this.git(cwd, ["merge-base", "HEAD", baseBranch], env));
        const changed = changedRanges(await this.git(cwd, ["diff", "-U0", "-M", "--no-color", `${base}..HEAD`], env));
        const added = addedFiles(await this.git(cwd, ["diff", "--name-status", "-M", `${base}..HEAD`], env));
        const tracked = new Set((await this.git(cwd, ["ls-files"], env)).split("\n"));
        let baseRuns: Array<{ name: string; conclusion: string | null }> | null = null;
        const ctx: VerifyCtx = {
            changed,
            added,
            known: (p) => tracked.has(p),
            headFile: (p) => {
                try {
                    return readFileSync(join(cwd, p), "utf8");
                } catch {
                    return null;
                }
            },
            baseHasFile: (p) => this.git(cwd, ["cat-file", "-e", `${base}:${p}`], env).then(() => true, () => false),
            baseCheck: async (check) => {
                if (!baseRuns) {
                    try {
                        const repoName = await this.gh(cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], env);
                        const raw = await this.gh(cwd, ["api", `repos/${repoName}/commits/${base}/check-runs?per_page=100`, "-q", ".check_runs | map({name, conclusion})"], env);
                        baseRuns = JSON.parse(raw || "[]") as Array<{ name: string; conclusion: string | null }>;
                    } catch {
                        baseRuns = [];
                    }
                }
                const runs = baseRuns.filter((r) => r.name === check);
                if (!runs.length) return "none";
                return runs.some((r) => r.conclusion === "success") ? "success" : "failure";
            },
            localBase: (tests) => this.autopilotBaseRun(task, env, repo, cwd, base, tests),
        };
        const out: VerifiedFailure[] = [];
        const rules = autopilotRulesOf(env.ci_autopilot_rules);
        for (const f of triage.failures) out.push(await verifyFailure(f, ctx, rules));
        return out;
    }

    // The named tests on a checkout of the base (a detached worktree, removed after): the env's test command with {{tests}}.
    private async autopilotBaseRun(task: TaskRow, env: EnvRow, repo: string, cwd: string, base: string, tests: string[]): Promise<"pass" | "fail" | null> {
        if (!env.test_command?.trim()) return null;
        const tmp = join(this.cfg.dataDir, "tmp", `base-${task.id.slice(0, 8)}-${Date.now()}`);
        mkdirSync(join(this.cfg.dataDir, "tmp"), { recursive: true });
        const vars = parseEnvVars(env.env_vars);
        try {
            await this.git(cwd, ["worktree", "add", "--detach", tmp, base], env);
            if (!repo && env.setup_command) await runWorktreeSetup(tmp, env.path, withPrepare(env, env.setup_command), vars).catch(() => "");
            // {{envPath}}: the env's main checkout — the base checkout is a bare worktree, so a command reaches its
            // ignored files (an env file, a virtualenv) there.
            const command = env.test_command.replace(/\{\{envPath\}\}/g, env.path).replace(/\{\{tests\}\}/g, tests.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(" "));
            const ok = await execFileAsync("bash", loginShellArgs(withPrepare(env, command)), { cwd: tmp, env: loginShellEnv(vars), timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 }).then(() => true, () => false);
            return ok ? "pass" : "fail";
        } catch (e) {
            console.warn(`[autopilot] base run ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`);
            return null;
        } finally {
            await this.git(cwd, ["worktree", "remove", "--force", tmp], env).catch(() => rmSync(tmp, { recursive: true, force: true }));
        }
    }

    // After a PR Fix round the autopilot started: the fix is reviewed (fresh session, read-only); serious findings go back
    // to the fixer once; then the push. Returns false when the round is not the autopilot's.
    private autopilotAfterFix(taskId: string): boolean {
        const s = readAutopilot(this.taskDir(taskId));
        const r = activeRound(s);
        if (!r || !["fixing", "reviewing", "addressing"].includes(r.phase)) return false;
        if (r.phase === "addressing") {
            void this.autopilotStep(taskId, () => this.autopilotPush(taskId, r.id));
            return true;
        }
        void this.autopilotStep(taskId, () => this.autopilotReview(taskId, r.id)).catch((e: unknown) => {
            this.autopilotSave(taskId, (x) => { const rr = x.rounds.find((y) => y.id === r.id); if (rr) { rr.phase = "failed"; rr.error = String((e as Error).message ?? e).slice(0, 300); rr.endedAt = now(); } });
            this.setTaskStatus(taskId, "waiting_user", `PR Fix · CI autopilot could not review its fix (${String((e as Error).message ?? e).slice(0, 120)}) — review the diff yourself`, { notify: true });
        });
        return true;
    }

    private async autopilotReview(taskId: string, roundId: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) return;
        const env = this.env(task.env_id);
        const dir = this.taskDir(taskId);
        const round = readAutopilot(dir).rounds.find((x) => x.id === roundId)!;
        this.autopilotSave(taskId, (s) => { s.rounds.find((x) => x.id === roundId)!.phase = "reviewing"; });
        this.setTaskStatus(taskId, "running", "PR Fix · CI autopilot is reviewing its fix");
        const diffs: string[] = [];
        for (const [repo, from] of Object.entries(round.fixFrom ?? {})) {
            const p = this.checkoutOf(task, env, repo);
            const head = (await this.headSha(p, env)) ?? "";
            if (from && head && from !== head) diffs.push(`- ${repoLabel(repo)}: \`git -C ${p} diff ${from}..HEAD\``);
        }
        if (!diffs.length) {
            this.autopilotSave(taskId, (s) => { Object.assign(s.rounds.find((x) => x.id === roundId)!, { phase: "failed", error: "the fix round committed nothing", endedAt: now() }); });
            this.setStage(taskId, "pr_waiting");
            this.setTaskStatus(taskId, "blocked", `PR Waiting · #${round.prNumber} — CI autopilot's fix committed nothing · click Fix CI, or fix it yourself`, { notify: true });
            return;
        }
        const { acc, cd } = this.autopilotAccount(task, env);
        const out = join(dir, `ci-autopilot-review-${roundId.slice(0, 8)}.json`);
        const prompt = renderPrompt("ci-autopilot-review.md", {
            ticketId: task.ticket_id, worktree: task.worktree_path ?? env.path, branch: task.branch ?? "", fixDiffs: diffs.join("\n"), brief: fixBrief(round.prNumber, round.verified ?? [], autopilotRulesOf(env.ci_autopilot_rules)), outputFile: out,
        });
        const rulesMat = materializeRules(rulesOf(cd), env, task.worktree_path ?? env.path, this.cfg.dataDir);
        const model = this.modelForOperation(task, "pr_fix_ci", acc);
        const run = startClaude({
            prompt, cwd: task.worktree_path ?? env.path, configDir: cd.path, extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId), ...authEnv(acc) }, settingsPath: rulesMat.settingsPath, appendSystemPrompt: rulesMat.systemPrompt,
            sessionId: randomUUID(), maxTurns: 50, addDirs: [dir], eventLogPath: join(dir, `ci-autopilot-review-${roundId.slice(0, 8)}.ndjson`), ...(model ? { model } : {}),
        });
        const outcome = await run.done;
        if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "pr_fix", stage: "pr_fix" }, outcome.result);
        if (this.getTask(taskId)?.status === "stopped") return;
        let review: AutopilotReview;
        try {
            review = AutopilotReview.parse(JSON.parse(readFileSync(out, "utf8")));
        } catch (e) {
            throw new Error(`no usable review (${existsSync(out) ? String((e as Error).message ?? e).slice(0, 120) : "no file written"})`);
        }
        const serious = review.findings.filter((f) => /^P[01]$/i.test(f.severity) && f.confidence >= 7);
        this.autopilotSave(taskId, (s) => { const r = s.rounds.find((x) => x.id === roundId)!; r.review = review; r.phase = serious.length ? "addressing" : "pushing"; });
        this.addAgentNote(taskId, `🔎 CI autopilot review: ${review.summary || "done"}${review.findings.length ? `\n\n${review.findings.map((f) => `- **${f.severity}** (${f.confidence}/10) \`${f.file}${f.line ? `:${f.line}` : ""}\` — ${f.title}`).join("\n")}` : ""}`);
        if (!serious.length) return this.autopilotPush(taskId, roundId);
        const notes =
            `## The review of your CI fix found ${serious.length} serious finding(s) — address them, then the fix is pushed\n\n` +
            serious.map((f) => `- **${f.severity}** (${f.confidence}/10) \`${f.file}${f.line ? `:${f.line}` : ""}\` — ${f.title}\n  ${f.detail}`).join("\n") +
            `\n\nFix each at its root cause within the scope of the original brief, keep the tests green, commit, and rewrite the output file.`;
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        this.startPrRound(taskId, { [round.repo]: `${repoScopeNote(round.repo)}${fixBrief(round.prNumber, round.verified ?? [], autopilotRulesOf(env.ci_autopilot_rules))}` }, { attempt: rounds.n + 1, operation: "pr_fix_ci", notes });
    }

    private async autopilotPush(taskId: string, roundId: string): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) return;
        const env = this.env(task.env_id);
        this.autopilotSave(taskId, (s) => { s.rounds.find((x) => x.id === roundId)!.phase = "pushing"; });
        await this.pushPrFix(taskId);
        const after = this.getTask(taskId);
        const round = readAutopilot(this.taskDir(taskId)).rounds.find((x) => x.id === roundId)!;
        if (after?.status === "failed") {
            this.autopilotSave(taskId, (s) => { Object.assign(s.rounds.find((x) => x.id === roundId)!, { phase: "failed", error: after.status_line ?? "push failed", endedAt: now() }); });
            return;
        }
        const pushed: Record<string, string> = {};
        for (const repo of Object.keys(round.fixFrom ?? {})) pushed[repo] = (await this.headSha(this.checkoutOf(task, env, repo), env)) ?? "";
        this.autopilotSave(taskId, (s) => { Object.assign(s.rounds.find((x) => x.id === roundId)!, { phase: "pushed", pushed, endedAt: now() }); });
        const fixed = (round.verified ?? []).filter((v) => v.allowed).length;
        const text = `CI autopilot fixed ${fixed} failure(s) on #${round.prNumber} and pushed ${Object.values(pushed).map((x) => x.slice(0, 7)).join(", ")}`;
        this.addAgentNote(taskId, text);
        void notify(this.cfg, { title: `${task.ticket_id} CI autopilot pushed a fix`, message: text, priority: "default", tags: ["robot"], ...(taskLink(this.cfg, task.id) ? { url: taskLink(this.cfg, task.id)! } : {}), localUrl: localTaskLink(this.cfg, task.id), group: `stagehand-${task.id}` });
    }

    // Line comments and notes the human left on Code changes while the task sits at a PR stage (nothing posted to
    // GitHub): a PR-fix round with them as the reviewer notes — the same path User Review's "Request changes" takes
    // before the PR exists. Recorded as a review row so the round shows in the history.
    async startLocalCommentFix(taskId: string, notes: string | undefined, comments: LineComment[]): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        if (!LOCAL_COMMENT_FIX_STAGES.has(task.stage)) throw new Error("this is for a task at a PR stage — use Request changes at User Review");
        if (!notes?.trim() && comments.length === 0) throw new Error("leave a line comment on Code changes or write notes first");
        await this.recordFixComments(task, []);
        const prior = this.db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND stage = 'pr_fix' AND verdict = 'changes'`).get(taskId) as { n: number };
        this.db
            .prepare(`INSERT INTO reviews (id, task_id, stage, verdict, route_to, notes, comments, created_at) VALUES (?, ?, 'pr_fix', 'changes', 'pr_fix', ?, ?, ?)`)
            .run(randomUUID(), taskId, notes?.trim() || null, comments.length ? JSON.stringify(comments) : null, now());
        const failureOutput = `${comments.length} line comment(s) and notes the human left on the task's Code changes (not a CI failure — the PR itself is untouched):\n\n${renderReviewNotes(prior.n + 1, notes, comments, "pr_fix")}`;
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        this.setStage(taskId, "pr_fix");
        this.startPrRound(taskId, { "": failureOutput }, { attempt: rounds.n + 1, operation: "pr_fix_comments" });
        this.autopilotHuman(taskId);
    }

    // Human-triggered only (checkbox picks on the PR comments tab). Same commit-locally-then-review-the-diff cycle as
    // startPrFix, just sourced from one PR's comments instead of failing checks.
    async startPrCommentFix(taskId: string, repo: string, commentIds: number[]): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        const { number, picked, all } = await this.pickedPrComments(taskId, repo, commentIds);
        const threads = this.prCommentThreads(taskId);
        const failureOutput =
            `${repoScopeNote(repo)}${picked.length} comment(s) on PR #${number} picked by the human to address (this is not necessarily a CI failure). ` +
            `Where a comment carries replies or a Stagehand discussion below it, that discussion is the brief: the human's last word there wins over the comment's original wording.\n` +
            picked.map((c) => describePrComment(c).replace(/^- /, `- [comment #${c.id}] `) + renderReplies(c, all) + renderAskThread(threads.get(c.id) ?? [])).join("\n");
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        await this.recordFixComments(task, [{ repo, comments: picked }]);
        this.setStage(taskId, "pr_fix");
        this.startPrRound(taskId, { [repo]: failureOutput }, { attempt: rounds.n + 1, operation: "pr_fix_comments" });
        this.autopilotHuman(taskId);
    }

    // The picked comments of one PR, freshly fetched so a stale checkbox never addresses a comment that changed.
    private async pickedPrComments(taskId: string, repo: string, commentIds: number[]): Promise<{ number: number; picked: PrComment[]; all: PrComment[] }> {
        const row = this.prRow(taskId, repo);
        if (!row?.number) throw new Error(`no PR recorded for ${repoLabel(repo)} yet`);
        const comments = await this.prComments(taskId, repo);
        if (!comments) throw new Error("could not fetch PR comments — re-poll and try again");
        const wanted = new Set(commentIds);
        const picked = [...comments.human, ...comments.automation].filter((c) => wanted.has(c.id));
        if (!picked.length) throw new Error("none of the selected comments were found — they may be stale, refresh and re-select");
        return { number: row.number, picked, all: [...comments.human, ...comments.automation] };
    }

    // The Ask threads under PR comments (messages anchored by MessageAnchor.prComment), by comment id, oldest first.
    private prCommentThreads(taskId: string): Map<number, MessageRow[]> {
        const out = new Map<number, MessageRow[]>();
        for (const m of this.listMessages(taskId)) {
            if (!m.anchor) continue;
            let id: number | undefined;
            try {
                id = (JSON.parse(m.anchor) as MessageAnchor).prComment?.id;
            } catch {
                continue;
            }
            if (id === undefined) continue;
            out.set(id, [...(out.get(id) ?? []), m]);
        }
        return out;
    }

    // Human-triggered only: the picked comments go to the task's chat as a question, not a fix round. The agent assesses
    // each one (does it make sense, is it already addressed on the branch, what a fix would take) and changes nothing;
    // the human then decides between "address" and a reply on GitHub. Answers land in Chat like any Ask.
    async askAboutPrComments(taskId: string, repo: string, commentIds: number[], question: string | undefined): Promise<MessageRow> {
        const { number, picked } = await this.pickedPrComments(taskId, repo, commentIds);
        const ask =
            question?.trim() ||
            "For each comment: does it make sense — agree or disagree, and why? Is it already addressed on this branch (cite the commit or path:line)? " +
                "If not, what would the fix be, how big is it, and what is the risk? Recommend address / reply-and-decline / needs-human-decision per comment.";
        const text = `About ${picked.length} comment(s) on PR #${number}${repo ? ` (${repoLabel(repo)})` : ""}:\n${picked.map(describePrComment).join("\n")}\n\n${ask}`;
        return this.askAgent(taskId, text);
    }

    // After the human approves a PR Fix (already committed locally, never pushed): push every checkout that has
    // unpushed commits, reset those PRs' checks and resume polling.
    // ---------- replies to the PR comments a fix round addressed ----------

    // The comments a PR Fix round addresses, with each repository's HEAD before the round: the fix review offers to
    // reply to each one ("Addressed in <commit>") from the human's GitHub account once the fix is pushed.
    private async recordFixComments(task: TaskRow, groups: Array<{ repo: string; comments: PrComment[] }>): Promise<void> {
        const env = this.env(task.env_id);
        const repos: FixComments["repos"] = {};
        for (const g of groups) {
            const row = this.prRow(task.id, g.repo);
            if (!row?.number || !row.url || !g.comments.length) continue;
            const headBefore = (await this.headSha(this.checkoutOf(task, env, g.repo), env)) ?? "";
            repos[g.repo] = {
                number: row.number,
                prUrl: row.url,
                headBefore,
                comments: g.comments.map((c) => ({ id: c.id, kind: c.kind, author: c.author, url: c.url, body: c.body.slice(0, 400), ...(c.kind === "line" ? { path: c.path, line: c.line, root: c.replyTo ?? c.id } : {}) })),
            };
        }
        const file = join(this.taskDir(task.id), "pr_fix_comments.json");
        if (Object.keys(repos).length) writeFileSync(file, JSON.stringify({ at: now(), repos, replies: [] } satisfies FixComments, null, 2));
        else rmSync(file, { force: true });
    }

    // What the fix review shows: the addressed comments, the round's commits per repository, the replies picked.
    async fixReplies(taskId: string): Promise<(FixComments & { commits: Record<string, Array<{ sha: string; subject: string }>> }) | null> {
        const task = this.getTask(taskId);
        const fc = this.readArtifactJson<FixComments>(taskId, "pr_fix_comments.json");
        if (!task || !fc) return null;
        const env = this.env(task.env_id);
        const commits: Record<string, Array<{ sha: string; subject: string }>> = {};
        for (const [repo, r] of Object.entries(fc.repos)) {
            const log = await this.git(this.checkoutOf(task, env, repo), ["log", "--format=%H %s", r.headBefore ? `${r.headBefore}..HEAD` : "-5"], env).catch(() => "");
            commits[repo] = log.split("\n").filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
        }
        return { ...fc, commits };
    }

    // The fix run's report per comment → outcomes and pre-filled replies. A commit counts only when it is one of the
    // round's own commits (headBefore..HEAD); a round with exactly one commit needs no sha from the agent.
    private async fillFixReplies(taskId: string): Promise<void> {
        const task = this.getTask(taskId);
        const fc = this.readArtifactJson<FixComments>(taskId, "pr_fix_comments.json");
        const out = PrFixResult.safeParse(this.readArtifactJson<unknown>(taskId, "pr_fix.json"));
        if (!task || !fc || !out.success) return;
        const env = this.env(task.env_id);
        const reported = out.data.comments;
        const outcomes: NonNullable<FixComments["outcomes"]> = [];
        const replies: FixComments["replies"] = [];
        for (const [repo, r] of Object.entries(fc.repos)) {
            const cwd = this.checkoutOf(task, env, repo);
            const log = await this.git(cwd, ["log", "--format=%H", r.headBefore ? `${r.headBefore}..HEAD` : "-1"], env).catch(() => "");
            const shas = log.split("\n").filter(Boolean);
            for (const c of r.comments) {
                const o = reported.find((x) => x.id === c.id);
                if (!o) {
                    outcomes.push({ repo, commentId: c.id, addressed: false, sha: null, note: "the fix run did not report on this comment" });
                    continue;
                }
                const want = o.commit.trim().toLowerCase();
                const sha = !o.addressed ? null : (want ? shas.find((x) => x.startsWith(want)) : undefined) ?? (shas.length === 1 ? shas[0]! : null);
                const note = o.note || (o.addressed && !sha ? (want ? `commit ${o.commit} is not one of this round's commits` : "no commit named") : "");
                outcomes.push({ repo, commentId: c.id, addressed: o.addressed && !!sha, sha, note });
                if (o.addressed && sha) replies.push({ repo, commentId: c.id, sha, posted: null, error: null });
            }
        }
        writeFileSync(join(this.taskDir(taskId), "pr_fix_comments.json"), JSON.stringify({ ...fc, outcomes, replies } satisfies FixComments, null, 2));
        this.emitTask(taskId);
    }

    setFixReplies(taskId: string, replies: FixComments["replies"]): void {
        const fc = this.readArtifactJson<FixComments>(taskId, "pr_fix_comments.json");
        if (!fc) throw new Error("this fix round addressed no PR comments");
        for (const r of replies) if (!fc.repos[r.repo]?.comments.some((c) => c.id === r.commentId)) throw new Error(`comment ${r.commentId} is not one this round addressed`);
        for (const r of replies) {
            const o = fc.outcomes?.find((x) => x.repo === r.repo && x.commentId === r.commentId);
            if (o && !o.addressed) throw new Error(`comment ${r.commentId} was not addressed by this round (${o.note || "no reason given"}) — it gets no "Addressed in" reply`);
        }
        writeFileSync(join(this.taskDir(taskId), "pr_fix_comments.json"), JSON.stringify({ ...fc, replies: replies.map((r) => ({ ...r, posted: null, error: null })) }, null, 2));
        this.emitTask(taskId);
    }

    // After the push: each picked reply goes to GitHub with the env's gh login (the human's account). A line comment
    // gets a reply in its thread; a review or general comment gets a PR comment that quotes it.
    private async postFixReplies(task: TaskRow, env: EnvRow): Promise<void> {
        const file = join(this.taskDir(task.id), "pr_fix_comments.json");
        const fc = this.readArtifactJson<FixComments>(task.id, "pr_fix_comments.json");
        if (!fc?.replies.length) return;
        const done: string[] = [];
        for (const r of fc.replies) {
            if (r.posted) continue;
            const pr = fc.repos[r.repo];
            const c = pr?.comments.find((x) => x.id === r.commentId);
            const m = pr ? /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr.prUrl) : null;
            if (!pr || !c || !m) continue;
            const cwd = this.checkoutOf(task, env, r.repo);
            // The push may have rewritten the commit (a pull --rebase): link to the pushed commit with the same subject.
            if (!(await this.git(cwd, ["merge-base", "--is-ancestor", r.sha, "HEAD"], env).then(() => true, () => false))) {
                const subject = await this.git(cwd, ["log", "-1", "--format=%s", r.sha], env).catch(() => "");
                const pushed = subject ? (await this.git(cwd, ["log", "--format=%H %s", pr.headBefore ? `${pr.headBefore}..HEAD` : "-20"], env).catch(() => "")).split("\n").find((l) => l.slice(41) === subject)?.slice(0, 40) : undefined;
                if (pushed) r.sha = pushed;
            }
            const link = `${pr.prUrl}/commits/${r.sha}`;
            try {
                const out =
                    c.kind === "line"
                        ? await this.gh(cwd, ["api", "-X", "POST", `repos/${m[1]}/${m[2]}/pulls/${m[3]}/comments/${c.root ?? c.id}/replies`, "-f", `body=Addressed in ${link}`], env)
                        : await this.gh(cwd, ["api", "-X", "POST", `repos/${m[1]}/${m[2]}/issues/${m[3]}/comments`, "-f", `body=> ${c.body.split("\n").filter(Boolean)[0]?.slice(0, 200) ?? ""}\n\n@${c.author} addressed in ${link} (${c.url})`], env);
                r.posted = (JSON.parse(out) as { html_url?: string }).html_url ?? "posted";
                r.error = null;
                done.push(`${c.author}'s comment`);
            } catch (e) {
                r.error = String((e as Error).message ?? e).slice(0, 200);
            }
        }
        writeFileSync(file, JSON.stringify(fc, null, 2));
        const failed = fc.replies.filter((r) => r.error);
        if (done.length) this.addAgentNote(task.id, `Replied "Addressed in …" on GitHub to ${done.length} comment(s).`);
        if (failed.length) this.addAgentNote(task.id, `${failed.length} GitHub repl${failed.length === 1 ? "y" : "ies"} failed: ${failed.map((r) => r.error).join("; ")}`);
    }

    // `opts.approved`: the push after an approval at User Review for PRs that are already open (no fix replies).
    private async pushPrFix(taskId: string, opts: { approved?: boolean } = {}): Promise<void> {
        const task = this.getTask(taskId);
        if (!task?.branch) return;
        const env = this.env(task.env_id);
        const rules = rulesOf(this.configDirOf(env));
        if (!rules.allowPush) {
            this.setStage(taskId, "pr_waiting");
            this.setTaskStatus(taskId, "idle", `PR Waiting · this env forbids agent pushes — push \`${task.branch}\` yourself; Stagehand resumes polling once you do`);
            return;
        }
        this.setTaskStatus(taskId, "running", opts.approved ? "PR Waiting · pushing the approved changes to the open PRs" : "PR Fix · pushing the approved fix");
        let current = "";
        try {
            for (const repo of this.prRepos(env)) {
                current = repo;
                const cwd = this.checkoutOf(task, env, repo);
                if (!existsSync(cwd)) continue;
                const remote = await this.git(cwd, ["ls-remote", "--heads", "origin", task.branch], env).catch(() => "");
                const ahead = await this.git(cwd, ["log", "--oneline", remote ? `origin/${task.branch}..HEAD` : `origin/${this.baseBranchOf(task, env, repo)}..HEAD`], env).catch(() => "");
                if (!ahead) continue;
                const how = await this.pushBranch(cwd, env, task.branch, this.prRow(taskId, repo)?.pushed_sha ?? null);
                if (how !== "pushed") this.addAgentNote(taskId, `${repoLabel(repo)}: ${how}`);
                this.resetPrState(taskId, repo, await this.headSha(cwd, env));
            }
        } catch (e) {
            // The fix stays committed and approved: Retry runs this push again (no agent run), and a force-push from
            // Code changes carries on from here by itself.
            this.setTaskStatus(taskId, "failed", `PR Fix · ${repoLabel(current)}: push failed — ${gitErrorTail(e).slice(0, 200)} · fix the checkout (or force-push from Code changes), then Retry pushes again`);
            return;
        }
        // A fix can land while a repository's draft is still unapproved (its PR never opened before CI on another
        // repository's PR failed): that draft still needs the human — back to PR Creation Review for it, not on to
        // PR Waiting where nothing offers to open it.
        if (!opts.approved) await this.postFixReplies(task, env).catch((e: unknown) => console.warn(`[stagehand] fix replies ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`));
        const repos = this.draftRepos(taskId, env);
        const rows = this.prRows(taskId);
        const missing = repos.filter((r) => !rows.find((x) => x.repo === r)?.number);
        if (missing.length) {
            const opened = repos.filter((r) => !missing.includes(r));
            this.setStage(taskId, "pr_creation_review");
            this.setTaskStatus(taskId, "waiting_user", `PR Creation Review · fix pushed${opened.length ? ` to ${opened.map((r) => `${repoPrefix(r, repos)}#${rows.find((x) => x.repo === r)!.number}`).join(", ")}` : ""} — still to review: ${missing.map((r) => repoLabel(r)).join(", ")}`);
            this.pollPrSoon(taskId);
            return;
        }
        this.advance(taskId, "pr_waiting");
        this.pollPrSoon(taskId);
    }

    // ---------- stage machine ----------

    private setStage(taskId: string, stage: Stage): void {
        const prev = this.getTask(taskId);
        this.db.prepare(`UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?`).run(stage, now(), taskId);
        if (prev && prev.stage !== stage) this.recordTaskEvent(taskId, stage, prev.status);
    }

    private setTaskStatus(taskId: string, status: TaskStatus, line?: string, opts: { notify?: boolean } = {}): void {
        const prev = this.getTask(taskId);
        this.db
            .prepare(`UPDATE tasks SET status = ?, status_line = COALESCE(?, status_line), updated_at = ? WHERE id = ?`)
            .run(status, line ?? null, now(), taskId);
        const next = this.getTask(taskId);
        if (next && prev && prev.status !== status) this.recordTaskEvent(taskId, next.stage, status);
        this.emit("task", next);
        // The baseline pass ended (blocked, questions, stopped, failed, done): the worktree goes back to its branch.
        if (status !== "running" && this.baseCheckout.isOn(taskId) && !this.hasLiveRun(taskId)) void this.fromBase(taskId);
        if (opts.notify !== false && next && prev && NEEDS_HUMAN.has(status) && (prev.status !== status || prev.status_line !== next.status_line)) this.notifyNeedsHuman(next);
    }

    private hasLiveRun(taskId: string): boolean {
        const ids = (this.db.prepare(`SELECT id FROM runs WHERE task_id = ? AND status = 'running'`).all(taskId) as Array<{ id: string }>).map((r) => r.id);
        return ids.some((id) => this.active.has(id)) || [...this.qaGroups.values()].some((g) => g.taskId === taskId);
    }

    // ---------- the QA baseline on base code ----------

    private migrationOpts(task: TaskRow, env: EnvRow) {
        return { worktree: task.worktree_path!, envPath: env.path, vars: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, task.id) }, logPath: join(this.taskDir(task.id), "logs", "migrate.log") };
    }

    // Switches the worktree to the base when its branch has commits or changes: the servers stop, migrations go down
    // on the branch's code, uncommitted work is stashed, each changed repo is checked out at its merge-base. False (and
    // blocked, the worktree back on its branch) when that fails.
    private async toBase(taskId: string): Promise<boolean> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path) return true;
        const env = this.env(task.env_id);
        const m = this.migrationOpts(task, env);
        const repos = await this.baseCheckout.changedRepos(this.layoutOf(task, env), task.worktree_path, m.vars).catch(() => []);
        if (!repos.length) return true;
        const where = repos.map((r) => r.dir || "the worktree").join(", ");
        this.setTaskStatus(taskId, "running", `QA Baseline · switching ${where} to the base${env.migrate_down_command ? " (migrations down first)" : ""} — the baseline runs on code without this change`);
        try {
            await this.services.stopAll(taskId);
            await assertDbHosts(env, task.worktree_path, taskDbExpect(this.db, task, env));
            await this.baseCheckout.enter(taskId, repos, { ...m, downCommand: env.migrate_down_command ? withPrepare(env, env.migrate_down_command) : null });
            this.emitTask(taskId);
            return true;
        } catch (e) {
            const why = String((e as Error).message ?? e).slice(0, 400);
            await this.baseCheckout.exit(taskId, { ...m, upCommand: env.migrate_command ? withPrepare(env, env.migrate_command) : null }).catch(() => undefined);
            this.setTaskStatus(taskId, "blocked", `QA Baseline · cannot run on the base code: ${why} — the worktree stays on its branch; fix the env's Migrate down command and Retry, or Skip the baseline`);
            return false;
        }
    }

    // Back to the branch after the baseline: servers stop (they ran base code), the branch and its stash come back,
    // migrations go up.
    private async fromBase(taskId: string): Promise<boolean> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path || !this.baseCheckout.isOn(taskId)) return true;
        const env = this.env(task.env_id);
        try {
            await this.services.stopAll(taskId);
            await assertDbHosts(env, task.worktree_path, taskDbExpect(this.db, task, env));
            await this.baseCheckout.exit(taskId, { ...this.migrationOpts(task, env), upCommand: env.migrate_command ? withPrepare(env, env.migrate_command) : null });
            this.emitTask(taskId);
            return true;
        } catch (e) {
            this.setTaskStatus(taskId, "blocked", `The worktree is still on the base after the QA baseline: ${String((e as Error).message ?? e).slice(0, 400)} — fix it, then Retry restores the branch`);
            return false;
        }
    }

    private async restoreBaseCheckouts(): Promise<void> {
        for (const t of this.db.prepare(`SELECT id FROM tasks WHERE worktree_path IS NOT NULL`).all() as Array<{ id: string }>) {
            if (this.baseCheckout.isOn(t.id)) await this.fromBase(t.id);
        }
    }

    // True while a QA baseline has the worktree on the base (the task page says so).
    onBaseCode(taskId: string): boolean {
        return this.baseCheckout.isOn(taskId);
    }

    // The one push a PR's checks earn when they all pass; failures go through notifyNeedsHuman (blocked), once.
    private notifyChecksPassed(task: TaskRow, text: string): void {
        void notify(this.cfg, {
            title: `${task.ticket_id} checks passed`,
            message: text,
            priority: "default",
            tags: ["white_check_mark"],
            ...(taskLink(this.cfg, task.id) ? { url: taskLink(this.cfg, task.id)! } : {}),
            localUrl: localTaskLink(this.cfg, task.id),
            group: `stagehand-${task.id}`,
        });
    }

    // Every change of (stage, status) is one row for the timing analytics (timing.ts); "queued" is written straight
    // into the row by parkQueued and lands here through the next status change.
    private recordTaskEvent(taskId: string, stage: Stage, status: string): void {
        const t = this.getTask(taskId);
        this.db.prepare(`INSERT INTO task_events (id, task_id, ticket_id, at, stage, status) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), taskId, t?.ticket_id ?? null, now(), stage, status);
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

    // The one-shot "skip QA this pass" flag: set by Request changes / Return to a stage, consumed by advance() when the
    // task reaches User Review again, so the pass after that runs QA as usual unless asked again.
    private setSkipQa(taskId: string, on: boolean): void {
        this.db.prepare(`UPDATE tasks SET skip_qa = ?, updated_at = ? WHERE id = ?`).run(on ? 1 : 0, now(), taskId);
    }

    private advance(taskId: string, stage: Stage): void {
        const task = this.getTask(taskId)!;
        let target = stage;
        // The Code Review stage is optional per environment (envs.code_review); off, Implementation goes straight on to QA.
        if (target === "code_review" && this.env(task.env_id).code_review === 0) target = "manual_qa";
        // The QA baseline belongs to the design stage, never after it (the user, 2026-10-06: "There should be no separate
        // QA baseline step at all anymore, baseline is A PART of design proposal, never else"): approval goes straight on
        // to Implementation; scenarios without a current result from the design loop are named, not run here.
        if (target === "qa_baseline" || (target === "implementation" && (task.stage === "design_proposal" || task.stage === "qa_baseline"))) {
            const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
            const gaps = design?.qa.length && !task.skip_qa ? (this.designBaselineGaps(taskId) ?? Object.keys(scenarioHashes(design))) : [];
            if (gaps.length) this.addAgentNote(taskId, `No QA baseline from the design stage for ${gaps.join(", ")} (changed after its last round, or none ran); Manual QA compares them without a baseline`);
            target = "implementation";
        }
        if (target === "manual_qa") {
            const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
            // No browser scenarios in the design, or the human asked to skip QA this pass: hop over the QA stage.
            if (!design || design.qa.length === 0 || task.skip_qa) {
                if (task.skip_qa) this.addAgentNote(taskId, `${STAGE_DEFS[target].label} skipped this pass at your request`);
                target = "user_review";
            }
        }
        if (target === "user_review" && task.skip_qa) this.setSkipQa(taskId, false);
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

    // Another task's browser stage (QA baseline / Manual QA) currently running on this account, if any.
    private runningBrowserRun(accountId: string, exceptTaskId: string): { ticket_id: string; stage: Stage } | null {
        const browserStages = STAGES.filter((s) => STAGE_DEFS[s]?.chrome);
        if (browserStages.length === 0) return null;
        const row = this.db
            .prepare(`SELECT t.ticket_id, r.stage FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.account_id = ? AND r.status = 'running' AND r.task_id != ? AND r.stage IN (${browserStages.map(() => "?").join(",")}) LIMIT 1`)
            .get(accountId, exceptTaskId, ...browserStages) as { ticket_id: string; stage: Stage } | undefined;
        return row ?? null;
    }

    private runningCount(accountId: string): number {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE account_id = ? AND status = 'running'`).get(accountId) as { n: number };
        return row.n;
    }

    // ---------- which model a run gets ----------
    //
    // The task's own model (set at creation) wins everywhere. Otherwise the models of the account that runs it
    // (accounts.models — models are the provider's): a stage run takes the operation's model when the round was started
    // as one (PR Fix for checks / for comments), else the stage's rerun model once the stage already ran on this task,
    // else the stage's first-run model, then the account's default; null = the CLI's own default for the account.
    private modelForStage(task: TaskRow, stage: Stage, opts: DispatchOpts, account: AccountRow): string | null {
        if (opts.model) return opts.model;
        if (task.model) return task.model;
        const m = accountModelsOf(account);
        const op = opts.operation ? m.operations[opts.operation] : null;
        if (op) return op;
        const prior = (this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = ?`).get(task.id, stage) as { n: number }).n;
        const rerun = prior > 0 || (opts.attempt ?? 1) > 1 ? m.reruns[stage] : null;
        return rerun ?? m.stages[stage] ?? m.default ?? null;
    }

    // The side runs (chat, Do, rebase, service fix, history edit): the task's model, else the account's model for the
    // operation, else the account's default.
    private modelForOperation(task: TaskRow, op: OperationKind, account: AccountRow): string | null {
        const m = accountModelsOf(account);
        return task.model ?? m.operations[op] ?? m.default ?? null;
    }

    // ---------- chat: the human's own Q&A / notes channel with the task's agent ----------

    listMessages(taskId: string): MessageRow[] {
        return this.db.prepare(`SELECT * FROM messages WHERE task_id = ? ORDER BY created_at`).all(taskId) as MessageRow[];
    }

    private addMessage(taskId: string, role: "user" | "agent", text: string, anchor: MessageAnchor | null = null, kind: MessageKind | null = null, files: SharedFile[] = []): MessageRow {
        const id = randomUUID();
        this.db
            .prepare(`INSERT INTO messages (id, task_id, role, text, created_at, anchor, kind, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, taskId, role, text, now(), anchor ? JSON.stringify(anchor) : null, kind, files.length ? JSON.stringify(files) : null);
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

    // A note from the service layer (a BE/FE restarted on its own after its pane vanished) — same Chat timeline.
    serviceNotice(taskId: string, text: string): void {
        if (!this.getTask(taskId)) return;
        this.addAgentNote(taskId, text);
        this.emitTask(taskId);
    }

    // Asks the task's agent a question in its own session (full context: everything it has done on this task so far).
    // Same constraint as the terminal: a headless stage run and an ad-hoc chat turn cannot share the session at once.
    // With an anchor, the question is about one line of the task's diff (asked from Code changes): the prompt names the
    // file, side and line and quotes it, and the reply carries the same anchor so it shows up under that line as a thread.
    // `files`: what the human attached (already saved under the task dir's shared/) — named in the prompt by path.
    async askAgent(taskId: string, text: string, anchor: MessageAnchor | null = null, files: SharedFile[] = []): Promise<MessageRow> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a headless run owns this session right now — ask again once it's idle");
        this.addMessage(taskId, "user", text, anchor, null, files);
        const env = this.env(task.env_id);
        const cd = this.configDirOf(env);
        const usable = this.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === accountOrderOf(env)[0]) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        const quoted = `"${text.replace(/"/g, '\\"')}"`;
        const earlier = anchor ? this.listMessages(taskId).filter((m) => m.anchor && sameAnchor(JSON.parse(m.anchor) as MessageAnchor, anchor)).slice(0, -1) : [];
        const prompt = anchor?.prComment
            ? `The human is looking at ONE review comment on this task's pull request #${anchor.prComment.number}${anchor.prComment.repo ? ` (repository \`${anchor.prComment.repo}/\` inside the worktree)` : ""}, ` +
              `by ${anchor.prComment.author}${anchor.path ? ` on \`${anchor.path}${anchor.line ? `:${anchor.line}` : ""}\`` : ""} (${anchor.prComment.url}), which says:\n\n` +
              `${anchor.snippet.trim().split("\n").map((l) => `    ${l}`).join("\n")}\n\n` +
              (earlier.length ? `Earlier in this same thread:\n${earlier.map((m) => `- ${m.role === "user" ? "Human" : "You"}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}\n\n` : "") +
              `Their question: ${quoted}\n\n` +
              `Answer directly and briefly about that comment. Read the code it points at (in ${task.worktree_path ?? env.path}) and this branch's commits as needed: say whether the point makes sense and why, ` +
              `whether the branch already addresses it (cite the commit or path:line), and if not what a fix would take and its risk. ` +
              `If they are actually asking for a change, say what you would do and that it happens through "Ask agent to address" on the PR comments tab or a review round — do not make code changes from this chat.`
            : anchor
            ? `The human is looking at this task's diff (branch vs base) and asked about ONE specific line of it — ` +
              `file \`${anchor.path}\`, ${anchor.side === "old" ? `the removed line at old line ${anchor.line}` : `line ${anchor.line} of the current file`}, which reads:\n\n` +
              `    ${anchor.snippet}\n\n` +
              (earlier.length ? `Earlier in this same thread:\n${earlier.map((m) => `- ${m.role === "user" ? "Human" : "You"}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n")}\n\n` : "") +
              `Their question: ${quoted}\n\n` +
              `Answer directly and briefly about that code. Open the file (in ${task.worktree_path ?? env.path}) and read around the line as needed — explain what it does, why it was changed that way, or what the consequence is, whichever they are asking. ` +
              `If they are actually asking for a change, say what you would do and that it happens through the normal stage flow (a review comment on the line, Return to a stage) — do not make code changes from this chat.`
            : `The human sent this in the task's chat — a question or comment, not necessarily an instruction: ${quoted}\n\n` +
              `Answer directly and briefly, drawing on this task's own history (research, design, code, QA) as needed. ` +
              `If they are actually asking for a change, say what you would do and that it happens through the normal stage flow (Return to a stage, or a new review round) — do not make code changes from this chat.`;
        const run = startClaude({
            prompt: prompt + renderSharedFiles(files, this.taskDir(taskId)),
            cwd: task.worktree_path ?? env.path,
            configDir: cd.path,
            extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId), ...authEnv(acc) },
            ...this.sessionArgs(task),
            maxTurns: 15,
            // The task dir holds the files the human shares (and the artifacts a question may be about).
            addDirs: [this.taskDir(taskId)],
            ...((): { model?: string } => {
                const m = this.modelForOperation(task, "chat", acc);
                return m ? { model: m } : {};
            })(),
        });
        const outcome = await run.done;
        if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "chat", stage: null }, outcome.result);
        const reply = outcome.result?.result?.trim() || (outcome.exitCode !== 0 ? `(could not answer: ${outcome.stderr.trim().split("\n").slice(-2).join(" ").slice(-200) || `exit ${outcome.exitCode}`})` : "(no reply)");
        return this.addMessage(taskId, "agent", reply, anchor);
    }

    // Chat → Do: free-text instructions the agent carries out now, in the task's own session (so it has the task's whole
    // history) and worktree. Unlike a chat question this run may change code — it runs with the environment's guard
    // hook and rules, so commit/push/PR policy still holds — and unlike a stage it has no output contract: the agent's
    // plain-text report lands in Chat when it finishes, and the task's stage/status are restored afterward. Returns as
    // soon as the run has started (the human's message is already in Chat); Stop kills it like any other run.
    async instruct(taskId: string, text: string, files: SharedFile[] = []): Promise<MessageRow> {
        const instructions = text.trim();
        if (!instructions) throw new Error("write what the agent should do first");
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run owns this session right now — instruct it once it's idle");
        const env = this.env(task.env_id);
        const cwd = task.worktree_path ?? env.path;
        if (!existsSync(cwd)) throw new Error("no worktree yet — the task has not started");
        const cd = this.configDirOf(env);
        const usable = this.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === accountOrderOf(env)[0]) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        const message = this.addMessage(taskId, "user", instructions, null, "instruction", files);
        const prevStatus = task.status;
        const prevLine = task.status_line;
        const rules = rulesOf(cd);
        const taskDir = this.taskDir(taskId);
        const prompt = renderPrompt("instruct.md", {
            instructions: instructions + renderSharedFiles(files, taskDir),
            worktree: cwd,
            branch: task.branch ?? "(no branch yet)",
            taskDir,
            repoLayout: describeRepoLayout(this.layoutOf(task, env), task.worktree_path),
            commitRule: rules.allowCommit
                ? `Commits are allowed; every message must match \`${rules.commitPattern}\` — ${rules.commitHint}${rules.commitForbid.length ? ` Never include ${rules.commitForbid.map((f) => `\`${f}\``).join(", ")}.` : ""}`
                : "Commits are NOT allowed in this environment: leave changes uncommitted (staging is fine) and say so; the human commits.",
            pushRule: rules.allowPush ? "Pushing is allowed here only when the instruction explicitly asks for it." : "Pushing is NOT allowed in this environment; never push.",
            taskNotes: task.notes?.trim() ? `\nThe human's standing notes on this task (they still apply): ${task.notes.trim()}` : "",
        });
        const rulesMat = materializeRules(rules, env, task.worktree_path, this.cfg.dataDir);
        mkdirSync(join(taskDir, "instructions"), { recursive: true });
        const label = `Instruction · ${instructions.replace(/\s+/g, " ").slice(0, 60)}${instructions.length > 60 ? "…" : ""}`;
        this.setTaskStatus(taskId, "running", `${label} · starting`);
        const run = startClaude({
            prompt,
            cwd,
            configDir: cd.path,
            extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId), ...authEnv(acc) },
            settingsPath: rulesMat.settingsPath,
            appendSystemPrompt: rulesMat.systemPrompt,
            ...this.sessionArgs(task),
            maxTurns: Engine.INSTRUCT_MAX_TURNS,
            addDirs: [taskDir],
            eventLogPath: join(taskDir, "instructions", `${message.id}.ndjson`),
            ...((): { model?: string } => {
                const m = this.modelForOperation(task, "instruct", acc);
                return m ? { model: m } : {};
            })(),
        });
        this.instructing.set(taskId, run);
        run.on("activity", (ev: ActivityEvent) => {
            if (ev.kind === "tool_use" || ev.kind === "text") {
                this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`${label} · ${ev.summary}`, now(), taskId);
                this.emit("activity", { taskId, runId: message.id, event: ev });
                this.emitTask(taskId);
            }
        });
        run.on("rate_limit", (info: RateLimitInfo) => this.recordRateLimit(acc.id, info));
        void run.done.then((outcome: RunOutcome) => {
            this.instructing.delete(taskId);
            if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "instruct", stage: null }, outcome.result);
            const killed = outcome.exitCode !== 0 && !outcome.result;
            const reply =
                outcome.result?.result?.trim() ||
                (killed ? "(stopped before it finished — the worktree may hold partial changes; check Code changes)" : outcome.exitCode !== 0 ? `(did not finish: ${outcome.stderr.trim().split("\n").slice(-2).join(" ").slice(-200) || `exit ${outcome.exitCode}`})` : "(no reply)");
            this.setTaskStatus(taskId, prevStatus, prevLine ?? "instruction finished — see Chat");
            this.addMessage(taskId, "agent", reply, null, "instruction_result");
            this.emitTask(taskId);
        });
        return message;
    }

    private static readonly INSTRUCT_MAX_TURNS = 120;

    // ---------- git history edits (Code changes tab: Remove / Change message / force-push) ----------

    // A commit belongs to this task's own work if it's on the branch but not on the base — never let these operate
    // on inherited history.
    private async ownCommitShas(cwd: string, env: EnvRow): Promise<Set<string>> {
        const log = await this.git(cwd, ["rev-list", `origin/${env.base_branch}..HEAD`], env).catch(() => "");
        return new Set(log.split("\n").filter(Boolean));
    }

    // Preflight shared by both history edits: the task must not be mid-run, the checkout must exist and be clean, and
    // the target commit must be one of this task's own (never rewrite something inherited from the base branch).
    private async gitEditPreflight(taskId: string, repo: string, sha: string): Promise<{ task: TaskRow; env: EnvRow; cwd: string }> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — wait for it to finish");
        if (!task.branch) throw new Error("task has no branch yet");
        const env = this.env(task.env_id);
        const cwd = this.checkoutOf(task, env, repo);
        if (!existsSync(cwd)) throw new Error(`${repoLabel(repo)}: no worktree checkout yet`);
        const dirty = await dirtyPaths(cwd, parseEnvVars(env.env_vars)).catch(() => []);
        if (dirty.length) throw new Error(`${repoLabel(repo)}: the worktree has uncommitted changes — commit or discard them first: ${describePaths(dirty)}`);
        const own = await this.ownCommitShas(cwd, this.layoutOf(task, env));
        const full = own.has(sha) ? sha : [...own].find((s) => s.startsWith(sha));
        if (!full) throw new Error(`${repoLabel(repo)}: ${sha.slice(0, 10)} is not one of this task's own commits on ${task.branch}`);
        return { task, env, cwd };
    }

    // Reword: pure metadata edit. Relinks each commit from the target onward onto a fresh parent chain via
    // `commit-tree`, changing only the target's message — every tree (file content), author and date is preserved
    // exactly, for the target and for everything after it. Because no patch is ever re-applied, this cannot conflict.
    async rewordCommit(taskId: string, repo: string, sha: string, message: string): Promise<{ newSha: string }> {
        const text = message.trim();
        if (!text) throw new Error("the commit message cannot be empty");
        if (/\n/.test(text)) throw new Error("one line only — the same rule as a normal commit here");
        const { env, cwd } = await this.gitEditPreflight(taskId, repo, sha);
        const gitEnv = { ...process.env, ...parseEnvVars(env.env_vars) };
        const chain = (await this.git(cwd, ["rev-list", "--reverse", `${sha}^..HEAD`], env)).split("\n").filter(Boolean);
        let parent = (await this.git(cwd, ["rev-parse", `${sha}^`], env)).trim();
        for (const commit of chain) {
            const tree = (await this.git(cwd, ["rev-parse", `${commit}^{tree}`], env)).trim();
            const meta = execFileSync("git", ["-C", cwd, "log", "-1", "--format=%an%n%ae%n%ad%n%cn%n%ce%n%cd", "--date=raw", commit], { env: gitEnv, encoding: "utf8" }).split("\n");
            const [an, ae, ad, cn, ce, cd] = meta;
            const body = commit === sha ? text : execFileSync("git", ["-C", cwd, "show", "-s", "--format=%B", commit], { env: gitEnv, encoding: "utf8" });
            const newSha = execFileSync(
                "git",
                ["-C", cwd, "commit-tree", tree, "-p", parent],
                { env: { ...gitEnv, GIT_AUTHOR_NAME: an ?? "", GIT_AUTHOR_EMAIL: ae ?? "", GIT_AUTHOR_DATE: ad ?? "", GIT_COMMITTER_NAME: cn ?? "", GIT_COMMITTER_EMAIL: ce ?? "", GIT_COMMITTER_DATE: cd ?? "" }, input: body, encoding: "utf8" },
            ).trim();
            parent = newSha;
        }
        await this.git(cwd, ["reset", "--hard", parent], env);
        this.addAgentNote(taskId, `🔧 ${repoLabel(repo)}: reworded ${sha.slice(0, 7)} → "${text}"`);
        this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
        this.emitTask(taskId);
        return { newSha: parent };
    }

    // Remove: a real content change (everything after the target has to be replayed without it), so it goes through
    // the agent in the task's own session — it can hit conflicts a mechanical rewrite can't judge. Runs with no guard
    // hook attached (same as Chat), scoped to exactly this one instruction; never pushes. The task's stage and status
    // are restored afterward — this is a side operation, not a pipeline stage. Validates and starts synchronously
    // (so a bad request — dirty worktree, task busy, unknown commit — surfaces to the button that triggered it) and
    // returns once the run has started; the result (success or failure) lands in Chat when it finishes.
    async removeCommit(taskId: string, repo: string, sha: string, note: string | undefined, files: SharedFile[] = []): Promise<void> {
        const { task, env, cwd } = await this.gitEditPreflight(taskId, repo, sha);
        const subject = (await this.git(cwd, ["log", "-1", "--format=%s", sha], env).catch(() => "")).trim();
        const cd = this.configDirOf(env);
        const usable = this.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === accountOrderOf(env)[0]) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        const prevStatus = task.status;
        const prevLine = task.status_line;
        this.setTaskStatus(taskId, "running", `Removing commit ${sha.slice(0, 7)}${repo ? ` (${repo})` : ""}…`);
        const prompt = renderPrompt("git-remove-commit.md", {
            repo,
            cwd,
            branch: task.branch ?? "",
            sha,
            subject,
            humanNote: (note?.trim() ? `\nThe human's note on why: ${note.trim()}` : "") + renderSharedFiles(files, this.taskDir(taskId)),
        });
        const run = startClaude({
            prompt,
            cwd,
            configDir: cd.path,
            extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId), ...authEnv(acc) },
            ...this.sessionArgs(task),
            maxTurns: 60,
            ...((): { model?: string } => {
                const m = this.modelForOperation(task, "git_edit", acc);
                return m ? { model: m } : {};
            })(),
        });
        void run.done.then((outcome: RunOutcome) => {
            this.setTaskStatus(taskId, prevStatus, prevLine ?? undefined);
            if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "git-edit", stage: null }, outcome.result);
            const reply = outcome.result?.result?.trim() || (outcome.exitCode !== 0 ? `(did not finish: ${outcome.stderr.trim().split("\n").slice(-2).join(" ").slice(-200) || `exit ${outcome.exitCode}`})` : "(no reply)");
            this.addMessage(taskId, "agent", `🔧 Remove commit ${sha.slice(0, 7)} "${subject}" (${repoLabel(repo)}):\n\n${reply}`);
            this.emitTask(taskId);
        });
    }

    // Local history now differs from what (if anything) is already on GitHub — the human pushes it explicitly, never
    // automatically, after reviewing the rewritten log/diff themselves.
    async forcePushBranch(taskId: string, repo: string, force = false): Promise<string> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — wait for it to finish");
        if (!task.branch) throw new Error("task has no branch yet");
        const env = this.env(task.env_id);
        const rules = rulesOf(this.configDirOf(env));
        if (!rules.allowPush) throw new Error("this environment forbids pushes — push it yourself from the worktree");
        const cwd = this.checkoutOf(task, env, repo);
        if (!existsSync(cwd)) throw new Error(`${repoLabel(repo)}: no worktree checkout yet`);
        // The lease is checked against the remote-tracking ref, which is only as fresh as the last fetch — git's bare
        // "stale info" rejection tells the human nothing. Refresh it first and, if GitHub moved in the meantime (an
        // "Update branch" merge, a reviewer's or bot's commit), say exactly what a force-push would throw away.
        const known = await this.git(cwd, ["rev-parse", "-q", "--verify", `origin/${task.branch}`], env).catch(() => "");
        await this.git(cwd, ["fetch", "origin", task.branch], env).catch(() => "");
        const remote = await this.git(cwd, ["rev-parse", "-q", "--verify", `origin/${task.branch}`], env).catch(() => "");
        if (!force && known && remote && known !== remote) {
            const subjects = (await this.git(cwd, ["log", "--format=%h %s", `${known}..${remote}`], env).catch(() => "")).split("\n").filter(Boolean);
            throw new Error(
                `GitHub has ${subjects.length} commit(s) on ${task.branch} that arrived since this worktree last fetched — force-pushing discards them: ${subjects.slice(0, 5).join("; ")}${subjects.length > 5 ? "; …" : ""}`,
            );
        }
        await this.git(cwd, ["push", remote ? `--force-with-lease=${task.branch}:${remote}` : "--force-with-lease", "-u", "origin", task.branch], env);
        this.resetPrState(taskId, repo, await this.headSha(cwd, env));
        this.onBranchRewritten(env, task.branch);
        this.db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now(), taskId);
        this.emitTask(taskId);
        // The push an approved PR Fix failed on was just done by hand: carry on where that step stopped (any other
        // repository still ahead is pushed, then the task moves to PR Waiting) instead of staying "failed".
        if (this.pushFailedAfterPrFix(taskId)) {
            void this.pushPrFix(taskId);
            return `force-pushed ${repoLabel(repo)} — resuming the PR Fix push`;
        }
        this.pollPrSoon(taskId);
        return `force-pushed ${repoLabel(repo)}`;
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

    // Everything the human told the agent about this task, oldest first: the task notes, every Request-changes /
    // Return-to round (notes and line comments), the answers to the agent's questions, chat messages and Do
    // instructions. The reviewer checks the diff against it — the implementer's own account cannot be trusted for
    // that (INV-136, 2026-09-24: a round said "remove the serial_number parameter — TOTALLY", the agent kept it and
    // argued the point in impl.json notes; the review, seeing only the diff and the design, passed it).
    private humanDirectives(task: TaskRow): string {
        const items: HumanDirective[] = [];
        if (task.notes?.trim()) items.push({ at: task.created_at, source: "Task notes", text: task.notes.trim() });
        const label = (s: string | null): string => (s && s in STAGE_DEFS ? STAGE_DEFS[s as Stage].label : (s ?? ""));
        const rounds = this.db.prepare(`SELECT stage, route_to, notes, comments, created_at FROM reviews WHERE task_id = ? AND verdict = 'changes' ORDER BY created_at`).all(task.id) as Array<{
            stage: string;
            route_to: string | null;
            notes: string | null;
            comments: string | null;
            created_at: string;
        }>;
        for (const r of rounds) {
            let comments: LineComment[] = [];
            try {
                comments = r.comments ? (JSON.parse(r.comments) as LineComment[]) : [];
            } catch {
                comments = [];
            }
            const to = r.route_to && r.route_to !== r.stage ? ` → ${label(r.route_to)}` : "";
            items.push({ at: r.created_at, source: `Request changes at ${label(r.stage)}${to}`, text: r.notes ?? "", comments });
        }
        const answered = this.db.prepare(`SELECT questions, answers, answered_at FROM questions WHERE task_id = ? AND answered_at IS NOT NULL ORDER BY answered_at`).all(task.id) as Array<{ questions: string; answers: string | null; answered_at: string }>;
        for (const q of answered) {
            try {
                const qs = (JSON.parse(q.questions) as { questions?: AgentQuestion[] }).questions ?? [];
                const as = q.answers ? (JSON.parse(q.answers) as Record<string, string>) : {};
                const lines = qs.filter((x) => as[x.id]?.trim()).map((x) => `Q: ${x.text}\nA: ${as[x.id]!.trim()}`);
                if (lines.length) items.push({ at: q.answered_at, source: "Answers to the agent's questions", text: lines.join("\n") });
            } catch {
                /* an unreadable row says nothing */
            }
        }
        for (const m of this.listMessages(task.id)) {
            if (m.role !== "user") continue;
            items.push({ at: m.created_at, source: m.kind === "instruction" ? "Chat → Do" : m.anchor ? "Chat, on a line of the diff" : "Chat", text: m.text });
        }
        return renderHumanDirectives(items);
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
            poBrief: ((): string => {
                const p = join(taskDir, "po-brief.md");
                const text = existsSync(p) ? readFileSync(p, "utf8").trim() : "";
                return text
                    ? `## The Product Owner's brief on this ticket\n\nThe project's Product Owner wrote this from what it knows of the project (decisions, comments, related tickets): what to pay attention to beyond the ticket text. It is context, not new requirements — the ticket and the human decide. Check every claim it makes about the code.\n\n${text}`
                    : "";
            })(),
            envPath: env.path,
            baseBranch: this.baseBranchLabel(task, env),
            repoLayout: describeRepoLayout(this.layoutOf(task, env), task.worktree_path),
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
            humanDirectives: this.humanDirectives(task),
            askHuman: askHumanBlock(taskDir),
            attempt: String(opts.attempt ?? 1),
            maxTurns: String(def.maxTurns ?? 100),
            outputFile: def.outputFile ?? "",
            shardNote: "",
            ...((): Record<string, string> => {
                const p = join(this.cfg.gstackDir, "review", "checklist.md");
                const installed = existsSync(p);
                return {
                    gstackChecklist: installed
                        ? `Read the checklist at \`${p}\` first (gstack's pre-landing review checklist): its categories, its "DO NOT flag" list and its Fix-First heuristic bind this review, with the per-environment configuration below.`
                        : `The gstack checklist is not installed (expected at ${p}; \`git clone --depth 1 https://github.com/garrytan/gstack.git ${this.cfg.gstackDir}\`). Apply the categories below from what you know.`,
                    // Which categories run here: envs.review_checklist (built-ins switched off, points added, extra do-not-flag rules).
                    reviewCategories: describeReviewChecklist(env, installed),
                };
            })(),
            seedHints: env.qa_seed_hints?.trim() ? env.qa_seed_hints.trim() : "(none configured for this environment — inspect the repo's configs/ and models to find the local database and API)",
            seedReport: "(no shell seeds were run)",
            resumeHint: "",
            components: this.describeComponents(task, env, def.stage),
            ...(opts.extraVars ?? {}),
        };
        if (def.stage === "pr_fix" && isPrShard(opts.shard)) {
            const sh = opts.shard;
            vars["failureOutput"] = sh.failureOutput;
            vars["outputFile"] = `pr_fix.${sh.id || "root"}.json`;
            vars["askHuman"] = askHumanBlock(taskDir, `questions.pr_fix.${sh.id || "root"}.json`);
            vars["shardNote"] =
                `**This run covers the \`${sh.repo || "."}\` repository only, in a fresh session.** The other repositories of this task are being fixed by other runs at the same time — do not touch their directories. ` +
                `For context read \`${taskDir}/design.md\` and \`${taskDir}/impl.json\` (what was built and why) before changing code.`;
        }
        if (def.stage === "qa_baseline" || def.stage === "manual_qa") {
            const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
            // A resumed pass (after the human's answers, or an unblock retry) drives only the scenarios still open;
            // a shard of a parallel pass only its own.
            const resumeOnly = opts.extraVars?.["resumeOnly"];
            const shard = opts.shard;
            const scenarios: QaScenario[] = this.qaScenariosForPass(design, def.stage)
                .filter((s) => !resumeOnly || resumeOnly.split(",").includes(s.id))
                .filter((s) => !shard || shard.scenarios.includes(s.id));
            const pass = def.stage === "qa_baseline" ? "before" : "after";
            const files = shardFiles(pass, shard);
            vars["pass"] = pass;
            vars["outputFile"] = files.output;
            vars["partialFile"] = files.partial;
            vars["askHuman"] = askHumanBlock(taskDir, files.questions);
            vars["shardNote"] = shard
                ? `**This run is shard \`${shard.id}\` of the pass: it drives only ${scenarios.map((s) => s.id).join(", ")}.** The other scenarios of the pass run at the same time in other runners${shard.browser ? " and other browser windows" : ""}; every scenario's records carry its own id, so never read, change or delete records that belong to another scenario, never restart the BE/FE or a component, and write only your own output file named in the contract below.`
                : "";
            // Shards resume nothing themselves: the group merges what the others recorded.
            if (shard) vars["resumeHint"] = "";
            vars["passHint"] =
                def.stage === "qa_baseline"
                    ? " — the change is NOT implemented yet; expect asserts about new behaviour to fail. Record what the app does today."
                    : " — the change is implemented; every assert is expected to hold.";
            const be = this.services.get(task.id, "be");
            const fe = this.services.get(task.id, "fe");
            const appUrl = this.appUrlFor(task, env);
            vars["appUrl"] = appUrl;
            vars["chromeSelect"] = this.chromeSelectStep(this.browserAccounts(env).find((a) => a.id === task.account_id) ?? this.browserAccounts(env)[0] ?? null, this.clones.get(this.cloneKey(task.id, shard)));
            const firstBrowser = scenarios.find((s) => (s.kind ?? "browser") === "browser");
            vars["firstUrl"] = firstBrowser?.url ?? "/";
            const beUrl = be?.url ?? "";
            const gstackRun = !!firstBrowser && this.qaEngine(env) === "gstack";
            vars["browserNotes"] = gstackRun
                ? [
                      `- **Browser mapping for this run (overrides every tool name in the bullets below):** \`browser_batch\`, \`computer\`, \`find\`, \`read_page\`, \`get_page_text\`, \`javascript_tool\`, \`tabs_context_mcp\` and \`resize_window\` do not exist here — the browser is gstack's headless Chromium, driven with the \`$B\` command in Bash: \`$B snapshot -i\` instead of find/read_page, \`$B click @eN\` / \`$B fill @eN "text"\` / \`$B press Enter\` instead of computer, \`$B text\` instead of get_page_text, \`$B js "<expr>"\` instead of javascript_tool, \`$B screenshot <path>\` for shots. One Bash call may chain several \`$B\` commands with \`&&\` (that is your "batch"). No zoom check, no tab juggling, no "hidden tab" rule: there is one headless tab.`,
                      `- **Reading a page:** after every navigation or click that loads data, \`$B wait --networkidle\` then \`$B snapshot -i\` (interactive elements as \`@e1\`…; add \`-C\` for clickable elements outside the ARIA tree, \`@c1\`…). Refs change after a navigation: re-snapshot before clicking. Dropdowns and pickers: click the trigger, snapshot, click the option ref; type-to-filter with \`$B fill\` on the search box first. Tables: \`$B text\` or \`$B html <css selector>\`. Console errors: \`$B console --errors\`; requests: \`$B network\`.`,
                  ].join("\n")
                : "";
            // The browser steps of the setup only when a scenario drives a browser; an API-only pass must not touch Chrome.
            vars["browserSetup"] = gstackRun
                ? [
                      `1. This run drives gstack's headless Chromium through the \`$B\` command in Bash (\`$B\` and \`$BROWSE_STATE_FILE\` are already set in your environment; the daemon is up). Do NOT load or call any \`mcp__claude-in-chrome__*\` tool. Run \`$B viewport 1440x900\` once.`,
                      `2. The session is already logged in — its cookies were imported from the QA Chrome profile. Navigate: \`$B goto ${appUrl}${firstBrowser.url}\`, then \`$B wait --networkidle\`. If \`goto\` reports a timeout, the dev server is still compiling that page: \`$B wait --load\`, then repeat the goto once. If the page is a sign-in page (an email box, "Continue with…" buttons) or an identity-provider domain, the session did not carry over: write the output file with every browser scenario \`blocked\`, \`blockers: ["login required in the QA browser"]\`, and stop (API scenarios still run).`,
                      `3. Screenshots for steps marked **shot**: \`$B screenshot ${taskDir}/qa/${pass}/<scenario id>-<step number>.png\` (create the directory first; PNG, and use that path in \`shots\`). A step marked shot without a saved file is a failure.`,
                      `4. If a page shows a connection error, retry once after 5 seconds (\`sleep 5 && $B reload\`), then record \`blocked\` with the error.`,
                  ].join("\n")
                : firstBrowser
                ? [
                      `1. ${vars["chromeSelect"]} Then load the browser tools in ONE ToolSearch call: \`select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__browser_batch\`. If \`tabs_context_mcp\` errors with "extension is not connected", wait 5 seconds and call it once more before giving up (blocker: "browser extension not connected").`,
                      `2. Call \`tabs_context_mcp\` once, then \`tabs_create_mcp\` — do not reuse existing tabs. **Work in that one tab for the whole run and never create another** (a second tab drops yours into the background, where Chrome stops rendering popovers — that looks like an app bug and is not one; if a popover opens empty, check \`document.visibilityState\` with \`javascript_tool\`: \`hidden\` = record \`blocked\` with blocker \`app tab hidden in Chrome\`). Never call \`resize_window\` to change the viewport (it zooms the page instead). After the first page load run \`javascript_tool\` once with \`({ zoom: Math.round(outerWidth / innerWidth * 100), ow: outerWidth, oh: outerHeight })\`; if \`zoom\` is outside 95–105: \`resize_window\` with exactly \`ow\` × \`oh\`, then if still off \`computer\` \`action: "key"\`, \`text: "cmd+0"\`; only if both fail add the blocker "page zoom is <zoom>% in the QA Chrome profile and could not be reset — press ⌘0 on the app tab" and continue (\`devicePixelRatio\` is not a zoom signal; a zoom you corrected is not mentioned in the output).`,
                      `3. The app base URL is \`${appUrl}\`; every browser scenario URL below is relative to it. Navigate to \`${appUrl}${firstBrowser.url}\`. If the page redirects to the identity provider's login page, or shows a splash/"Sign in"/welcome page instead of the application, wait 5 seconds and re-read once (silent auth may still be completing); if it is still a login page, the app needs a login that you must NOT perform: write the output file with every browser scenario \`blocked\`, \`blockers: ["login required in the automation Chrome window"]\`, and stop (API scenarios still run).\n   **Login callback on the wrong port:** if the tab ends up on \`https://localhost:<another port>/?code=…&state=…\` (not the port of \`${appUrl}\`, usually an error page), the login itself succeeded; navigate the SAME tab to \`${appUrl}/?code=…&state=…\` with the identical query string (call \`tabs_context_mcp\` to read the exact URL). The app then completes the login and shows the requested page; continue normally.`,
                      `4. If a page shows a connection error, retry once after 5 seconds, then record \`blocked\` with the error.`,
                  ].join("\n")
                : `1. Every scenario below is an **API scenario**: this pass needs no browser — do NOT load or call any \`mcp__claude-in-chrome__*\` tool. The backend answers at \`${beUrl || "(see the BE log for its port)"}\`, the frontend at \`${appUrl}\`; the commands below already carry the right host and port.`;
            const qaVars: QaVars = { beUrl, feUrl: fe?.url ?? "", appUrl, qaPass: opts.extraVars?.["qaPass"] ?? "" };
            const fill = (s: string): string => fillQaVars(s, qaVars);
            vars["qaPass"] = qaVars.qaPass;
            const logs = [be ? `BE log: ${be.log_path}` : null, fe ? `FE log: ${fe.log_path}` : null].filter(Boolean).join("; ");
            vars["qaSetup"] = `0. The app was started by the orchestrator from this task's worktree and should be serving at ${appUrl}${logs ? ` (${logs} — read them with Bash \`tail\` when something looks wrong)` : ""}; if it is not reachable, write every scenario as \`blocked\` with blocker "app not running at <url>" and stop.`;
            vars["scenarios"] = scenarios
                .map(
                    (s) =>
                        ((s.kind ?? "browser") === "api"
                            ? `### ${s.id} — ${s.title} (API scenario — run each step's command with Bash, exactly as written)\nEndpoint: \`${s.url}\` · Caller: ${s.persona}\n`
                            : `### ${s.id} — ${s.title}\nStart: \`${s.url}\` · Persona: ${s.persona}\n`) +
                        ((s.seed ?? []).length
                            ? `Seed:\n${((): string => {
                                  let afterUi = false;
                                  return (s.seed ?? [])
                                      .map((x, i) => {
                                          const shell = /^\s*(shell|sql)\s*:/i.test(x);
                                          if (!shell) afterUi = afterUi || /^\s*ui\s*:/i.test(x);
                                          const tag = shell ? (afterUi ? "run it yourself: ONE Bash call, exact command, after the ui steps" : "run by the orchestrator — see the seed report") : "do this yourself";
                                          return `- seed ${i + 1} (${tag}): ${fill(x)}`;
                                      })
                                      .join("\n");
                              })()}\n`
                            : "Seed: nothing beyond a logged-in user.\n") +
                        ((s.teardown ?? []).length ? `Teardown: ${(s.teardown ?? []).length} step(s) already run by the orchestrator before the seeds — this scenario's fixture set was reset; anything left is not from this pass.\n` : "") +
                        (def.stage === "qa_baseline" && s.baseline === false
                            ? "**New surface:** the change adds this scenario's page, control or endpoint, so it does not exist yet. Run the seeds and every step up to the new surface. The step that needs it is expected to fail: record `fail` with what you saw (the 404, the missing control). Record `blocked` only when a seed, the teardown, the login or an earlier step fails.\n"
                            : "") +
                        s.steps
                            .map((st, i) =>
                                (s.kind ?? "browser") === "api"
                                    ? `${i + 1}. run:\n\`\`\`bash\n${fill(st.action)}\n\`\`\`\n   → **assert:** ${fill(st.assert)}`
                                    : `${i + 1}. ${fill(st.action)} → **assert:** ${fill(st.assert)}${st.shot ? " **[shot]**" : ""}`,
                            )
                            .join("\n"),
                )
                .join("\n\n");
        }
        return vars;
    }

    dispatch(taskId: string, stage: Stage, opts: DispatchOpts = {}): void {
        const task = this.getTask(taskId);
        if (!task) return;
        // A preview instance shares the data dir with the live server; only the live one starts runs.
        if (PREVIEW) {
            console.log(`[stagehand] preview instance: ${task.ticket_id} ${stage} not dispatched — use the live app`);
            return;
        }
        const def = STAGE_DEFS[stage];
        if (!def.prompt) return;
        // A continuation of an earlier dispatch (BE/FE brought up, seeds run, Chrome checked) must not start the run
        // when the task was stopped or moved to another stage meanwhile (INV-132, 2026-09-22: Stop during "starting
        // BE/FE", the human moved the task to User Review, and a Manual QA run began a minute later anyway).
        if ((opts.onBase || opts.servicesReady || opts.seedsDone || opts.chromeVerified || opts.chromeFlagsVerified) && (task.status === "stopped" || task.stage !== stage)) {
            console.log(`[stagehand] ${task.ticket_id}: dropped a ${def.label} continuation — task is ${task.status} at ${task.stage}`);
            return;
        }
        // Nothing runs against a database the env does not allow (db-hosts.ts).
        if (!opts.dbHostsChecked && task.worktree_path) {
            const env0 = this.env(task.env_id);
            if (env0.db_hosts_command?.trim()) {
                void assertDbHosts(env0, task.worktree_path, taskDbExpect(this.db, task, env0))
                    .then(() => this.dispatch(taskId, stage, { ...opts, dbHostsChecked: true }))
                    .catch((e: unknown) => this.setTaskStatus(taskId, "blocked", `${def.label} · ${String((e as Error).message ?? e).slice(0, 300)}`, { notify: true }));
                return;
            }
        }
        // The QA baseline records what the app does BEFORE the change: it runs on base code. Every other run needs the
        // branch, so a worktree still on the base goes back first.
        if (stage === "qa_baseline" && !opts.onBase && !opts.shard && !this.baseCheckout.isOn(taskId)) {
            void this.toBase(taskId).then((ok) => ok && this.dispatch(taskId, stage, { ...opts, onBase: true }));
            return;
        }
        if (stage !== "qa_baseline" && this.baseCheckout.isOn(taskId)) {
            void this.fromBase(taskId).then((ok) => ok && this.dispatch(taskId, stage, opts));
            return;
        }
        if (stage === "pr_creation_review" && this.skipPrCreationIfDone(taskId)) return;
        // A PR Fix round parked on a rate limit comes back through here without its shard: replay the round.
        if (stage === "pr_fix" && !opts.shard) {
            const q = this.queuedPrRounds.get(taskId);
            if (q) {
                this.queuedPrRounds.delete(taskId);
                this.startPrRound(taskId, q.jobs, { attempt: q.attempt, contractAttempt: q.contractAttempt, operation: q.operation, ...(opts.notes ? { notes: opts.notes } : {}) });
                return;
            }
        }
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
                    .catch((e: unknown) => this.setTaskStatus(taskId, "blocked", `${def.label} · ${String((e as Error).message ?? e).slice(0, 300)}`));
                return;
            }
        }
        const env = this.env(task.env_id);
        const cd = this.configDirOf(env);
        // Services and seeds apply to every QA pass; the Chrome machinery only when a scenario actually drives a browser.
        const browserNeeded = def.chrome === true && (opts.shard ? opts.shard.browser : this.qaNeedsBrowser(taskId));
        // gstack's headless daemon replaces the Chrome profile machinery below: no window, no copy, no extension bridge,
        // and the run needs no browser login — it runs on the token account like any headless stage.
        const gstack = browserNeeded && this.qaEngine(env) === "gstack";
        const gstackState = gstack ? this.gstackStateFile(taskId, opts.shard) : null;
        const chromeNeeded = browserNeeded && !gstack;
        // A shard of a parallel QA pass: a gate that blocks the task records the shard as failed (the group decides
        // what happens once every shard is in), a capacity gate puts it back in the group's queue.
        const shard = opts.shard;
        const cloneKey = this.cloneKey(taskId, shard);
        const blockOrAbort = (line: string, result?: ShardResult): void => {
            if (shard) this.shardAbort(shard, result ?? { kind: "failed", error: `${shard.id}: ${line}` });
            else this.setTaskStatus(taskId, "blocked", line);
        };
        if (chromeNeeded && !cd.chrome_capable) {
            blockOrAbort(`${def.label} · config dir ${cd.name} has no Chrome connection — probe it on the Config dirs page, then retry`);
            return;
        }
        if (def.chrome && !opts.seedsDone) {
            const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
            const forPass = this.qaScenariosForPass(design, stage);
            // One pass id for this QA run, shared by the seeds run here and the scenario text the runner gets, so a
            // `{{qaPass}}` in a seed and in an assert resolve to the same value.
            const qaPass = opts.extraVars?.["qaPass"] ?? newQaPassId(def.stage === "qa_baseline" ? "qa_baseline" : "manual_qa");
            const resumeOnly = opts.extraVars?.["resumeOnly"]?.split(",").filter(Boolean);
            const only = new Set(forPass.map((s) => s.id).filter((id) => !resumeOnly || resumeOnly.includes(id)));
            // A task on its own database: a QA step that names the template would seed (or tear down) the template.
            const tdb = taskDbRow(this.db, task.id);
            if (tdb?.status === "ready") {
                const hits = forPass.filter((s) => only.has(s.id)).flatMap((s) => [...(s.teardown ?? []).map((t, i) => [`${s.id} teardown ${i + 1}`, t]), ...(s.seed ?? []).map((t, i) => [`${s.id} seed ${i + 1}`, t]), ...(s.steps ?? []).map((t, i) => [`${s.id} step ${i + 1}`, t.action])].filter(([, text]) => namesTemplate(text!, tdb.template)).map(([where]) => where!));
                if (hits.length) {
                    this.setTaskStatus(taskId, "blocked", `${def.label} · design.json names the template database ${tdb.template} (${hits.slice(0, 6).join(", ")}${hits.length > 6 ? ", …" : ""}) — those steps would write to the template, not this task's database ${tdb.name}; use $STAGEHAND_TASK_DB in them, then Retry`, { notify: true });
                    return;
                }
            }
            // Teardown, then seed steps written as commands are run here, without an agent; only `ui:` steps reach the QA runner.
            this.setTaskStatus(taskId, "running", `${def.label} · resetting and seeding data`);
            void this.refreshQaSession(task, env)
                .then(() => this.runShellSeeds(task, env, def, qaPass, { only }))
                .then((report) => this.dispatch(taskId, stage, { ...opts, seedsDone: true, extraVars: { ...(opts.extraVars ?? {}), seedReport: report, qaPass } }))
                .catch((e: unknown) => this.setTaskStatus(taskId, "blocked", `${def.label} · seeding failed: ${String((e as Error).message ?? e).slice(0, 160)}`));
            return;
        }
        // A QA run with no session yet (a resumed or answered pass, after a restart): sign in first.
        if (def.chrome && !opts.sessionReady && env.qa_session_command?.trim() && !this.qaSessions.has(task.id)) {
            void this.refreshQaSession(task, env)
                .then(() => this.dispatch(taskId, stage, { ...opts, sessionReady: true }))
                .catch((e: unknown) => this.setTaskStatus(taskId, "blocked", `${def.label} · ${String((e as Error).message ?? e).slice(0, 200)}`));
            return;
        }
        // Seeds are in: a pass with more than one shard runs as a group of parallel runs from here (qa-shards.ts).
        const planned = opts.cloneReady || opts.cloneFailed || opts.chromeVerified || opts.chromeFlagsVerified;
        if (def.chrome && !shard && !planned && this.cfg.qaShards > 0 && this.startShards(task, env, def, stage, opts)) return;
        const picked = this.pickAccount(task, def, env, cd);
        if (!picked) {
            blockOrAbort(`no AI account can run in config dir ${cd.name} — set up a token on the AI accounts page`);
            return;
        }
        // Browser stages run under an account's browser login (no token), in that account's browser dir with the env's
        // config dir mirrored in; the env's priority list picks the account, so they fail over like any other stage.
        let account = picked;
        let runAuth: Record<string, string> = authEnv(picked);
        let runDir = cd.path;
        if (gstack && gstackState && !opts.gstackReady) {
            this.setTaskStatus(taskId, "running", `${def.label}${shard ? ` · ${shard.id}` : ""} · starting the headless QA browser`);
            void this.prepareGstackBrowser(task, env, gstackState)
                .then((note) => {
                    if (note) this.addAgentNote(taskId, note);
                    this.dispatch(taskId, stage, { ...opts, gstackReady: true });
                })
                .catch((e: unknown) => blockOrAbort(`${def.label} · the headless QA browser did not start: ${String((e as Error).message ?? e).slice(0, 200)}`));
            return;
        }
        if (chromeNeeded) {
            const chrome = this.chromeContext(env, cd, task);
            if (!chrome.ok) {
                // Every Chrome-ready account is at its cap: park with a resume time rather than blocking (the list was already tried).
                if (shard) this.shardAbort(shard, chrome.exhausted ? { kind: "rate_limited", resetsAt: chrome.exhausted.resetsAt } : { kind: "failed", error: `${shard.id}: ${chrome.reason}` });
                else if (chrome.exhausted) this.queueRateLimited(task, chrome.exhausted.account, chrome.exhausted.resetsAt, `${def.label} · ${chrome.reason}`, { failover: false });
                else this.setTaskStatus(taskId, "blocked", `${def.label} · ${chrome.reason}`);
                return;
            }
            // Accounts that clone their QA profile per run: several browser runs at once, each in its own Chrome
            // started with the QA flags — no shared-profile queue, no launch-flag check; the bridge confirmation is
            // part of preparing the copy. A failed copy falls back to the shared profile for this dispatch.
            const cloneSource = opts.cloneFailed ? null : this.cloneSourceFor(chrome.account);
            if (cloneSource && !(opts.cloneReady && this.clones.has(cloneKey))) {
                if (this.clonesOf(chrome.account.id) >= this.cfg.maxChromeClonesPerAccount) {
                    if (shard) {
                        this.shardDefer(shard);
                        return;
                    }
                    this.setTaskStatus(taskId, "idle", `queued · ${chrome.account.name} already runs ${this.cfg.maxChromeClonesPerAccount} cloned Chrome window(s) (maxChromeClonesPerAccount in config.json)`);
                    this.parkQueued(taskId, stage, opts);
                    return;
                }
                this.setTaskStatus(taskId, "running", `${def.label}${shard ? ` · ${shard.id}` : ""} · copying Chrome profile "${chromeBrowserLabel(cloneSource)}" for this run`);
                this.cloning.set(chrome.account.id, (this.cloning.get(chrome.account.id) ?? 0) + 1);
                void this.prepareClone(task, chrome.account, cloneSource, chrome.configDir, this.appUrlFor(task, env))
                    .finally(() => this.cloning.set(chrome.account.id, Math.max(0, (this.cloning.get(chrome.account.id) ?? 1) - 1)))
                    .then((clone) => {
                        // A parallel dispatch of the same task (shard) may have prepared its own copy first: one copy per key.
                        if (this.clones.has(cloneKey)) void quitClone(clone);
                        else this.clones.set(cloneKey, { ...clone, accountId: chrome.account.id });
                        this.dispatch(taskId, stage, { ...opts, cloneReady: true, chromeVerified: true, chromeFlagsVerified: true });
                    })
                    .catch((e: unknown) => {
                        this.addAgentNote(taskId, `No cloned Chrome profile for this run${shard ? ` (shard ${shard.id})` : ""} (${String((e as Error).message ?? e).slice(0, 200)}) — running in the shared QA profile instead.`);
                        this.dispatch(taskId, stage, { ...opts, cloneFailed: true });
                    });
                return;
            }
            // One account = one Chrome profile = one extension bridge: while another task's browser run drives it, this
            // task waits — checked BEFORE the live probe below, because a probe against a Chrome that is mid-run can
            // fail and would then wrongly mark the account as not Chrome-capable (seen on INV-63 vs INV-130, 2026-09-17).
            // A shard without a copy of its own (cloning failed, or a shared profile) shares the one Chrome with every
            // other browser run — its sibling shards included (INV-63, 2026-09-22: three shards drove one profile).
            const chromeBusy = cloneSource ? null : this.runningBrowserRun(chrome.account.id, shard ? "" : taskId);
            if (chromeBusy) {
                if (shard) {
                    this.shardDefer(shard);
                    return;
                }
                this.setTaskStatus(taskId, "idle", `queued · ${chrome.account.name}'s Chrome is busy with ${chromeBusy.ticket_id} (${STAGE_DEFS[chromeBusy.stage]?.label ?? chromeBusy.stage}) — browser stages run one at a time per account`);
                this.parkQueued(taskId, stage, opts);
                return;
            }
            // A Chrome started from the Dock runs without QA_CHROME_FLAGS: the moment the human's own windows cover the
            // automation window, its pages stop animating and query-backed pickers render nothing (see chrome-profiles).
            // Cheap ps check; the fix is one relaunch, which only the human should trigger (it closes their Chrome).
            if (!opts.chromeFlagsVerified) {
                const picked = this.qaBrowser(task, env);
                const browserKind = "browser" in picked ? (picked.browser.browser ?? "Google") : "Google";
                void chromeHasQaFlags(browserKind)
                    .then((ok) => {
                        if (ok) {
                            this.dispatch(taskId, stage, { ...opts, chromeFlagsVerified: true });
                            return;
                        }
                        blockOrAbort(`${def.label} · Chrome is running without ${QA_CHROME_FLAGS.join(" ")}, so its pages freeze whenever another window covers the QA window (pickers open empty) — click Relaunch Chrome for QA (quits and reopens Chrome with the flags; tabs restore), which retries this stage`);
                    })
                    .catch((e: unknown) => blockOrAbort(`${def.label} · could not inspect Chrome's launch flags: ${String((e as Error).message ?? e).slice(0, 160)}`));
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
                        // Only the capability flag drops; the device id / profile stay so a relaunch can reopen that profile.
                        this.db.prepare(`UPDATE accounts SET chrome_capable = 0 WHERE id = ?`).run(chrome.account.id);
                        blockOrAbort(`${def.label} · Chrome extension is not connected for ${chrome.account.name} (checked ${chrome.configDir}) — open Chrome, confirm the extension is installed and signed into this account, then AI accounts → Probe Chrome`);
                    })
                    .catch((e: unknown) => blockOrAbort(`${def.label} · Chrome check failed: ${String((e as Error).message ?? e).slice(0, 160)}`));
                return;
            }
            account = chrome.account;
            runAuth = chrome.extraEnv;
            runDir = chrome.configDir;
            if (task.account_id !== account.id) this.db.prepare(`UPDATE tasks SET account_id = ?, updated_at = ? WHERE id = ?`).run(account.id, now(), taskId);
        }
        const util = this.utilization(account.id);
        if (util && util.utilization >= this.cfg.preflightUtilizationLimit) {
            if (shard) this.shardAbort(shard, { kind: "rate_limited", resetsAt: util.resetsAt });
            else this.queueRateLimited(task, account, util.resetsAt, `pre-flight: ${account.name} at ${Math.round(util.utilization * 100)}% of 5h window`);
            return;
        }
        // Headless stages run side by side up to the configured number per account (the only shared thing is the
        // account's rate-limit window). Browser stages are different: one account = one Chrome profile = one
        // extension bridge, so two of them at once would drive the same browser — they run one at a time per account.
        const browserBusy = chromeNeeded && !this.clones.has(cloneKey) ? this.runningBrowserRun(account.id, shard ? "" : taskId) : null;
        if (browserBusy) {
            if (shard) {
                this.shardDefer(shard);
                return;
            }
            this.setTaskStatus(taskId, "idle", `queued · ${account.name}'s Chrome is busy with ${browserBusy.ticket_id} (${STAGE_DEFS[browserBusy.stage]?.label ?? browserBusy.stage}) — browser stages run one at a time per account`);
            this.parkQueued(taskId, stage, opts);
            return;
        }
        if (this.runningCount(account.id) >= this.cfg.maxConcurrentRunsPerAccount) {
            if (shard) {
                this.shardDefer(shard);
                return;
            }
            this.setTaskStatus(taskId, "idle", `queued · ${account.name} already has ${this.cfg.maxConcurrentRunsPerAccount} run(s) going (maxConcurrentRunsPerAccount in config.json)`);
            this.parkQueued(taskId, stage, opts);
            return;
        }
        this.queuedOpts.delete(`${taskId}:${stage}`);

        // Two top-level dispatches of one task (a Retry click plus an automatic re-dispatch, two clicks) prepare in
        // parallel for up to a minute (BE/FE, seeds, Chrome copy, probe); only the first to get here starts a run
        // (PRODUCT-10502, 2026-09-22: two Manual QA sessions drove two cloned Chromes at once). The shards of one
        // parallel QA pass are the exception: they run beside each other.
        const already = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND status = 'running' AND (group_id IS NULL OR group_id != ?)`).get(taskId, shard?.group ?? "") as { n: number };
        if (already.n > 0) {
            console.log(`[stagehand] ${task.ticket_id}: ${def.label}${shard ? ` (shard ${shard.id})` : ""} already has a run going — duplicate dispatch dropped`);
            if (shard) this.shardAbort(shard, { kind: "failed", error: `${shard.id}: another run of this task was already going` });
            return;
        }
        const runId = randomUUID();
        const attempt = opts.attempt ?? 1;
        const fresh = def.freshSession === true || isPrShard(shard);
        this.dismissPendingQuestions(taskId);
        const priorRuns = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND kind = 'task-session'`).get(taskId) as { n: number };
        const vars = this.promptVars(task, def, opts);
        const prompt = renderPrompt(def.prompt, vars);
        const eventLogPath = join(this.cfg.dataDir, "runs", `${runId}.ndjson`);
        const explicitModel = this.modelForStage(task, def.stage, opts, account);
        // A resumed session answers on the model of the run that last spoke in it: a side run on another model (the
        // service fix on Haiku that rotated INV-136's session, 2026-09-24) would otherwise set the model of every stage
        // run after it — and Haiku refuses every edit (permissionProblem). A task-session run therefore always names
        // its model: the account's known default when the settings leave the stage open.
        const pinnedModel = explicitModel ?? (fresh ? null : account.default_model);

        this.db
            .prepare(
                `INSERT INTO runs (id, task_id, stage, kind, status, account_id, started_at, attempt, model, shard, group_id)
                 VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
            )
            .run(runId, taskId, stage, fresh ? "fresh-session" : "task-session", account.id, now(), attempt, explicitModel, shard?.id ?? null, shard?.group ?? null);
        if (shard) this.shardStarted(shard, runId);
        const label = shard ? `${def.label} · ${shard.id}` : def.label;
        this.setTaskStatus(taskId, "running", `${label} · starting`);

        const rulesMat = materializeRules(rulesOf(cd), env, task.worktree_path, this.cfg.dataDir);
        const run = startClaude({
            prompt,
            cwd: task.worktree_path ?? env.path,
            configDir: runDir,
            extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, task.id), ...this.qaSessionEnv(task.id, def), ...runAuth, ...(gstackState ? { BROWSE_STATE_FILE: gstackState, B: this.gstackBin() ?? "", GSTACK_TELEMETRY_OFF: "1" } : {}) },
            settingsPath: rulesMat.settingsPath,
            appendSystemPrompt: rulesMat.systemPrompt,
            ...(isPrShard(shard)
                ? (opts.continuations ?? 0) > 0
                    ? { resume: shard.sessionId }
                    : { sessionId: shard.sessionId, name: `${task.ticket_id}-${shard.id || "root"}` }
                : fresh
                  ? {}
                  : this.sessionArgs(task)),
            chrome: chromeNeeded,
            ...(pinnedModel ? { model: pinnedModel } : {}),
            ...(def.maxTurns ? { maxTurns: def.maxTurns } : {}),
            addDirs: [this.taskDir(taskId)],
            eventLogPath,
        });
        this.active.set(runId, run);
        this.db.prepare(`UPDATE runs SET pid = ? WHERE id = ?`).run(run.pid ?? null, runId);
        // While a browser run drives the app, keep the tab it drives in the foreground of its window (see
        // activateChromeTab): the runner works in whatever tab it created, and a later tabs_create leaves an empty
        // new tab active in front of it — from then on every popover opens into a throttled, hidden document.
        const tabKeeper = chromeNeeded ? this.startTabKeeper(task, env, cloneKey) : null;

        let seenModel: string | null = null;
        let learned = false;
        run.on("activity", (ev: ActivityEvent) => {
            // A FRESH session without --model shows what this account's default really is (the first assistant message
            // names the model; init may leave it null). A resumed session only repeats the model it was created with —
            // learning from it recorded Haiku as the personal account's default (INV-136, 2026-09-24).
            if (fresh && !pinnedModel && !learned) {
                const raw = ev.raw as { type?: unknown; model?: unknown; message?: { model?: unknown } };
                const model = raw.type === "assistant" ? raw.message?.model : ev.kind === "init" ? raw.model : undefined;
                if (typeof model === "string" && model) {
                    learned = true;
                    this.db.prepare(`UPDATE accounts SET default_model = ? WHERE id = ?`).run(model, account.id);
                }
            }
            const rawModel = (ev.raw as { model?: unknown; message?: { model?: unknown } }).model ?? (ev.raw as { message?: { model?: unknown } }).message?.model;
            if (typeof rawModel === "string" && rawModel) seenModel = rawModel;
            // The CLI came up in a permission mode that refuses edits, or refused one (Haiku falls back to "default"
            // silently): kill the run at once — every edit after this is refused too, the turns are wasted, and the
            // stale output file would pass for this run's (INV-136, 2026-09-24: 70 turns of refused edits, "done").
            const problem = ev.raw && typeof ev.raw === "object" ? permissionProblem(ev.raw as Record<string, unknown>) : null;
            if (problem && !this.permissionFailures.has(runId)) {
                const model = seenModel ?? pinnedModel ?? "the account's default";
                this.permissionFailures.set(
                    runId,
                    `${problem} (model: ${model}). A headless run cannot grant a permission, so nothing it edits lands; Haiku does not honour --permission-mode auto. Give this stage (Settings → models) or the task a Sonnet, Opus or Fable model, then Retry.`,
                );
                run.kill();
                return;
            }
            if (ev.kind === "tool_use" || ev.kind === "text") {
                this.db.prepare(`UPDATE runs SET last_event = ? WHERE id = ?`).run(ev.summary, runId);
                this.db.prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`).run(`${label} · ${ev.summary}`, now(), taskId);
                this.emit("activity", { taskId, runId, event: ev });
                this.emitTask(taskId);
            }
            // Background commands the CLI stopped after the final reply: the agent ended its turn with work pending.
            const raw = ev.raw as { type?: unknown; subtype?: unknown; status?: unknown };
            if (raw.type === "result") resultSeen = true;
            else if (resultSeen && raw.type === "system" && raw.subtype === "task_notification" && raw.status === "stopped") stoppedBackground += 1;
        });
        let resultSeen = false;
        let stoppedBackground = 0;
        run.on("rate_limit", (info: RateLimitInfo) => this.recordRateLimit(account.id, info));

        void run.done.then((outcome) => {
            if (tabKeeper) clearInterval(tabKeeper);
            this.active.delete(runId);
            // The copy served this run only; a retry or unblock makes a fresh one.
            void this.releaseClone(cloneKey);
            if (gstackState) void this.stopGstackBrowser(gstackState);
            void (isPrShard(shard) ? this.onPrShardClosed(taskId, runId, def, account, outcome, shard, opts, stoppedBackground) : shard ? this.onShardClosed(taskId, runId, def, account, outcome, shard) : this.onRunClosed(taskId, runId, def, account, outcome, opts, stoppedBackground)).catch((e: unknown) => console.warn(`[stagehand] onRunClosed ${taskId}: ${String((e as Error).message ?? e).slice(0, 200)}`));
        });
    }

    // ---------- PR Fix rounds: one run per repository, in parallel ----------

    // Runs killed at their first refused permission (see permissionProblem): run id → the error the closer records.
    private readonly permissionFailures = new Map<string, string>();
    private readonly prGroups = new Map<string, PrGroup>();
    // Rounds parked on a rate limit: replayed by the next dispatch of pr_fix for the task (tick).
    private readonly queuedPrRounds = new Map<string, PrRoundSpec>();

    // Starts a PR Fix round: `jobs` maps a repository directory ("" = the root) to the text of what to fix there.
    // One repository → the task session resumes as before (it remembers the implementation). Several → one fresh
    // session per repository at the same time, each with its own output file; completePrGroup merges them.
    startPrRound(taskId: string, jobs: Record<string, string>, opts: { attempt: number; contractAttempt?: number | undefined; operation: DispatchOpts["operation"]; notes?: string }): void {
        const task = this.getTask(taskId);
        if (!task) return;
        const repos = Object.keys(jobs).filter((r) => jobs[r]?.trim());
        if (repos.length === 0) return;
        const contractAttempt = opts.contractAttempt ?? 1;
        writeFileSync(join(this.taskDir(taskId), "pr_fix_round.json"), JSON.stringify({ jobs, attempt: opts.attempt, contractAttempt, operation: opts.operation } satisfies PrRoundSpec, null, 2));
        if (repos.length === 1) {
            this.dispatch(taskId, "pr_fix", { attempt: opts.attempt, contractAttempt, ...(opts.operation ? { operation: opts.operation } : {}), ...(opts.notes ? { notes: opts.notes } : {}), extraVars: { failureOutput: jobs[repos[0]!]! } });
            return;
        }
        for (const g of [...this.prGroups.values()]) if (g.taskId === taskId) this.prGroups.delete(g.id);
        const groupId = randomUUID();
        const shards: PrShard[] = repos.map((repo) => ({
            kind: "pr",
            group: groupId,
            id: repo,
            repo,
            failureOutput: `${jobs[repo]!.startsWith("Repository:") ? "" : repoScopeNote(repo)}${jobs[repo]!}`,
            sessionId: randomUUID(),
            browser: false,
            phase: "parallel",
            scenarios: [],
        }));
        const g: PrGroup = { id: groupId, taskId, attempt: opts.attempt, contractAttempt, operation: opts.operation, notes: opts.notes, pending: shards, starting: new Set(), running: new Map(), results: new Map() };
        this.prGroups.set(groupId, g);
        this.addAgentNote(taskId, `PR Fix runs as ${shards.length} parallel rounds, one per repository: ${shards.map((s) => repoLabel(s.repo)).join(", ")}.`);
        this.pumpPrGroup(g);
    }

    private pumpPrGroup(g: PrGroup): void {
        if (!this.prGroups.has(g.id)) return;
        const task = this.getTask(g.taskId);
        if (!task || task.status === "stopped" || task.stage !== "pr_fix") {
            this.prGroups.delete(g.id);
            return;
        }
        for (const shard of [...g.pending]) {
            if (!g.pending.includes(shard)) continue;
            g.pending = g.pending.filter((s) => s !== shard);
            g.starting.add(shard.id);
            this.dispatch(g.taskId, "pr_fix", { attempt: g.attempt, contractAttempt: g.contractAttempt, ...(g.operation ? { operation: g.operation } : {}), ...(g.notes ? { notes: g.notes } : {}), shard });
        }
        if (g.running.size === 0 && g.starting.size === 0 && g.pending.length === 0) void this.completePrGroup(g).catch((e: unknown) => console.warn(`[stagehand] completePrGroup ${g.taskId}: ${String((e as Error).message ?? e).slice(0, 200)}`));
    }

    // One repository's run ended: close its row, record what it reported, let the group move on. A run that hit the
    // turn cap without output continues in its own session first (the cap is a checkpoint here too).
    private async onPrShardClosed(taskId: string, runId: string, def: StageDef, account: AccountRow, outcome: RunOutcome, shard: PrShard, opts: DispatchOpts, stoppedBackground = 0): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) return;
        const g = this.prGroups.get(shard.group);
        g?.running.delete(runId);
        if (task.status === "stopped") {
            this.db.prepare(`UPDATE runs SET status = 'stopped', finished_at = ? WHERE id = ?`).run(now(), runId);
            g?.results.set(shard.id, { kind: "stopped" });
            return;
        }
        const finish = (status: RunRow["status"], error?: string, resultJson?: string): void => {
            this.db
                .prepare(`UPDATE runs SET status = ?, finished_at = ?, error = ?, result_json = ?, cost_usd = ?, num_turns = ? WHERE id = ?`)
                .run(status, now(), error ?? null, resultJson ?? null, outcome.result?.total_cost_usd ?? null, outcome.result?.num_turns ?? null, runId);
            if (outcome.result) recordUsage(this.db, { accountId: account.id, envId: task.env_id, taskId, runId, kind: "stage", stage: def.stage }, outcome.result);
            calibrateWindows(this.db, account.id, outcome.firstRateLimit, outcome.lastRateLimit, outcome.result?.total_cost_usd);
        };
        const outputFile = `pr_fix.${shard.id || "root"}.json`;
        const questionsFile = `questions.pr_fix.${shard.id || "root"}.json`;
        let result: PrShardResult;
        const limited = rateLimitHit(outcome.lastRateLimit) && !(outcome.result && !outcome.result.is_error);
        const asked = this.questionsAskedDuringRun(taskId, runId, questionsFile);
        const written = this.outputWrittenDuringRun(taskId, outputFile, runId);
        const parsed = written ? PrFixResult.safeParse(this.readArtifactJson<unknown>(taskId, outputFile)) : null;
        const refused = this.permissionFailures.get(runId);
        if (refused) {
            this.permissionFailures.delete(runId);
            finish("failed", refused);
            result = { kind: "failed", error: `${repoLabel(shard.repo)}: ${refused.slice(0, 500)}` };
        } else if (limited && outcome.lastRateLimit?.resetsAt) {
            finish("rate_limited", "rate limited");
            result = { kind: "rate_limited", resetsAt: outcome.lastRateLimit.resetsAt };
        } else if (asked && !parsed?.success) {
            finish("blocked", `asked the human ${asked.questions.length} question(s)`);
            const q = join(this.taskDir(taskId), questionsFile);
            if (existsSync(q)) renameSync(q, `${q}.asked-${Date.now()}`);
            result = { kind: "asked", questions: asked };
        } else if (parsed?.success) {
            finish("done", outcome.result && !outcome.result.is_error && (outcome.exitCode ?? 1) === 0 ? undefined : `ended with ${outcome.result?.subtype ?? `exit ${outcome.exitCode}`} after writing the output`, JSON.stringify(parsed.data));
            result = { kind: "ok", summary: parsed.data.summary, comments: parsed.data.comments };
        } else if (outcome.result?.subtype === "error_max_turns" && (opts.continuations ?? 0) < MAX_CONTINUATIONS && g) {
            const n = (opts.continuations ?? 0) + 1;
            finish("failed", `turn cap reached (${outcome.result.num_turns ?? "?"} turns) — continuing the session (${n}/${MAX_CONTINUATIONS})`);
            g.starting.add(shard.id);
            this.dispatch(taskId, "pr_fix", { ...opts, shard, continuations: n, notes: continueNote(n, outputFile, g.notes) });
            return;
        } else if (written && parsed && !parsed.success) {
            finish("failed", `contract: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
            result = { kind: "failed", error: `${repoLabel(shard.repo)}: ${outputFile} does not match the contract` };
        } else {
            const stderrTail = outcome.stderr.trim().split("\n").slice(-3).join(" ").trim();
            const err = (stoppedBackground > 0 ? backgroundNote(stoppedBackground) : "") + (outcome.result?.result?.trim() || (outcome.result ? `ended with ${outcome.result.subtype} before writing ${outputFile}` : stderrTail || `exit ${outcome.exitCode}`));
            if (isNetworkError(err) && g && !(g.netRetried ??= new Set()).has(shard.id)) {
                g.netRetried.add(shard.id);
                finish("failed", `${err} — network failure of the run itself; running it once more`);
                g.starting.add(shard.id);
                this.dispatch(taskId, "pr_fix", { ...opts, shard });
                return;
            }
            finish("failed", err);
            result = { kind: "failed", error: `${repoLabel(shard.repo)}: ${err.slice(0, 500)}` };
        }
        if (!g) return;
        g.results.set(shard.id, result);
        this.pumpPrGroup(g);
    }

    // Every repository is in: all fixed → one merged pr_fix.json and the normal PR Fix aftermath (verification command,
    // the human's review of the diff); questions → one round for the human; failures → the failed repositories run
    // again (up to MAX_CONTRACT_ATTEMPTS rounds); a rate limit parks the remaining repositories until the window resets.
    private async completePrGroup(g: PrGroup): Promise<void> {
        this.prGroups.delete(g.id);
        const task = this.getTask(g.taskId);
        if (!task || task.status === "stopped" || task.stage !== "pr_fix") return;
        const taskId = g.taskId;
        const def = STAGE_DEFS.pr_fix;
        const spec = this.readArtifactJson<PrRoundSpec>(taskId, "pr_fix_round.json");
        const summaries: string[] = [];
        const comments: PrFixResult["comments"] = [];
        const asked: Array<{ shard: string; questions: AgentQuestion[] }> = [];
        const failed: Array<{ repo: string; error: string }> = [];
        let rateLimit: number | null = null;
        for (const [repo, r] of g.results) {
            if (r.kind === "stopped") return;
            if (r.kind === "ok") {
                summaries.push(`${repoLabel(repo)}: ${r.summary}`);
                comments.push(...r.comments);
            }
            else if (r.kind === "asked") asked.push({ shard: repoLabel(repo), questions: r.questions.questions });
            else if (r.kind === "failed") failed.push({ repo, error: r.error });
            else if (r.kind === "rate_limited") rateLimit = r.resetsAt ?? rateLimit;
        }
        // Repositories that reported nothing final keep their jobs for the next round; finished ones are done.
        const remaining: Record<string, string> = {};
        for (const repo of Object.keys(spec?.jobs ?? {})) if (g.results.get(repo)?.kind !== "ok") remaining[repo] = spec!.jobs[repo]!;
        if (asked.length === 0 && failed.length === 0 && rateLimit === null) {
            writeFileSync(join(this.taskDir(taskId), def.outputFile!), JSON.stringify({ summary: summaries.join("\n"), comments } satisfies PrFixResult, null, 2));
            const validation = await this.validateOutput(taskId, def);
            if (!validation.ok) {
                this.setTaskStatus(taskId, "failed", `${def.label} · merged pr_fix.json does not validate: ${validation.error.slice(0, 160)}`);
                return;
            }
            this.afterStage(taskId, def, validation.data);
            return;
        }
        if (asked.length) {
            // The answered round runs as one task-session run over the repositories that asked (their jobs combined).
            const questions = mergeQuestions(asked).slice(0, 10);
            const askedRepos = Object.keys(remaining).filter((r) => g.results.get(r)?.kind === "asked");
            const failureOutput = askedRepos.map((r) => remaining[r]!).join("\n\n---\n\n") + (summaries.length ? `\n\nAlready done in this round: ${summaries.join("; ")}` : "");
            this.parkOnQuestions(taskId, null, def, { questions }, { attempt: g.attempt, contractAttempt: g.contractAttempt, ...(g.operation ? { operation: g.operation } : {}), extraVars: { failureOutput } });
            return;
        }
        if (rateLimit !== null) {
            const env = this.env(task.env_id);
            const account = this.pickAccount(task, def, env, this.configDirOf(env));
            this.queuedPrRounds.set(taskId, { jobs: remaining, attempt: g.attempt, contractAttempt: g.contractAttempt, operation: g.operation });
            if (account) this.queueRateLimited(task, account, rateLimit, `${def.label} · rate limited with ${Object.keys(remaining).length} repository round(s) left`, { failover: false });
            else this.setTaskStatus(taskId, "failed", `${def.label} · rate limited and no account to resume on — Retry later`);
            return;
        }
        if (g.contractAttempt < MAX_CONTRACT_ATTEMPTS) {
            const next = g.contractAttempt + 1;
            this.setTaskStatus(taskId, "running", `${def.label} · ${failed.length} repository round(s) ended without a result — running them again (${next}/${MAX_CONTRACT_ATTEMPTS})`);
            this.startPrRound(taskId, remaining, {
                attempt: g.attempt,
                contractAttempt: next,
                operation: g.operation,
                notes: `## The previous round for this repository ended without a usable result — attempt ${next} of ${MAX_CONTRACT_ATTEMPTS}\n\n${failed.map((f) => `- ${f.error}`).join("\n")}\n\nDo the jobs below and write the output file exactly as the contract says.`,
            });
            return;
        }
        this.setTaskStatus(taskId, "failed", `${def.label} · repository rounds kept ending without a result: ${failed.map((f) => f.error).join("; ").slice(0, 200)}`);
    }

    // ---------- parallel QA passes (qa-shards.ts) ----------

    private readonly qaGroups = new Map<string, QaGroup>();

    // Splits the pass into shards and starts them; false when the plan is one shard (the pass runs as one run, as before).
    private startShards(task: TaskRow, env: EnvRow, def: StageDef, stage: Stage, opts: DispatchOpts): boolean {
        const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
        const resumeOnly = opts.extraVars?.["resumeOnly"]?.split(",").filter(Boolean);
        const scenarios = this.qaScenariosForPass(design, stage).filter((s) => !resumeOnly || resumeOnly.includes(s.id));
        const account = this.browserAccounts(env).find((a) => a.id === task.account_id) ?? this.browserAccounts(env)[0] ?? null;
        const cloneMode = !!(account && this.cloneSourceFor(account));
        const groupId = randomUUID();
        const shards = planQaShards(groupId, scenarios, { cloneMode, maxBrowser: cloneMode ? this.cfg.maxChromeClonesPerAccount : 1, maxShards: this.cfg.qaShards });
        if (shards.length <= 1) return false;
        // One group per task at a time: a Retry after a Stop must not leave the old one waiting for shards that never come.
        for (const g of [...this.qaGroups.values()]) if (g.taskId === task.id) this.qaGroups.delete(g.id);
        const g: QaGroup = { id: groupId, taskId: task.id, stage, opts, allIds: scenarios.map((s) => s.id), pending: shards, starting: new Set(), running: new Map(), results: new Map() };
        this.qaGroups.set(groupId, g);
        this.addAgentNote(task.id, `${def.label} runs as ${shards.length} parallel shards: ${shards.map((s) => `${s.id} (${s.scenarios.join(", ")}${s.browser ? "" : ", no browser"}${s.phase === "solo" ? ", alone after the others" : ""})`).join(" · ")}`);
        this.pumpGroup(g);
        return true;
    }

    // Starts every pending shard whose phase is due — parallel shards at once, the solo shard once nothing else of the
    // group is going — and completes the group when nothing is left. A shard a capacity gate defers goes back to
    // `pending` (shardDefer) and is tried again on the next tick or when a run of the group ends.
    private pumpGroup(g: QaGroup): void {
        if (!this.qaGroups.has(g.id)) return;
        const task = this.getTask(g.taskId);
        if (!task || task.status === "stopped" || task.stage !== g.stage) {
            this.qaGroups.delete(g.id);
            return;
        }
        const idle = g.running.size === 0 && g.starting.size === 0;
        const parallelLeft = g.pending.some((s) => s.phase === "parallel");
        const due = g.pending.filter((s) => s.phase === "parallel" || (idle && !parallelLeft));
        for (const shard of due) {
            // A dispatch above may have re-entered this pump (an abort, a deferral) and taken this shard already.
            if (!g.pending.includes(shard)) continue;
            g.pending = g.pending.filter((s) => s !== shard);
            g.starting.add(shard.id);
            this.dispatch(g.taskId, g.stage, { ...g.opts, shard });
        }
        if (g.running.size === 0 && g.starting.size === 0 && g.pending.length === 0) void this.completeGroup(g).catch((e: unknown) => console.warn(`[stagehand] completeGroup ${g.taskId}: ${String((e as Error).message ?? e).slice(0, 200)}`));
    }

    private shardDefer(shard: QaShard | PrShard): void {
        if (isPrShard(shard)) {
            const pg = this.prGroups.get(shard.group);
            if (!pg) return;
            pg.starting.delete(shard.id);
            if (!pg.pending.some((s) => s.id === shard.id)) pg.pending.push(shard);
            return;
        }
        const g = this.qaGroups.get(shard.group);
        if (!g) return;
        g.starting.delete(shard.id);
        if (!g.pending.some((s) => s.id === shard.id)) g.pending.push(shard);
    }

    private shardStarted(shard: QaShard | PrShard, runId: string): void {
        if (isPrShard(shard)) {
            const pg = this.prGroups.get(shard.group);
            if (!pg) return;
            pg.starting.delete(shard.id);
            pg.running.set(runId, shard);
            return;
        }
        const g = this.qaGroups.get(shard.group);
        if (!g) return;
        g.starting.delete(shard.id);
        g.running.set(runId, shard);
    }

    // A gate that would block the task ends this shard instead; the group decides once every shard is in.
    private shardAbort(shard: QaShard | PrShard, result: ShardResult): void {
        if (isPrShard(shard)) {
            const pg = this.prGroups.get(shard.group);
            if (!pg) return;
            pg.starting.delete(shard.id);
            pg.results.set(shard.id, result.kind === "rate_limited" || result.kind === "stopped" ? result : { kind: "failed", error: result.kind === "failed" ? result.error : result.kind });
            setTimeout(() => this.pumpPrGroup(pg), 0);
            return;
        }
        const g = this.qaGroups.get(shard.group);
        if (!g) return;
        g.starting.delete(shard.id);
        g.results.set(shard.id, result);
        console.log(`[stagehand] shard ${shard.id} of ${g.taskId} ended before its run: ${result.kind === "failed" ? result.error : result.kind}`);
        // Never re-enter the pump from inside a dispatch it started (the loop there is still handing out shards).
        setTimeout(() => this.pumpGroup(g), 0);
    }

    private parseShardOutput(taskId: string, file: string): { ok: true; data: QaPassResult } | { ok: false; error: string } {
        const path = join(this.taskDir(taskId), file);
        if (!existsSync(path)) return { ok: false, error: `${file} was not written` };
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(path, "utf8"));
        } catch (e) {
            return { ok: false, error: `${file} is not valid JSON: ${String(e)}` };
        }
        const parsed = QaPassResult.safeParse(raw);
        return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    }

    // One shard's run ended: its run row is closed like any run, its result goes to the group, the group moves on.
    private async onShardClosed(taskId: string, runId: string, def: StageDef, account: AccountRow, outcome: RunOutcome, shard: QaShard): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) return;
        const g = this.qaGroups.get(shard.group);
        g?.running.delete(runId);
        if (task.status === "stopped") {
            this.db.prepare(`UPDATE runs SET status = 'stopped', finished_at = ? WHERE id = ?`).run(now(), runId);
            if (g) g.results.set(shard.id, { kind: "stopped" });
            return;
        }
        const finish = (status: RunRow["status"], error?: string, resultJson?: string): void => {
            this.db
                .prepare(`UPDATE runs SET status = ?, finished_at = ?, error = ?, result_json = ?, cost_usd = ?, num_turns = ? WHERE id = ?`)
                .run(status, now(), error ?? null, resultJson ?? null, outcome.result?.total_cost_usd ?? null, outcome.result?.num_turns ?? null, runId);
            if (outcome.result) recordUsage(this.db, { accountId: account.id, envId: task.env_id, taskId, runId, kind: "stage", stage: def.stage }, outcome.result);
            calibrateWindows(this.db, account.id, outcome.firstRateLimit, outcome.lastRateLimit, outcome.result?.total_cost_usd);
        };
        const pass = def.stage === "qa_baseline" ? "before" : "after";
        const files = shardFiles(pass, shard);
        let result: ShardResult;
        // A run that ended with a successful result did its work, whatever the last window event said.
        const limited = rateLimitHit(outcome.lastRateLimit) && !(outcome.result && !outcome.result.is_error);
        const refused = this.permissionFailures.get(runId);
        if (refused) {
            this.permissionFailures.delete(runId);
            finish("failed", refused);
            result = { kind: "failed", error: `${shard.id}: ${refused.slice(0, 300)}` };
        } else if (limited && outcome.lastRateLimit?.resetsAt) {
            finish("rate_limited", "rate limited");
            result = { kind: "rate_limited", resetsAt: outcome.lastRateLimit.resetsAt };
        } else {
            const asked = this.questionsAskedDuringRun(taskId, runId, files.questions);
            const written = this.outputWrittenDuringRun(taskId, files.output, runId);
            const parsed = written ? this.parseShardOutput(taskId, files.output) : null;
            if (asked && !parsed?.ok) {
                finish("blocked", `asked the human ${asked.questions.length} question(s)`);
                // What the shard finished before asking (its own partial file) counts; the questions file is consumed.
                const partialPath = join(this.taskDir(taskId), files.partial);
                let recorded: QaPassResult["scenarios"] = [];
                try {
                    const p = existsSync(partialPath) ? QaPassResult.partial().safeParse(JSON.parse(readFileSync(partialPath, "utf8"))) : null;
                    recorded = (p?.success ? p.data.scenarios ?? [] : []).filter(isRecorded);
                } catch {
                    /* nothing recorded */
                }
                const q = join(this.taskDir(taskId), files.questions);
                if (existsSync(q)) renameSync(q, `${q}.asked-${Date.now()}`);
                result = { kind: "asked", questions: asked, recorded };
            } else if (parsed?.ok) {
                const bridgeMiss = parsed.data.blockers.some((b) => /extension|not connected/i.test(b)) && parsed.data.scenarios.every((s) => s.outcome === "blocked");
                if (bridgeMiss) {
                    finish("failed", "browser extension not connected (bridge miss)");
                    result = { kind: "failed", error: `${shard.id}: the browser extension did not connect (${parsed.data.blockers.join("; ").slice(0, 120)})` };
                } else {
                    finish("done", outcome.result && !outcome.result.is_error && (outcome.exitCode ?? 1) === 0 ? undefined : `ended with ${outcome.result?.subtype ?? `exit ${outcome.exitCode}`} after writing the output`, JSON.stringify(parsed.data));
                    this.mergeIntoPartial(taskId, pass, parsed.data.scenarios);
                    result = { kind: "ok", scenarios: parsed.data.scenarios, blockers: parsed.data.blockers };
                }
            } else if (written && parsed && !parsed.ok) {
                finish("failed", `contract: ${parsed.error}`);
                result = { kind: "failed", error: `${shard.id}: output contract — ${parsed.error}` };
            } else {
                const stderrTail = outcome.stderr.trim().split("\n").slice(-3).join(" ").trim();
                const err =
                    outcome.result?.result?.trim() ||
                    (outcome.result?.subtype === "error_max_turns"
                        ? `stopped at the ${outcome.result.num_turns ?? "?"}-turn cap before writing ${files.output}`
                        : outcome.result
                          ? `ended with ${outcome.result.subtype}`
                          : stderrTail || `exit ${outcome.exitCode}`);
                if (isNetworkError(err) && g && !(g.netRetried ??= new Set()).has(shard.id)) {
                    g.netRetried.add(shard.id);
                    finish("failed", `${err} — network failure of the run itself; the shard runs once more`);
                    g.starting.add(shard.id);
                    this.dispatch(taskId, g.stage, { ...g.opts, shard });
                    return;
                }
                finish("failed", err);
                result = { kind: "failed", error: `${shard.id}: ${err.slice(0, 300)}` };
            }
        }
        if (!g) return;
        g.results.set(shard.id, result);
        this.pumpGroup(g);
    }

    // Every shard is in: the pass is complete when every scenario has a result; otherwise what was recorded is kept in
    // qa/<pass>.partial.json and the rest goes on — to the human (questions), to a rate-limit wait, or to another attempt.
    private async completeGroup(g: QaGroup): Promise<void> {
        this.qaGroups.delete(g.id);
        const task = this.getTask(g.taskId);
        if (!task || task.status === "stopped" || task.stage !== g.stage) return;
        const taskId = g.taskId;
        const def = STAGE_DEFS[g.stage];
        const pass = g.stage === "qa_baseline" ? "before" : "after";
        const recorded: QaPassResult["scenarios"] = [];
        const blockers: string[] = [];
        const asked: Array<{ shard: string; questions: AgentQuestion[] }> = [];
        const failures: string[] = [];
        let rateLimit: number | null = null;
        for (const [id, r] of g.results) {
            if (r.kind === "stopped") return;
            if (r.kind === "ok") {
                recorded.push(...r.scenarios);
                blockers.push(...r.blockers);
            } else if (r.kind === "asked") {
                asked.push({ shard: id, questions: r.questions.questions });
                recorded.push(...r.recorded);
            } else if (r.kind === "failed") failures.push(r.error);
            else if (r.kind === "rate_limited") rateLimit = r.resetsAt ?? rateLimit;
        }
        const all = mergeScenarios(this.readCarry(taskId, pass), mergeScenarios(this.readPartial(taskId, pass), recorded));
        const remaining = g.allIds.filter((id) => !all.some((s) => s.id === id));
        if (remaining.length === 0 && asked.length === 0) {
            const qa: QaPassResult = flagSubstitutions({ pass, scenarios: all, blockers: [...new Set(blockers)] });
            writeFileSync(join(this.taskDir(taskId), def.outputFile!), JSON.stringify(qa, null, 2));
            const validation = await this.validateOutput(taskId, def);
            if (!validation.ok) {
                this.setTaskStatus(taskId, "failed", `${def.label} · merged pass file does not validate: ${validation.error.slice(0, 160)}`);
                return;
            }
            this.afterStage(taskId, def, validation.data);
            return;
        }
        // Not finished: keep the results, drop what the next dispatch must redo (seeds for the remaining scenarios).
        const { shard: _shard, seedsDone: _seeds, servicesReady: _services, ...base } = g.opts;
        const extraVars = { ...(base.extraVars ?? {}), ...this.resumeVars(taskId, pass, all, remaining) };
        delete extraVars["seedReport"];
        if (asked.length) {
            const questions = mergeQuestions(asked).slice(0, 10);
            await this.parkOrAutoAnswer(taskId, null, def, { questions }, { ...base, extraVars });
            return;
        }
        if (rateLimit !== null) {
            const env = this.env(task.env_id);
            const account = this.pickAccount(task, def, env, this.configDirOf(env));
            this.queuedOpts.set(`${taskId}:${g.stage}`, { ...base, extraVars });
            if (account) this.queueRateLimited(task, account, rateLimit, `${def.label} · rate limited with ${remaining.length} scenario(s) left`, { failover: false });
            else this.setTaskStatus(taskId, "failed", `${def.label} · rate limited with ${remaining.length} scenario(s) left and no account to resume on — Retry later`);
            return;
        }
        const attempt = base.attempt ?? 1;
        if (attempt < MAX_CONTRACT_ATTEMPTS) {
            this.setTaskStatus(taskId, "running", `${def.label} · ${failures.length} shard(s) ended without a result — driving the remaining ${remaining.length} scenario(s) again (${attempt + 1}/${MAX_CONTRACT_ATTEMPTS})`);
            this.dispatch(taskId, g.stage, {
                ...base,
                attempt: attempt + 1,
                notes: `## Earlier runs of this pass ended without a usable result — attempt ${attempt + 1} of ${MAX_CONTRACT_ATTEMPTS}\n\n${failures.map((f) => `- ${f}`).join("\n")}\n\nDrive the scenarios listed below and write the output file exactly as the contract says.`,
                extraVars,
            });
            return;
        }
        this.setTaskStatus(taskId, "failed", `${def.label} · runs kept ending without a result: ${failures.join("; ").slice(0, 200)}`);
    }

    private static readonly TAB_KEEPER_MS = 5_000;
    // Every few seconds, make the newest tab on the task's app origin the active tab of its Chrome window. Cheap
    // (one osascript), never brings Chrome to the front, no-op when the tab is already active or does not exist yet.
    private startTabKeeper(task: TaskRow, env: EnvRow, cloneKey: string): NodeJS.Timeout | null {
        let origin: string;
        try {
            origin = new URL(this.appUrlFor(task, env)).origin;
        } catch {
            return null;
        }
        const picked = this.qaBrowser(task, env);
        const kind = "browser" in picked ? (picked.browser.browser ?? "Google") : "Google";
        // A cloned Chrome is a separate process AppleScript cannot address; its tabs are reached over its CDP port.
        const clone = this.clones.get(cloneKey);
        const timer = setInterval(() => void (clone ? activateCloneTab(clone.cdpPort, `${origin}/`) : activateChromeTab(`${origin}/`, kind)), Engine.TAB_KEEPER_MS);
        timer.unref();
        return timer;
    }

    // Executes every `shell:` seed step of every scenario from the worktree (env vars applied, 120 s each) and returns a
    // report for the prompt; failures are reported per step, never thrown. Output is kept in <taskDir>/qa/seed-<pass>.log.
    // Executes, per scenario, every `teardown` step and then every leading `shell:` seed step (placeholders resolved:
    // {{beUrl}}/{{appUrl}}/{{qaPass}}), from the worktree, 120 s each; failures are reported per step, never thrown.
    // Output is kept in <taskDir>/qa/seed-<pass>.log. Teardown first is the rule (user, 2026-09-21): "seeding should
    // first try to delete old records and only then create them".
    // Runs a batch of Django-shell steps in one process (mode "run" commits like the steps would; "dryrun" rolls each
    // back) and returns one result per step. A process that fails to start reports every step as failed with its tail.
    private async runDjangoBatch(task: TaskRow, env: EnvRow, prefix: string, items: SeedItem[], mode: "run" | "dryrun"): Promise<ReturnType<typeof parseBatchOutput>> {
        try {
            const { stdout } = await execFileAsync("bash", loginShellArgs(djangoBatchCommand(prefix)), {
                cwd: task.worktree_path ?? env.path,
                env: loginShellEnv({ ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, task.id), ...djangoBatchEnv(items, mode) }),
                timeout: 120_000 + 60_000 * items.length,
                maxBuffer: 8 * 1024 * 1024,
            });
            return parseBatchOutput(stdout, items.map((i) => i.label));
        } catch (e) {
            const err = e as { stderr?: string; stdout?: string; message?: string };
            const partial = parseBatchOutput(String(err.stdout ?? ""), items.map((i) => i.label));
            const tail = String(err.stderr?.trim() || err.message || e).trim().split("\n").slice(-3).join(" ").slice(0, 300);
            return partial.map((r) => (r.ok || r.output ? r : { ...r, error: r.error.startsWith("the seed process ended") ? `the Django shell did not start: ${tail}` : r.error }));
        }
    }

    // `opts.only`: seed only these scenarios (a QA pass resumed after questions re-seeds just the scenarios still to run).
    // The env's QA session command (envs.qa_session_command): Stagehand runs it before a QA pass — from the worktree, after
    // Prepare — and gives the last line it prints to the pass as $STAGEHAND_QA_SESSION (e.g. `token=<jwt>` for a Cookie
    // header), so API scenarios sign in without the agent ever handling the app's secrets.
    private readonly qaSessions = new Map<string, string>();
    private async refreshQaSession(task: TaskRow, env: EnvRow): Promise<void> {
        this.qaSessions.delete(task.id);
        const tpl = env.qa_session_command?.trim();
        if (!tpl) return;
        const cwd = task.worktree_path ?? env.path;
        const cmd = withPrepare(env, tpl.replace(/\{\{worktree\}\}/g, cwd).replace(/\{\{envPath\}\}/g, env.path));
        try {
            const { stdout } = await execFileAsync("bash", loginShellArgs(cmd), { cwd, env: loginShellEnv({ ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, task.id) }), timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
            const line = stdout.trim().split("\n").filter((l) => l.trim()).pop()?.trim();
            if (!line) throw new Error("it printed nothing");
            this.qaSessions.set(task.id, line);
        } catch (e) {
            const err = e as { stderr?: string; stdout?: string; message?: string };
            throw new Error(`the environment's QA session command failed: ${String(err.stderr?.trim() || err.stdout?.trim() || err.message || e).split("\n").slice(-3).join(" ").slice(0, 240)}`);
        }
    }
    private qaSessionEnv(taskId: string, def: StageDef): Record<string, string> {
        const v = def.chrome ? this.qaSessions.get(taskId) : undefined;
        return v ? { STAGEHAND_QA_SESSION: v } : {};
    }

    private async runShellSeeds(task: TaskRow, env: EnvRow, def: StageDef, qaPass: string, opts?: { only?: Set<string> }): Promise<string> {
        const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
        const pass = def.stage === "qa_baseline" ? "before" : "after";
        const logPath = join(this.taskDir(task.id), "qa", `seed-${pass}.log`);
        const be = this.services.get(task.id, "be");
        const fe = this.services.get(task.id, "fe");
        const qaVars: QaVars = { beUrl: be?.url ?? "", feUrl: fe?.url ?? "", appUrl: this.appUrlFor(task, env), qaPass };
        const lines: string[] = [`(pass id: ${qaPass} — every {{qaPass}} in seeds, steps and asserts reads as this)`];
        const log: string[] = [];
        // Asynchronous on purpose: a Django-shell seed takes 10–60 s and a pass has several — run synchronously they
        // froze the whole server (no API, no UI) for minutes (INV-133, 2026-09-22: "server doesn't load anything").
        const runOne = async (label: string, cmd: string): Promise<void> => {
            log.push(`### ${label}\n$ ${cmd}`);
            try {
                const { stdout } = await execFileAsync("bash", loginShellArgs(cmd), {
                    cwd: task.worktree_path ?? env.path,
                    env: loginShellEnv({ ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, task.id), ...this.qaSessionEnv(task.id, def) }),
                    timeout: 120_000,
                    maxBuffer: 4 * 1024 * 1024,
                });
                const out = stdout.trim();
                log.push(out || "(no output)");
                lines.push(`${label}: OK${out ? ` — ${out.split("\n").slice(-1)[0]!.slice(0, 120)}` : ""}`);
            } catch (e) {
                const err = e as { stderr?: string; stdout?: string; message?: string };
                const tail = String(err.stderr?.trim() || err.stdout?.trim() || err.message || e).trim().split("\n").slice(-3).join(" ").slice(0, 300);
                log.push(`FAILED: ${tail}`);
                lines.push(`${label}: FAILED — ${tail}`);
            }
        };
        // The pass's shell steps in order (teardown, then the leading shell seeds, per scenario); consecutive Django-shell
        // steps with one prefix then run in ONE Django process (seed-batch.ts) — every `manage.py shell` start boots
        // Django for 10–30 s, and a pass has two such steps per scenario.
        const steps: Array<{ label: string; cmd: string }> = [];
        for (const s of design?.qa ?? []) {
            if (opts?.only && !opts.only.has(s.id)) continue;
            // Reset this scenario's fixture set before creating it again: a partial earlier pass must not leave records
            // that make a seed or a step collide (a teardown that finds nothing to delete is fine).
            for (const [i, step] of (s.teardown ?? []).entries()) {
                const m = /^\s*(shell|sql)\s*:\s*/i.exec(step);
                if (!m) {
                    lines.push(`${s.id} teardown ${i + 1}: skipped (not a shell command)`);
                    continue;
                }
                steps.push({ label: `${s.id} teardown ${i + 1}`, cmd: fillQaVars(step.slice(m[0].length), qaVars) });
            }
            // Shell steps that come after a ui step depend on what the ui step creates; the runner executes those itself.
            let afterUi = false;
            for (const [i, step] of (s.seed ?? []).entries()) {
                const m = /^\s*(shell|sql)\s*:\s*/i.exec(step);
                if (!m) {
                    afterUi = afterUi || /^\s*ui\s*:/i.test(step);
                    lines.push(`${s.id} seed ${i + 1}: left for you (${/^\s*ui\s*:/i.test(step) ? "ui" : "not a shell command"})`);
                    continue;
                }
                if (afterUi) {
                    lines.push(`${s.id} seed ${i + 1}: run it yourself after the ui steps — ONE Bash call with the exact command from the scenario's seed list`);
                    continue;
                }
                steps.push({ label: `${s.id} seed ${i + 1}`, cmd: fillQaVars(step.slice(m[0].length), qaVars) });
            }
        }
        for (const unit of planSeedUnits(steps)) {
            if (unit.kind === "plain") {
                await runOne(unit.label, unit.cmd);
                continue;
            }
            if (unit.items.length === 1) {
                await runOne(unit.items[0]!.label, unit.items[0]!.cmd);
                continue;
            }
            const results = await this.runDjangoBatch(task, env, unit.prefix, unit.items, "run");
            for (const [i, r] of results.entries()) {
                log.push(`### ${r.label}\n$ ${unit.items[i]!.cmd}`);
                log.push(r.ok ? r.output || "(no output)" : `${r.output}\nFAILED: ${r.error}`.trim());
                lines.push(r.ok ? `${r.label}: OK${r.output ? ` — ${r.output.split("\n").slice(-1)[0]!.slice(0, 120)}` : ""}` : `${r.label}: FAILED — ${r.error.slice(0, 300)}`);
            }
        }
        writeFileSync(logPath, `${log.join("\n\n")}\n`);
        return lines.length > 1 ? lines.join("\n") : "(no seed steps in the design)";
    }

    private async bringUpServices(task: TaskRow, env: EnvRow): Promise<boolean> {
        if (env.depends_on_env_id) {
            this.setTaskStatus(task.id, "running", `${STAGE_DEFS[task.stage]?.label ?? task.stage} · starting the dependency service this env needs`);
            await this.services.ensureDependency(env);
        }
        // A service that fails to come up throws with the probe's reason (command exited, start budget spent), which
        // the caller puts on the blocked line — and the App widget shows the same failure with a Fix-with-agent button.
        for (const kind of ["be", "fe"] as const) {
            if (!(kind === "be" ? env.be_command : env.fe_command)) continue;
            const row = await this.services.start(task, env, kind);
            const r = await this.services.waitUntilUp(row);
            if (!r.ok) throw new Error(`${kind.toUpperCase()} did not come up: ${r.error} — see its log in the App widget, or let the agent fix it there`);
        }
        // Optional components the pass needs (INV-133, 2026-09-22: a Manual QA pass failed because no Celery worker
        // processed the backend's jobs — the design can now declare `services: ["worker"]`, and the env can auto-start).
        for (const c of this.wantedComponents(task, env)) {
            this.setTaskStatus(task.id, "running", `${STAGE_DEFS[task.stage]?.label ?? task.stage} · starting ${c.label}`);
            const row = await this.services.start(task, env, c.key);
            const r = await this.services.waitUntilUp(row);
            if (!r.ok) throw new Error(`${c.label} (optional component "${c.key}") did not come up: ${r.error} — see its log in the App widget`);
        }
        await this.prewarmScenarioUrls(task, env);
        this.emitTask(task.id);
        return true;
    }

    // A dev server (Next, CRA) compiles a route on its first request — 20–60 s the QA runner would otherwise spend
    // waiting on its first navigation to every page. Request every browser scenario's start URL once, in parallel,
    // before the runner starts; failures are irrelevant here (the runner sees the real page).
    private async prewarmScenarioUrls(task: TaskRow, env: EnvRow): Promise<void> {
        const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
        const appUrl = this.appUrlFor(task, env).replace(/\/+$/, "");
        const urls = [...new Set((design?.qa ?? []).filter((s) => (s.kind ?? "browser") === "browser").map((s) => s.url).filter((u): u is string => typeof u === "string" && u.startsWith("/")))];
        if (!appUrl || urls.length === 0) return;
        this.setTaskStatus(task.id, "running", `${STAGE_DEFS[task.stage]?.label ?? task.stage} · warming ${urls.length} page(s)`);
        const started = Date.now();
        await Promise.all(
            urls.map((u) =>
                execFileAsync("curl", ["-sk", "-o", "/dev/null", "--max-time", "120", `${appUrl}${u.replace(/:[a-zA-Z_]+/g, "1")}`]).catch(() => undefined),
            ),
        );
        console.log(`[stagehand] ${task.ticket_id}: warmed ${urls.length} page(s) in ${Math.round((Date.now() - started) / 1000)} s`);
    }

    // The scenarios a pass drives: every one, in both passes. A `baseline: false` scenario still runs in the baseline —
    // its seeds, teardown, auth and the steps before the new surface are what the design loop checks (INV-154,
    // 2026-09-30: four `baseline: false` scenarios meant no baseline at all); the runner is told what to expect.
    private qaScenariosForPass(design: DesignResult | null, _stage: Stage): QaScenario[] {
        return design?.qa ?? [];
    }

    // A QA pass that stops half-way (the runner asked the human, or an unblock retry) resumes from the scenarios already
    // recorded: those go to qa/<pass>.partial.json and the next run gets `resumeOnly` (ids still to drive) plus a hint
    // to copy the recorded results verbatim into its output. Seeds run only for the resumed scenarios.
    private resumeVars(taskId: string, pass: "before" | "after", recorded: QaPassResult["scenarios"], remaining: string[]): Record<string, string> {
        const dir = join(this.taskDir(taskId), "qa");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${pass}.partial.json`), JSON.stringify({ pass, scenarios: recorded }, null, 2));
        return this.resumeHintVars(recorded, remaining);
    }

    private resumeHintVars(recorded: QaPassResult["scenarios"], remaining: string[]): Record<string, string> {
        return {
            resumeOnly: remaining.join(","),
            resumeHint: recorded.length
                ? `## Resumed pass — ${recorded.map((s) => s.id).join(", ")} already recorded\n\nThese scenarios were completed by the previous attempt and are NOT listed below; do not run them again. Copy these entries verbatim into your output file next to the ones you run now:\n\n\`\`\`json\n${JSON.stringify(recorded, null, 2)}\n\`\`\``
                : "",
        };
    }

    // What qa/<pass>.partial.json holds: the scenarios earlier runs of this pass recorded (verdicts and hand-offs).
    private readPartial(taskId: string, pass: "before" | "after"): QaPassResult["scenarios"] {
        const p = join(this.taskDir(taskId), "qa", `${pass}.partial.json`);
        if (!existsSync(p)) return [];
        try {
            const partial = QaPassResult.partial().safeParse(JSON.parse(readFileSync(p, "utf8")));
            return (partial.success ? partial.data.scenarios ?? [] : []).filter(isRecorded);
        } catch (e) {
            console.warn(`[stagehand] partial QA results of ${taskId} ignored: ${String((e as Error).message ?? e).slice(0, 160)}`);
            return [];
        }
    }

    // What the design loop carried into this pass unchanged (qa/<pass>.carry.json), blocked results included.
    private readCarry(taskId: string, pass: "before" | "after"): QaPassResult["scenarios"] {
        const p = join(this.taskDir(taskId), "qa", `${pass}.carry.json`);
        if (!existsSync(p)) return [];
        try {
            const carry = QaPassResult.partial().safeParse(JSON.parse(readFileSync(p, "utf8")));
            return carry.success ? (carry.data.scenarios ?? []) : [];
        } catch {
            return [];
        }
    }

    // Adds a finished shard's results to qa/<pass>.partial.json (by id, later wins), so a pass that dies half-way —
    // a restart, a Stop, a shard without output — resumes from what its other shards recorded.
    private mergeIntoPartial(taskId: string, pass: "before" | "after", scenarios: QaPassResult["scenarios"]): void {
        const dir = join(this.taskDir(taskId), "qa");
        mkdirSync(dir, { recursive: true });
        const merged = mergeScenarios(this.readPartial(taskId, pass), scenarios.filter(isRecorded));
        writeFileSync(join(dir, `${pass}.partial.json`), JSON.stringify({ pass, scenarios: merged }, null, 2));
    }

    // The extra vars that resume a pass from its partial file: null when nothing was recorded.
    private resumeFromPartial(taskId: string, stage: Stage): Record<string, string> | null {
        const pass = stage === "qa_baseline" ? "before" : "after";
        const recorded = this.readPartial(taskId, pass);
        if (recorded.length === 0) return null;
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const remaining = this.qaScenariosForPass(design, stage).map((s) => s.id).filter((id) => !recorded.some((r) => r.id === id));
        return this.resumeHintVars(recorded, remaining);
    }

    // Removes what earlier runs of a pass left behind: the partial file and every shard's output / partial / questions.
    private writeDesignBaseline(taskId: string, m: DesignBaseline): void {
        writeFileSync(join(this.taskDir(taskId), "design-baseline.json"), JSON.stringify(m, null, 2));
    }

    // The design agent's output passed its contract: run the baseline on the scenarios whose result is not on record
    // (new or changed since it ran), or — when every result is current, or the rounds ran out — hand the proposal to
    // the reviewer. A blocked result is reused only inside the loop (the agent kept the scenario after reading why);
    // after a human review round it runs again, since the environment can have been fixed meanwhile.
    private afterDesign(taskId: string): void {
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const cur = scenarioHashes(design);
        const raw = rawScenarioHashes(design);
        const ids = Object.keys(cur);
        const prev = this.readArtifactJson<DesignBaseline>(taskId, "design-baseline.json");
        const wait = (line: string): void => this.setTaskStatus(taskId, "waiting_user", `Design Proposal · needs you${line ? ` — ${line}` : ""}`);
        if (!ids.length) {
            wait("");
            return;
        }
        const inLoop = prev?.status === "reviewing";
        // A record from before per-scenario hashes: its one whole-set hash still says whether nothing changed.
        const known = prev?.hashes ?? (prev && prev.qaHash === sha1(JSON.stringify(design?.qa ?? [])) ? cur : {});
        const before = this.readArtifactJson<QaPassResult>(taskId, "qa/before.json");
        const cached = (before?.scenarios ?? []).filter((r) => cur[r.id] !== undefined && (known[r.id] === cur[r.id] || known[r.id] === raw[r.id]) && (inLoop || r.outcome !== "blocked"));
        const toRun = ids.filter((id) => !cached.some((c) => c.id === id));
        const beforePath = join(this.taskDir(taskId), "qa", "before.json");
        if (!toRun.length) {
            // Removed scenarios leave the record; everything else stands.
            if (before && before.scenarios.length !== cached.length) writeFileSync(beforePath, JSON.stringify({ ...before, scenarios: cached }, null, 2));
            this.writeDesignBaseline(taskId, { status: "done", round: prev?.round ?? 1, qaHash: qaHashOf(design), hashes: cur });
            wait(inLoop ? `QA baseline ran (round ${prev!.round}); see the QA tests tab` : "the QA baseline is current (no QA scenario changed); see the QA tests tab");
            return;
        }
        const round = inLoop ? prev!.round + 1 : 1;
        if (round > MAX_DESIGN_BASELINE_ROUNDS) {
            this.writeDesignBaseline(taskId, { status: "done", round: MAX_DESIGN_BASELINE_ROUNDS, qaHash: qaHashOf(design), hashes: known });
            wait(`the QA scenarios changed again after ${MAX_DESIGN_BASELINE_ROUNDS} baseline rounds — ${toRun.join(", ")} have no baseline for their last version`);
            return;
        }
        this.writeDesignBaseline(taskId, { status: "running", round, qaHash: qaHashOf(design), hashes: known });
        this.addAgentNote(
            taskId,
            `QA baseline round ${round}/${MAX_DESIGN_BASELINE_ROUNDS}: running ${toRun.join(", ")} on the unchanged app before the proposal goes to you${cached.length ? ` (${cached.map((c) => c.id).join(", ")} unchanged — their result is reused)` : ""}`,
        );
        this.clearPassFiles(taskId, "before");
        if (existsSync(beforePath)) renameSync(beforePath, `${beforePath}.prev-${Date.now()}`);
        // The reused results ride along unfiltered: the partial file drops blocked results (a resumed pass drives them
        // again), but the loop keeps a blocked one the agent saw and kept (PRODUCT-10578, 2026-10-05: all three reused
        // results were blocked, were dropped, and approval then ran the whole baseline again).
        if (cached.length) writeFileSync(join(this.taskDir(taskId), "qa", "before.carry.json"), JSON.stringify({ pass: "before", scenarios: cached }, null, 2));
        this.setStage(taskId, "qa_baseline");
        this.dispatch(taskId, "qa_baseline", cached.length ? { extraVars: this.resumeVars(taskId, "before", cached, toRun) } : {});
    }

    // A baseline pass of the design loop is over (any way but a login wall): the design agent reads the result.
    // Returns false outside the loop (a baseline after approval ends the normal way).
    private designBaselineEnded(task: TaskRow, qa: QaPassResult, stopped: string | null): boolean {
        const m = this.readArtifactJson<DesignBaseline>(task.id, "design-baseline.json");
        if (m?.status !== "running") return false;
        // The hash is taken now: corrections QA applied to design.json during the pass are part of what the agent reviews.
        const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
        this.writeDesignBaseline(task.id, { status: "reviewing", round: m.round, qaHash: qaHashOf(design), hashes: scenarioHashes(design) });
        this.stopServicesAfterQa(task);
        this.setStage(task.id, "design_proposal");
        this.dispatch(task.id, "design_proposal", { notes: renderDesignBaselineNotes(qa, m.round, stopped) });
        return true;
    }

    // The design loop's baseline against the approved scenarios: null when the loop never ran one (a task from before
    // the loop: the separate baseline stage runs), else the scenarios without a current result there.
    private designBaselineGaps(taskId: string): string[] | null {
        const m = this.readArtifactJson<DesignBaseline>(taskId, "design-baseline.json");
        if (!m) return null;
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const cur = scenarioHashes(design);
        const raw = rawScenarioHashes(design);
        const recorded = new Set((this.readArtifactJson<QaPassResult>(taskId, "qa/before.json")?.scenarios ?? []).map((r) => r.id));
        return Object.entries(cur).filter(([id, h]) => !((m.hashes?.[id] === h || m.hashes?.[id] === raw[id]) && recorded.has(id))).map(([id]) => id);
    }

    // The design stage's baseline pairs with the approved scenarios: the separate baseline stage has nothing to add.
    private designBaselineCurrent(taskId: string): boolean {
        const m = this.readArtifactJson<DesignBaseline>(taskId, "design-baseline.json");
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const cur = scenarioHashes(design);
        const raw = rawScenarioHashes(design);
        const recorded = new Set((this.readArtifactJson<QaPassResult>(taskId, "qa/before.json")?.scenarios ?? []).map((r) => r.id));
        return m?.status === "done" && Object.entries(cur).every(([id, h]) => (m.hashes?.[id] === h || m.hashes?.[id] === raw[id]) && recorded.has(id));
    }

    private clearPassFiles(taskId: string, pass: "before" | "after"): void {
        const dir = join(this.taskDir(taskId), "qa");
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
            if (f === `${pass}.partial.json` || (f.startsWith(`${pass}.`) && f.endsWith(".json") && f !== `${pass}.json`) || f.startsWith(`questions.${pass}.`)) rmSync(join(dir, f), { force: true });
        }
    }

    // The env's optional components a QA pass needs: the auto-started ones plus those the design's scenarios declare.
    private wantedComponents(task: TaskRow, env: EnvRow): EnvComponent[] {
        const design = this.readArtifactJson<DesignResult>(task.id, "design.json");
        const declared = new Set((design?.qa ?? []).flatMap((s) => s.services ?? []));
        return componentsOf(env).filter((c) => c.autoStart || declared.has(c.key));
    }

    // What every agent prompt says about the env's optional components: which exist, which run now, and how to start or
    // stop one on demand through Stagehand's local API (the design stage learns the `services` declaration instead).
    private describeComponents(task: TaskRow, env: EnvRow, stage: Stage): string {
        const comps = componentsOf(env);
        // The env's shared dependency (Deal → Core) is one more component to the agents: the BE is dead without it
        // (500s / connection errors on every call), and after a host restart nothing else brings it back.
        const dep = this.services.dependencyEnv(env);
        if (comps.length === 0 && !dep) return "";
        const keys = comps.map((c) => `\`${c.key}\``).join(", ");
        if (stage === "design_proposal") {
            return (
                `## Optional components of this environment\n\n` +
                (comps.length > 0
                    ? `Not running by default: ${comps.map((c) => `\`${c.key}\` (${c.label}${c.autoStart ? ", auto-started with the app" : ""})`).join(", ")}. ` +
                      `A QA scenario whose journey depends on one of them — background jobs a worker must process, a scheduler, a relay — lists its key in \`services\` (e.g. \`"services": ["${comps[0]!.key}"]\`); the orchestrator starts it before the seeds of every pass. Only these keys exist: ${keys}.`
                    : "") +
                (dep ? `${comps.length > 0 ? "\n\n" : ""}\`${DEPENDENCY_KIND}\` (${dep.name}, shared): the backend this environment's BE calls; the orchestrator starts it before every pass — do not list it in \`services\`.` : "")
            );
        }
        const base = `http://127.0.0.1:${this.cfg.port}/api/tasks/${task.id}/services`;
        const live = new Set(this.services.list(task.id).map((r) => r.kind));
        const depLine = dep
            ? `- \`${DEPENDENCY_KIND}\` — ${dep.name} (shared): the backend this environment's BE calls (auth, data); one instance for every task of the environment${this.services.dependencyLooksRunning(env) ? " · **running now**" : " · not running — the BE answers 500 / connection errors until it is up"}: start \`curl -s -X POST ${base}/${DEPENDENCY_KIND}/start\` (returns at once; it is up when the status call below lists it \`running\`, up to 3 min); stop \`curl -s -X POST ${base}/${DEPENDENCY_KIND}/stop\` (stops it for every task — only when nothing else needs it); log \`${this.services.dependencyLogPath(env) ?? ""}\`\n`
            : "";
        return (
            `## Optional components of this environment\n\n` +
            `Extra services beside the BE/FE, not running unless started. When a journey needs one (e.g. a queued job that only a worker processes), start it yourself from Bash, wait until its log shows it is ready (\`tail -40\` of the log path), then continue — do not report the scenario blocked or needs_human for a missing component.\n` +
            depLine +
            comps.map((c) => `- \`${c.key}\` — ${c.label}${live.has(c.key) ? " · **running now**" : " · not running"}: start \`curl -s -X POST ${base}/${c.key}/start\`; stop \`curl -s -X POST ${base}/${c.key}/stop\`; log \`${join(this.taskDir(task.id), "logs", `${c.key}.log`)}\``).join("\n") +
            `\n- Status of every service of this task: \`curl -s ${base}\`.`
        );
    }

    // "Rebase onto latest base" (task page): the task's own agent rebases the branch onto origin/<base> in the worktree,
    // resolving conflicts and re-running the fast checks under the normal guard (no force-push, no interactive rebase);
    // Stagehand then force-pushes with lease itself where the env allows pushes and the branch is on GitHub, resets the
    // PR checks and re-polls. Refuses while a run is in progress or when already up to date; uncommitted changes are set aside for the plain pass.
    // Plain `git rebase` first: the task's own commits (on neither the base nor the trunk) are replayed onto the new
    // base with `--onto`, so a base that was rewritten under the branch (a stacked parent force-pushed) replays only
    // this task's work. The agent is brought in only for a checkout where that conflicts — the user's rule (2026-09-18):
    // "agentic rebase takes a lot of time. Let's do agentic only if simple git rebase is not clean".
    // `repos`: only these repository directories (default: every repository of the task).
    // Returns what happened when it finished without an agent (`agent: false`), so the caller can show it; a step that
    // failed (❌: a push, an unfinished rebase) comes back as `failed` — the button that started it must say so, not
    // only the chat (INV-154, 2026-10-05: a refused push was visible nowhere but a truncated chat line).
    async startRebase(taskId: string, opts: { auto?: string; repos?: string[] } = {}): Promise<{ agent: boolean; summary: string; failed: boolean }> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — wait for it to finish");
        if (!task.branch || !task.worktree_path) throw new Error("the task has no branch/worktree yet");
        const env = this.env(task.env_id);
        // Each repository rebases onto its own base (a multi-repo task may be stacked per repo); `base` below is the
        // label for messages: one name, or "backend: x, frontend: y".
        const base = this.baseBranchLabel(task, env);
        const cd = this.configDirOf(env);
        const usable = this.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === accountOrderOf(env)[0]) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        const { repos, behind, fastForwarded, headsBefore, plain, conflicted } = await this.rebasePlainPass(task, env, opts.repos);
        const header = opts.auto ? `🔀 Auto-rebase onto origin/${base} (${opts.auto}):` : `🔀 Rebase onto origin/${base}:`;
        if (repos.length === 0) {
            const warnings = plain.filter((l) => l.startsWith("⚠️"));
            if (fastForwarded.length === 0) throw new Error(`already up to date with origin/${base}${warnings.length ? ` — ${warnings.join("; ")}` : ""}`);
            const resync = await this.resyncAfterHistoryChange(task, env, headsBefore);
            const summary = `${plain.join("\n")}${resync ? `\n${resync}` : ""}`;
            this.addMessage(taskId, "agent", `${header}\n\n${summary}\n\nNothing to replay — no agent run needed.`);
            this.emitTask(taskId);
            return { agent: false, summary, failed: /❌/.test(summary) };
        }
        if (conflicted.length === 0) {
            const lines = await this.finishRebase(task, env, repos, headsBefore);
            const summary = `${plain.join("\n")}\n${lines.join("\n")}`;
            this.addMessage(taskId, "agent", `${header}\n\n${summary}`);
            this.emitTask(taskId);
            return { agent: false, summary, failed: /❌/.test(summary) };
        }
        const prevStatus = task.status;
        const prevLine = task.status_line;
        this.setTaskStatus(taskId, "running", `Rebasing \`${task.branch}\` onto the latest base (${base}) with the agent (plain rebase conflicted in ${conflicted.map(repoLabel).join(", ")})…`);
        const prompt = renderPrompt("rebase.md", {
            branch: task.branch,
            baseBranch: base,
            worktree: task.worktree_path,
            taskDir: this.taskDir(taskId),
            repoLayout: describeRepoLayout(this.layoutOf(task, env), task.worktree_path),
            behind: behind.filter((l) => conflicted.some((repo) => l.startsWith(`${repoLabel(repo)}:`))).join("; "),
            conflicted: conflicted.map(repoLabel).join(", "),
            taskNotes: task.notes?.trim() ? `The human's standing notes on this task: ${task.notes.trim()}` : "",
        });
        const rulesMat = materializeRules(rulesOf(cd), env, task.worktree_path, this.cfg.dataDir);
        const run = startClaude({
            prompt,
            cwd: task.worktree_path,
            configDir: cd.path,
            extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId), ...authEnv(acc) },
            settingsPath: rulesMat.settingsPath,
            appendSystemPrompt: rulesMat.systemPrompt,
            ...this.sessionArgs(task),
            maxTurns: 80,
            addDirs: [this.taskDir(taskId)],
            ...((): { model?: string } => {
                const m = this.modelForOperation(task, "rebase", acc);
                return m ? { model: m } : {};
            })(),
        });
        void run.done.then(async (outcome: RunOutcome) => {
            if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "rebase", stage: null }, outcome.result);
            const reply = outcome.result?.result?.trim() || (outcome.exitCode !== 0 ? `(did not finish: ${outcome.stderr.trim().split("\n").slice(-2).join(" ").slice(-200) || `exit ${outcome.exitCode}`})` : "(no reply)");
            const lines = await this.finishRebase(task, env, repos, headsBefore);
            this.setTaskStatus(taskId, prevStatus, prevLine ?? "rebase finished — see Chat");
            this.addMessage(taskId, "agent", `${header}\n\n${plain.join("\n")}\n\n${reply}\n\n${lines.join("\n")}`);
            this.emitTask(taskId);
        });
        return { agent: true, summary: `the plain rebase conflicted in ${conflicted.map(repoLabel).join(", ")} — the agent is resolving it; the result lands in Chat`, failed: false };
    }

    // Preflight + mechanical pass shared by "Rebase onto latest base" and the batched PR jobs: sets uncommitted changes
    // aside for the pass (put back at its end), fetches each repository's base, resets checkouts with no commits of
    // their own, and plain-rebases the rest; `conflicted` names the checkouts left for the agent (restored to where
    // they were).
    private async rebasePlainPass(task: TaskRow, env: EnvRow, only?: string[]): Promise<{ allRepos: string[]; repos: string[]; behind: string[]; fastForwarded: string[]; headsBefore: Map<string, string>; plain: string[]; conflicted: string[] }> {
        const wanted = only?.length ? new Set(only) : null;
        const allRepos = this.prRepos(env).filter((r) => existsSync(this.checkoutOf(task, env, r)) && (!wanted || wanted.has(r)));
        if (wanted && allRepos.length === 0) throw new Error(`none of the requested repositories (${[...wanted].map(repoLabel).join(", ")}) has a checkout in this task`);
        const behind: string[] = [];
        const fastForwarded: string[] = [];
        const repos: string[] = [];
        // Each checkout's HEAD before anything moves: a rebase that changes a lockfile leaves node_modules / .venv stale
        // (setup only ran at worktree creation), so the env's setup command is re-run afterwards when one did.
        const headsBefore = new Map<string, string>();
        const plain: string[] = [];
        const conflicted: string[] = [];
        const notes: string[] = [];
        // Uncommitted changes (untracked files too) are set aside in a labelled stash for the rebase and put back
        // after it instead of refusing the rebase — the user's ask (2026-09-28) after INV-135's rebase was refused
        // over a change the Code changes view did not show. The finally puts every stash back, whatever happened.
        const stashed: Array<{ repo: string; cwd: string; label: string }> = [];
        try {
            for (const repo of allRepos) {
                const base = this.baseBranchOf(task, env, repo);
                const cwd = this.checkoutOf(task, env, repo);
                const dirty = await dirtyPaths(cwd, parseEnvVars(env.env_vars)).catch(() => []);
                if (dirty.length) {
                    const label = `stagehand: set aside for the rebase of ${task.branch} at ${now()}`;
                    try {
                        await this.git(cwd, ["stash", "push", "--include-untracked", "-m", label], env);
                    } catch (e) {
                        throw new Error(`${repoLabel(repo)} has uncommitted changes that could not be set aside for the rebase (${gitErrorTail(e)}) — commit or discard them first: ${describePaths(dirty)}`);
                    }
                    stashed.push({ repo, cwd, label });
                    notes.push(`📦 ${repoLabel(repo)}: uncommitted changes set aside for the rebase and put back after it — ${describePaths(dirty)}`);
                }
                headsBefore.set(repo, (await this.git(cwd, ["rev-parse", "HEAD"], env).catch(() => "")).trim());
                await this.git(cwd, ["fetch", "origin", base], env);
                const n = Number(await this.git(cwd, ["rev-list", "--count", `HEAD..origin/${base}`], env).catch(() => "0")) || 0;
                if (n === 0) continue;
                // Commits of this checkout's own: on neither the base nor the env's trunk (a stacked task forked from a
                // newer trunk than its parent carries trunk commits its parent lacks — those are not "its own").
                await this.git(cwd, ["fetch", "origin", env.base_branch], env).catch(() => "");
                const own = Number(await this.git(cwd, ["rev-list", "--count", "HEAD", `^origin/${base}`, `^origin/${env.base_branch}`], env).catch(() => "0")) || 0;
                // A checkout with nothing of its own (a multi-repo task that only touched the other repository) has no
                // history to replay: move it to the base outright, so a stacked task's untouched repository matches its
                // parent. Nothing is lost — every commit here is on the base or the trunk.
                if (own === 0) {
                    await this.git(cwd, ["reset", "--hard", `origin/${base}`], env);
                    fastForwarded.push(`${repoLabel(repo)}: moved to origin/${base} (no commits of its own)`);
                    continue;
                }
                behind.push(`${repoLabel(repo)}: ${n} commit(s)`);
                repos.push(repo);
            }
            // Mechanical pass per checkout; the ones that conflict go to the agent.
            plain.push(...fastForwarded.map((l) => `✅ ${l}`), ...notes);
            for (const repo of repos) {
                const cwd = this.checkoutOf(task, env, repo);
                const repoBase = this.baseBranchOf(task, env, repo);
                const r = await this.plainRebase(cwd, env, repoBase, headsBefore.get(repo) ?? "");
                if (r.ok) plain.push(`✅ ${repoLabel(repo)}: plain rebase onto origin/${repoBase}, no conflicts (${r.replayed} commit(s) replayed)`);
                else {
                    conflicted.push(repo);
                    plain.push(`⚠️ ${repoLabel(repo)}: plain rebase conflicted in ${r.conflict} — handed to the agent`);
                }
            }
        } finally {
            for (const st of stashed) {
                try {
                    // The stash list is shared by every worktree of the repository: pop this rebase's entry by its label.
                    const list = await this.git(st.cwd, ["stash", "list", "--format=%gd%x1f%gs"], env);
                    const ref = list.split("\n").map((l) => l.split("\x1f")).find(([, subject]) => subject?.endsWith(st.label))?.[0];
                    if (!ref) throw new Error("the stash entry is gone");
                    await this.git(st.cwd, ["stash", "pop", ref], env);
                } catch (e) {
                    console.warn(`[stagehand] ${task.ticket_id}: stash "${st.label}" not put back: ${gitErrorTail(e)}`);
                    plain.push(`⚠️ ${repoLabel(st.repo)}: the uncommitted changes set aside for the rebase did not go back cleanly (${gitErrorTail(e)}) — they are kept in \`git stash list\` as "${st.label}"`);
                }
            }
        }
        return { allRepos, repos, behind, fastForwarded, headsBefore, plain, conflicted };
    }

    // What a Fix-CI job tells the agent about one repository's PR: the failing checks and how to read their logs.
    private async ciFailureText(task: TaskRow, env: EnvRow, repo: string): Promise<{ text: string; count: number }> {
        const row = this.prRow(task.id, repo);
        if (!row?.number) return { text: "", count: 0 };
        const cwd = this.checkoutOf(task, env, repo);
        const pr = JSON.parse(await this.gh(cwd, ["pr", "view", String(row.number), "--json", "statusCheckRollup"], env)) as {
            statusCheckRollup: Array<{ name?: string; context?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }>;
        };
        const failed = (pr.statusCheckRollup ?? []).filter((c) => !isApprovalGateCheck(c) && isFailedCheck(c));
        if (!failed.length) return { text: "", count: 0 };
        const names = failed.map((c) => `${c.name ?? c.context ?? "check"}${c.detailsUrl ?? c.targetUrl ? ` (${c.detailsUrl ?? c.targetUrl})` : ""}`).join(", ");
        return {
            count: failed.length,
            text: `${repoScopeNote(repo)}Failing checks on PR #${row.number}: ${names}. Read their logs with \`gh pr checks ${row.number}\` and \`gh run view --log-failed <run-id>\` (run inside that repository), find the cause in this branch's changes, and fix it at the source.`,
        };
    }

    // What an address-comments job tells the agent: the picked comments of one repository's PR, one line each.
    private async commentsText(task: TaskRow, repo: string, commentIds: number[]): Promise<{ text: string; count: number; picked?: PrComment[] }> {
        const row = this.prRow(task.id, repo);
        if (!row?.number || !commentIds.length) return { text: "", count: 0 };
        const comments = await this.prComments(task.id, repo);
        if (!comments) throw new Error(`could not fetch PR comments for ${repoLabel(repo)} — re-poll and try again`);
        const wanted = new Set(commentIds);
        const picked = [...comments.human, ...comments.automation].filter((c) => wanted.has(c.id));
        if (!picked.length) return { text: "", count: 0 };
        return { count: picked.length, picked, text: `${repoScopeNote(repo)}${picked.length} comment(s) on PR #${row.number} picked by the human to address (not necessarily a CI failure):\n${picked.map(describePrComment).join("\n")}` };
    }

    // Batched PR jobs — the user's ask (2026-09-21): "batch jobs for agent after PR creation - e.g. rebase onto latest
    // base, address comments, fix CI and custom instructions in the same run to save time". One pr_fix run does every
    // job the human ticked, in order: the rebase's mechanical pass runs here first (only conflicts reach the agent);
    // failing checks, picked comments and free-text instructions become numbered sections of the run's brief. The
    // usual pr_fix cycle follows — the agent commits, the human reviews the diff, one push (force-with-lease when the
    // rebase rewrote history). Returns a note when nothing needed an agent at all.
    async startPrJobs(
        taskId: string,
        spec: { rebase?: { repos?: string[] | undefined } | null | undefined; fixCi?: { repos?: string[] | undefined } | null | undefined; comments?: Array<{ repo: string; ids: number[] }> | undefined; instructions?: string | undefined; files?: SharedFile[] | undefined },
    ): Promise<{ started: boolean; note: string }> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        if (!task.branch || !task.worktree_path) throw new Error("the task has no branch/worktree yet");
        const env = this.env(task.env_id);
        // Jobs per repository: each repository's jobs run as their own parallel PR Fix round (startPrRound).
        const byRepo = new Map<string, string[]>();
        const addJob = (repo: string, text: string): void => {
            byRepo.set(repo, [...(byRepo.get(repo) ?? []), text]);
        };
        const summary: string[] = [];
        let headsBefore: Map<string, string> | null = null;
        let rebasedRepos: string[] = [];
        if (spec.rebase) {
            const pass = await this.rebasePlainPass(task, env, spec.rebase.repos);
            headsBefore = pass.headsBefore;
            rebasedRepos = pass.repos.filter((r) => !pass.conflicted.includes(r));
            const done = pass.plain.filter((l) => l.startsWith("✅"));
            for (const conflictedRepo of pass.conflicted) {
                const bases = `${repoLabel(conflictedRepo)}: origin/${this.baseBranchOf(task, env, conflictedRepo)}`;
                addJob(
                    conflictedRepo,
                    `Rebase onto the latest base. Stagehand already tried a plain \`git rebase --onto\` of this branch's own commits: ${done.length ? `it went through in ${done.map((l) => l.replace(/^✅ /, "")).join("; ")}; ` : ""}it CONFLICTED in ${pass.conflicted.map(repoLabel).join(", ")} and was aborted there (those checkouts are exactly as they were). In each of those repositories run \`git fetch origin <base>\` and \`git rebase origin/<base>\` (${bases}) — a checkout with uncommitted changes or untracked files: \`git stash push --include-untracked\` before the rebase and \`git stash pop\` after it, never commit or discard them — resolve the conflicts in the spirit of this task's change (keep this task's behaviour, take the base's changes for everything else; drop a commit of this branch that the base now already provides, e.g. a duplicate merge migration), \`git add\` + \`git rebase --continue\` until done — never \`--abort\` and leave it, never \`-i\`. Do the rebase BEFORE the other jobs so they are made on top of the rebased history.`,
                );
            }
            if (pass.conflicted.length) summary.push(`rebase (conflicts in ${pass.conflicted.map(repoLabel).join(", ")})`);
            else if (pass.repos.length || pass.fastForwarded.length) summary.push("rebase (done mechanically)");
            const setAside = pass.plain.filter((l) => l.startsWith("📦") || (l.startsWith("⚠️") && l.includes("set aside")));
            if (done.length || setAside.length) this.addMessage(taskId, "agent", `🔀 Rebase (batched): ${done.map((l) => l.replace(/^✅ /, "")).join("; ")}${pass.conflicted.length ? ` — conflicts in ${pass.conflicted.map(repoLabel).join(", ")} go to the agent` : ""}${setAside.length ? `\n${setAside.join("\n")}` : ""}`);
        }
        if (spec.fixCi) {
            const repos = spec.fixCi.repos?.length ? spec.fixCi.repos : this.prRepos(env);
            for (const repo of repos) {
                const ci = await this.ciFailureText(task, env, repo);
                if (ci.count) {
                    addJob(repo, ci.text);
                    summary.push(`fix CI (${repoLabel(repo)}: ${ci.count} failing)`);
                }
            }
        }
        const addressed: Array<{ repo: string; comments: PrComment[] }> = [];
        for (const c of spec.comments ?? []) {
            const t = await this.commentsText(task, c.repo, c.ids);
            if (t.count) {
                addJob(c.repo, t.text);
                summary.push(`${t.count} comment(s) on ${repoLabel(c.repo)}`);
                addressed.push({ repo: c.repo, comments: t.picked ?? [] });
            }
        }
        await this.recordFixComments(task, addressed);
        if (spec.instructions?.trim() || spec.files?.length) {
            // Instructions go with every repository that has work; alone, they are one job on the task root.
            const text = `Instructions from the human (do exactly this, nothing more):\n\n${(spec.instructions ?? "").trim() || "See the attached file(s)."}${renderSharedFiles(spec.files ?? [], this.taskDir(taskId))}`;
            if (byRepo.size === 0) addJob("", text);
            else for (const repo of [...byRepo.keys()]) addJob(repo, text);
            summary.push("instructions");
        }
        const jobCount = [...byRepo.values()].reduce((n, l) => n + l.length, 0);
        if (jobCount === 0) {
            // Only a clean mechanical rebase (or nothing at all): no agent needed — finish it the way the Rebase button does.
            if (headsBefore && rebasedRepos.length) {
                const lines = await this.finishRebase(task, env, rebasedRepos, headsBefore);
                this.addMessage(taskId, "agent", `🔀 Batched jobs: only the rebase was needed and it went through mechanically.\n${lines.join("\n")}`);
                this.emitTask(taskId);
                return { started: false, note: "rebased mechanically; nothing else to do — no agent run" };
            }
            throw new Error("nothing to do: no failing checks, no comments picked, no instructions, and the branch is up to date");
        }
        const jobs: Record<string, string> = {};
        for (const [repo, list] of byRepo) {
            jobs[repo] =
                `This run batches ${list.length} job(s) the human ticked${repo ? ` for ${repoLabel(repo)}` : ""} — do them in this order, commit as you go (one commit per job is fine), then write the output file covering all of them:\n\n` +
                list.map((j, i) => `### Job ${i + 1} of ${list.length}\n\n${j}`).join("\n\n");
        }
        const rounds = this.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'pr_fix'`).get(taskId) as { n: number };
        this.setStage(taskId, "pr_fix");
        this.startPrRound(taskId, jobs, { attempt: rounds.n + 1, operation: "pr_fix_comments" });
        this.autopilotHuman(taskId);
        return { started: true, note: summary.join(" · ") };
    }

    // `git rebase --onto origin/<base> <parent of the oldest own commit>`: replays exactly this checkout's own commits
    // (on neither the base nor the trunk), non-interactively. Any conflict aborts and restores the checkout to where it
    // was; the caller hands that checkout to the agent.
    private async plainRebase(cwd: string, env: EnvRow, base: string, headBefore: string): Promise<{ ok: true; replayed: number } | { ok: false; conflict: string }> {
        const own = (await this.git(cwd, ["rev-list", "--reverse", "HEAD", `^origin/${base}`, `^origin/${env.base_branch}`], env).catch(() => "")).split("\n").filter(Boolean);
        if (own.length === 0) return { ok: true, replayed: 0 };
        try {
            await this.git(cwd, ["-c", "core.editor=true", "-c", "rebase.autoStash=false", "rebase", "--onto", `origin/${base}`, `${own[0]}^`], env);
            return { ok: true, replayed: own.length };
        } catch (e) {
            const files = (await this.git(cwd, ["diff", "--name-only", "--diff-filter=U"], env).catch(() => "")).split("\n").filter(Boolean);
            await this.git(cwd, ["rebase", "--abort"], env).catch(() => "");
            if (headBefore) await this.git(cwd, ["reset", "--hard", headBefore], env).catch(() => "");
            return { ok: false, conflict: files.length ? files.slice(0, 6).join(", ") + (files.length > 6 ? ", …" : "") : gitErrorTail(e) };
        }
    }

    // After the checkouts moved (plain or agent rebase): abort anything left half-way, force-push with lease where the
    // env allows it and the branch is on GitHub (PR checks restart; tasks stacked on this branch get queued for their
    // own rebase), and re-sync dependencies when a lockfile moved. Returns the per-repo report lines.
    private async finishRebase(task: TaskRow, env: EnvRow, repos: string[], headsBefore: Map<string, string>): Promise<string[]> {
        const rules = rulesOf(this.configDirOf(env));
        const lines: string[] = [];
        let pushed = false;
        for (const repo of repos) {
            const base = this.baseBranchOf(task, env, repo);
            const cwd = this.checkoutOf(task, env, repo);
            // A rebase left half-way is never pushed: abort it so the checkout is usable, and say so.
            const inProgress = await this.git(cwd, ["rev-parse", "--git-path", "rebase-merge"], env).then((p) => existsSync(join(cwd, p.trim())), () => false);
            if (inProgress) {
                await this.git(cwd, ["rebase", "--abort"], env).catch(() => "");
                lines.push(`❌ ${repoLabel(repo)}: the rebase was left unfinished — aborted, branch unchanged`);
                continue;
            }
            const upToDate = await this.git(cwd, ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], env).then(() => true, () => false);
            if (!upToDate) {
                lines.push(`⚠️ ${repoLabel(repo)}: not rebased (still behind origin/${base})`);
                continue;
            }
            const remote = await this.git(cwd, ["ls-remote", "--heads", "origin", task.branch!], env).catch(() => "");
            if (!remote.trim()) {
                lines.push(`✅ ${repoLabel(repo)}: on origin/${base} now; the branch is not on GitHub yet, nothing to push`);
                continue;
            }
            if (!rules.allowPush) {
                lines.push(`✅ ${repoLabel(repo)}: on origin/${base} now; this env forbids agent pushes — push it yourself: \`git push --force-with-lease origin ${task.branch}\``);
                continue;
            }
            try {
                await this.git(cwd, ["push", "--force-with-lease", "origin", task.branch!], env);
                this.resetPrState(task.id, repo, await this.headSha(cwd, env));
                pushed = true;
                lines.push(`✅ ${repoLabel(repo)}: force-pushed (with lease); PR checks restart`);
            } catch (e) {
                lines.push(`❌ ${repoLabel(repo)}: rebased, but the push failed: ${gitErrorTail(e)}`);
            }
        }
        // The env's rebase command: what a rebase makes stale in the worktree — per-task test databases built for
        // the old migration graph (INV-135, 2026-09-25: DuplicateColumn under --reuse-db, so Code Review ran no tests).
        if (env.rebase_command?.trim() && task.worktree_path && repos.length) {
            try {
                const wt = task.worktree_path;
                await this.serialSetup(wt, () => runWorktreeSetup(wt, env.path, withPrepare(env, env.rebase_command!), parseEnvVars(env.env_vars)));
                lines.push("🧹 rebase command ran");
            } catch (e) {
                lines.push(`❌ rebase command failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
            }
        }
        const resync = await this.resyncAfterHistoryChange(task, env, headsBefore);
        if (resync) lines.push(resync);
        if (pushed) {
            this.pollPrSoon(task.id);
            this.onBranchRewritten(env, task.branch!);
        }
        return lines;
    }

    // ---------- stacked tasks: keep children on their parent's rewritten branch ----------

    // Tasks whose base is this branch (stacked on it) need a rebase after its history was force-pushed: queued here,
    // started at once when idle, otherwise by the scheduler tick once their current run is over.
    // task id → why (shown in the Chat header of the rebase it triggers) and which repositories (undefined = all).
    private readonly pendingRebase = new Map<string, { reason: string; repos?: string[] | undefined }>();
    // Queue a rebase for some repositories of a task; a second request for the same task widens the set (any request
    // without a repo list means every repository).
    private queueRebase(taskId: string, reason: string, repos?: string[]): void {
        const cur = this.pendingRebase.get(taskId);
        if (!cur) {
            this.pendingRebase.set(taskId, { reason, repos: repos ? [...repos] : undefined });
            return;
        }
        const all = !cur.repos || !repos;
        this.pendingRebase.set(taskId, { reason: cur.reason === reason ? reason : `${cur.reason}; ${reason}`, repos: all ? undefined : [...new Set([...cur.repos!, ...repos!])] });
    }
    // Tasks of `env` with at least one repository stacked on `branch` (base_branch may be a per-repo map).
    private childrenOf(env: EnvRow, branch: string): TaskRow[] {
        const candidates = this.db.prepare(`SELECT * FROM tasks WHERE env_id = ? AND base_branch IS NOT NULL AND stage != 'done'`).all(env.id) as TaskRow[];
        return candidates.filter((t) => this.basedOn(t, env, branch).length > 0);
    }

    private onBranchRewritten(env: EnvRow, branch: string): void {
        const children = this.childrenOf(env, branch).filter((t) => t.branch && t.worktree_path);
        for (const c of children) this.queueRebase(c.id, `the base branch \`${branch}\` was rewritten`, this.basedOn(c, env, branch));
        if (children.length) this.processPendingRebases();
    }

    // One repository's PR of a parent merged (a multi-repo parent's PRs merge one at a time): every child stacked on
    // the parent's branch IN THAT REPOSITORY moves that repository to the trunk and rebases only that checkout; its
    // other repositories keep waiting for their own PR. Idempotent — a child already moved is not stacked any more.
    private onParentRepoMerged(parent: TaskRow, env: EnvRow, repo: string): void {
        if (!parent.branch) return;
        const children = this.childrenOf(env, parent.branch).filter((c) => this.basedOn(c, env, parent.branch!).includes(repo));
        for (const child of children) {
            const bases = { ...this.baseBranchesOf(child, env), [repo]: env.base_branch };
            this.db.prepare(`UPDATE tasks SET base_branch = ?, updated_at = ? WHERE id = ?`).run(normalizeBaseBranch(bases, this.prRepos(env), env.base_branch), now(), child.id);
            const where = repo ? ` (${repoLabel(repo)})` : "";
            this.addAgentNote(child.id, `${parent.ticket_id}'s branch \`${parent.branch}\` merged into \`${env.base_branch}\`${where} — the task now compares against \`${env.base_branch}\` there; rebasing that checkout onto it`);
            this.emitTask(child.id);
            if (child.branch && child.worktree_path) this.queueRebase(child.id, `${parent.ticket_id}${where} merged into \`${env.base_branch}\``, [repo]);
        }
        if (children.length) this.processPendingRebases();
    }

    // A task's PR(s) merged: every task stacked on its branch (base_branch = that branch) now belongs on the trunk. A
    // child WITH a PR gets the same from GitHub's retarget (pollPr) — this covers children that have no PR yet, whose
    // base branch is about to disappear from origin (INV-132 on INV-131, 2026-09-20).
    private onParentMerged(parent: TaskRow, env: EnvRow): void {
        if (!parent.branch) return;
        const children = this.childrenOf(env, parent.branch);
        for (const child of children) {
            // Only the repositories that were stacked on the parent move to the trunk; others keep their own base.
            const bases = this.baseBranchesOf(child, env);
            for (const repo of this.basedOn(child, env, parent.branch)) bases[repo] = env.base_branch;
            this.db.prepare(`UPDATE tasks SET base_branch = ?, updated_at = ? WHERE id = ?`).run(normalizeBaseBranch(bases, this.prRepos(env), env.base_branch), now(), child.id);
            this.addAgentNote(child.id, `${parent.ticket_id}'s branch \`${parent.branch}\` merged into \`${env.base_branch}\` — the task now compares against \`${env.base_branch}\`; rebasing the branch onto it`);
            this.emitTask(child.id);
            if (child.branch && child.worktree_path) this.queueRebase(child.id, `${parent.ticket_id} merged into \`${env.base_branch}\``, this.basedOn(child, env, parent.branch!));
        }
        if (children.length) this.processPendingRebases();
    }

    private processPendingRebases(): void {
        for (const [id, { reason, repos }] of [...this.pendingRebase]) {
            const task = this.getTask(id);
            if (!task) {
                this.pendingRebase.delete(id);
                continue;
            }
            if (task.status === "running" || this.instructing.has(id)) continue;
            this.pendingRebase.delete(id);
            void this.startRebase(id, { auto: reason, ...(repos ? { repos } : {}) }).catch((e) => {
                const msg = String((e as Error).message ?? e);
                if (/already up to date/.test(msg)) return;
                this.addMessage(id, "agent", `🔀 Auto-rebase onto the latest base (${this.baseBranchLabel(task, this.env(task.env_id))}) not started: ${msg}`);
                this.emitTask(id);
            });
        }
    }

    // After a rebase / reset moved a checkout: if a dependency manifest or lockfile changed between the old and new HEAD,
    // run the env's setup command again (it is idempotent — the DualEntry one compares the lockfile sha and runs
    // `npm ci` only when it moved) so node_modules / .venv match the code the checkout now holds. Otherwise the FE/BE
    // start with "Can't resolve '<package>'" (INV-131 after being moved onto INV-130's frontend, 2026-09-18).
    // One setup / rebase command at a time per worktree: two rebases of one task's repositories started seconds apart
    // each re-ran the setup command, and the two \`npm ci\` runs collided (ENOTEMPTY in node_modules, INV-135,
    // 2026-09-28). Queued behind each other, the second finds the lockfile sha already current and does nothing.
    private readonly worktreeSetups = new Map<string, Promise<unknown>>();
    private serialSetup<T>(worktree: string, fn: () => Promise<T>): Promise<T> {
        const next = (this.worktreeSetups.get(worktree) ?? Promise.resolve()).catch(() => undefined).then(fn);
        this.worktreeSetups.set(worktree, next);
        void next.catch(() => undefined).then(() => {
            if (this.worktreeSetups.get(worktree) === next) this.worktreeSetups.delete(worktree);
        });
        return next;
    }

    private async resyncAfterHistoryChange(task: TaskRow, env: EnvRow, headsBefore: Map<string, string>): Promise<string | null> {
        if (!env.setup_command || !task.worktree_path) return null;
        const manifests = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "poetry.lock", "uv.lock", "requirements.txt"];
        const changed: string[] = [];
        for (const [repo, before] of headsBefore) {
            if (!before) continue;
            const cwd = this.checkoutOf(task, env, repo);
            const files = (await this.git(cwd, ["diff", "--name-only", before, "HEAD"], env).catch(() => "")).split("\n").filter((f) => manifests.includes(f.split("/").pop() ?? ""));
            if (files.length) changed.push(`${repoLabel(repo)}: ${files.join(", ")}`);
        }
        if (changed.length === 0) return null;
        try {
            const wt = task.worktree_path;
            const out = await this.serialSetup(wt, () => runWorktreeSetup(wt, env.path, withPrepare(env, env.setup_command!), { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, task.id) }));
            console.error(`[setup] ${task.ticket_id} (after rebase) ${task.worktree_path}\n${out.slice(-1500)}`);
            // Build caches compiled against the old dependency tree must go too: Next's Turbopack dev cache (.next)
            // built before an `npm ci` crashed the dev server with "turbo-tasks: an internal panic occurred outside
            // the per-task panic boundary" once the FE was restarted on the new node_modules (INV-131, 2026-09-18).
            for (const repo of headsBefore.keys()) {
                const cwd = this.checkoutOf(task, env, repo);
                for (const cache of [".next", join("node_modules", ".cache")]) {
                    const p = join(cwd, cache);
                    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
                }
            }
            return `🔧 dependencies re-synced (setup command re-run: ${changed.join("; ")} changed; build caches cleared)`;
        } catch (e) {
            return `❌ dependencies NOT re-synced (${changed.join("; ")} changed; setup command failed: ${String((e as Error).message ?? e).slice(0, 160)}) — run the env's setup command in the worktree by hand`;
        }
    }

    // "Fix with agent" on a BE/FE that failed to start: the task's own agent (its session, full context of the branch)
    // reads the service log and the command, repairs the cause in the worktree, and Stagehand restarts the service once
    // the run is over — so the result is a real second start, not the agent's opinion that it should work now. Runs
    // without the guard hook like Chat and the git edits (an explicit human request, not a pipeline stage); the task's
    // stage/status are restored afterward. Starts synchronously (bad requests surface to the button) and reports in Chat.
    async fixService(taskId: string, kind: ServiceKind): Promise<void> {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — wait for it to finish");
        const env = this.env(task.env_id);
        const row = this.services.get(taskId, kind);
        if (!row) throw new Error(`no ${kind.toUpperCase()} start to fix — run it first`);
        const probed = await this.services.probe(row);
        if (probed.state !== "failed") throw new Error(`the ${kind.toUpperCase()} is ${probed.state}, nothing to fix`);
        const cd = this.configDirOf(env);
        const usable = this.usableAccounts(cd.path);
        const acc = usable.find((a) => a.id === task.account_id) ?? usable.find((a) => a.id === accountOrderOf(env)[0]) ?? usable[0];
        if (!acc) throw new Error(`no AI account can run in config dir ${cd.name}`);
        const cwd = task.worktree_path ?? env.path;
        const be = kind === "fe" ? this.services.get(taskId, "be") : undefined;
        const serviceEnv: Record<string, string> = {
            ...parseEnvVars(env.env_vars),
            PORT: String(row.port),
            STAGEHAND_PORT: String(row.port),
            ...(be ? { STAGEHAND_BE_URL: be.url, STAGEHAND_BE_PORT: String(be.port) } : {}),
        };
        const prevStatus = task.status;
        const prevLine = task.status_line;
        this.setTaskStatus(taskId, "running", `Fixing the ${kind.toUpperCase()} start failure with the agent…`);
        const prompt = renderPrompt("fix-service.md", {
            kind: kind.toUpperCase(),
            cwd,
            command: row.command,
            port: String(row.port),
            url: row.url,
            error: probed.error ?? "did not start",
            logPath: row.log_path,
            logTail: this.services.logTail(row, 80) || "(the log is empty)",
            serviceEnv: Object.entries(serviceEnv).map(([k, v]) => `${k}=${v}`).join("\n") || "(none)",
            taskNotes: task.notes?.trim() ? `\nThe human's standing notes on this task: ${task.notes.trim()}` : "",
        });
        const run = startClaude({
            prompt,
            cwd,
            configDir: cd.path,
            extraEnv: { ...parseEnvVars(env.env_vars), ...taskDbEnv(this.db, taskId), ...authEnv(acc) },
            ...this.sessionArgs(task),
            maxTurns: 60,
            ...((): { model?: string } => {
                const m = this.modelForOperation(task, "fix_service", acc);
                return m ? { model: m } : {};
            })(),
        });
        void run.done.then(async (outcome: RunOutcome) => {
            if (outcome.result) recordUsage(this.db, { accountId: acc.id, envId: env.id, taskId, runId: null, kind: "fix-service", stage: null }, outcome.result);
            const reply = outcome.result?.result?.trim() || (outcome.exitCode !== 0 ? `(did not finish: ${outcome.stderr.trim().split("\n").slice(-2).join(" ").slice(-200) || `exit ${outcome.exitCode}`})` : "(no reply)");
            this.setTaskStatus(taskId, "running", `Restarting the ${kind.toUpperCase()} after the agent's fix…`);
            let restart: string;
            try {
                await this.services.stop(taskId, kind);
                const fresh = await this.services.start(task, env, kind);
                const r = await this.services.waitUntilUp(fresh);
                restart = r.ok ? `✅ The ${kind.toUpperCase()} was restarted and is listening on ${fresh.url}.` : `❌ The ${kind.toUpperCase()} was restarted but failed again: ${r.error}`;
            } catch (e) {
                restart = `❌ Could not restart the ${kind.toUpperCase()}: ${String((e as Error).message ?? e)}`;
            }
            this.setTaskStatus(taskId, prevStatus, prevLine ?? `${kind.toUpperCase()} start fix finished — see Chat`);
            this.addMessage(taskId, "agent", `🔧 Fix the ${kind.toUpperCase()} start failure:\n\n${reply}\n\n${restart}`);
            this.emitTask(taskId);
        });
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

    private async onRunClosed(taskId: string, runId: string, def: StageDef, account: AccountRow, outcome: RunOutcome, opts: DispatchOpts, stoppedBackground = 0): Promise<void> {
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

        const refused = this.permissionFailures.get(runId);
        if (refused) {
            this.permissionFailures.delete(runId);
            finish("failed", refused);
            // Once more, on a model known to honour auto mode: a session stuck on Haiku heals itself (the retry resumes
            // it with --model, which the session keeps from then on). A second refusal is for the human.
            const retryModel = opts.modelRetried ? null : (accountModelsOf(account).default ?? REFUSAL_RETRY_MODEL);
            if (retryModel) {
                this.addMessage(taskId, "agent", `⛔ ${def.label} stopped at its first refused edit — ${refused}\n\nRunning it again once on ${retryModel}.`);
                this.dispatch(taskId, def.stage, { ...opts, model: retryModel, modelRetried: true });
                return;
            }
            this.addMessage(taskId, "agent", `⛔ ${def.label} stopped at its first refused edit — ${refused}`);
            this.setTaskStatus(taskId, "failed", `${def.label} · ${refused.slice(0, 160)}`);
            return;
        }
        // A run that ended with a successful result did its work, whatever the last window event said.
        const limited = rateLimitHit(outcome.lastRateLimit) && !(outcome.result && !outcome.result.is_error);
        if (limited && outcome.lastRateLimit?.resetsAt) {
            finish("rate_limited", "rate limited");
            this.queueRateLimited(task, account, outcome.lastRateLimit.resetsAt, `rate limited on ${account.name}`);
            return;
        }
        // The agent handed a decision to the human (questions.json written by this run, no valid output): park the task
        // until the answers arrive; the same session is then resumed with them.
        const asked = this.questionsAskedDuringRun(taskId, runId);
        if (asked && !(def.contract && def.outputFile && this.outputWrittenDuringRun(taskId, def.outputFile, runId) && (await this.validateOutput(taskId, def)).ok)) {
            finish("blocked", `asked the human ${asked.questions.length} question(s)`);
            await this.parkOrAutoAnswer(taskId, runId, def, asked, opts);
            return;
        }
        if (!outcome.result || outcome.result.is_error || (outcome.exitCode ?? 1) !== 0) {
            // A run that wrote its output file and then died (typically max turns before the final "DONE") still did the work.
            // Output that was written but does not validate goes back through the normal contract retry — the agent gets
            // the validation error, not a "stopped before writing" message that hides it (INV-132, 2026-09-17: design.md
            // only lacked bold lead-ins, and two cap-hit runs reported it as never written).
            if (def.contract && def.outputFile && this.outputWrittenDuringRun(taskId, def.outputFile, runId)) {
                const validation = await this.validateOutput(taskId, def);
                if (validation.ok) {
                    finish("done", `ended with ${outcome.result?.subtype ?? `exit ${outcome.exitCode}`} after writing the output`, JSON.stringify(validation.data));
                    this.afterStage(taskId, def, validation.data);
                    return;
                }
                this.retryContract(taskId, def, opts, validation.error, finish);
                return;
            }
            // The turn cap is a checkpoint, not a verdict: the same session goes on where it stopped, a couple of times.
            if (outcome.result?.subtype === "error_max_turns" && !def.freshSession && (opts.continuations ?? 0) < MAX_CONTINUATIONS) {
                const n = (opts.continuations ?? 0) + 1;
                finish("failed", `turn cap reached (${outcome.result.num_turns ?? "?"} turns) — continuing the session (${n}/${MAX_CONTINUATIONS})`);
                this.dispatch(taskId, def.stage, { ...opts, continuations: n, notes: continueNote(n, def.outputFile, opts.notes) });
                return;
            }
            const stderrTail = outcome.stderr.trim().split("\n").slice(-3).join(" ").trim();
            const err =
                outcome.result?.result?.trim() ||
                (outcome.result?.subtype === "error_max_turns"
                    ? `stopped at the ${outcome.result.num_turns ?? "?"}-turn cap before writing ${def.outputFile ?? "its output"} — Retry resumes the session`
                    : outcome.result
                      ? `ended with ${outcome.result.subtype}`
                      : stderrTail || `exit ${outcome.exitCode}`);
            // The CLI could not reach its API (DNS, refused connection): the work is untouched, the run goes once more
            // before the task parks (INV-136 and two INV-133 shards, 2026-09-25).
            if (isNetworkError(err) && !opts.netRetried) {
                finish("failed", `${err} — network failure of the run itself; running it once more`);
                this.dispatch(taskId, def.stage, { ...opts, netRetried: true });
                return;
            }
            finish("failed", err);
            this.setTaskStatus(taskId, "failed", `${def.label} · ${err.slice(0, 160)}`);
            return;
        }

        if (def.contract && def.outputFile) {
            // No output and background commands killed at exit: the agent stopped to "wait for the notification". The
            // session is resumed once for free with that spelled out; after that the normal contract budget applies.
            const written = this.outputWrittenDuringRun(taskId, def.outputFile, runId);
            const pending = stoppedBackground > 0 && !written ? backgroundNote(stoppedBackground) : "";
            const free = !!pending && !opts.backgroundResumed;
            // Every run must write its own output. A PR fix resumes the task session: an agent that "remembers" fixing
            // CI may reply DONE without touching anything, and the stale pr-fix.json from the previous fix then validates
            // as if it were this run's (INV-131, 2026-09-18: attempt 3 for a Query-budget failure returned attempt 2's
            // migration summary). The same for an Implementation round whose edits never landed (INV-136, 2026-09-24:
            // every write refused, impl.json of the previous round taken for the result, the task went on to review).
            if (!written) {
                const why =
                    def.stage === "pr_fix"
                        ? `it still describes the previous fix. This run is about the check(s) named in the instructions above: make the fix, commit it, then write ${def.outputFile} fresh with what you did.`
                        : `it still describes an earlier run of this stage. Do this run's work (the notes above say what), then write ${def.outputFile} fresh for what THIS run did.`;
                this.retryContract(taskId, def, opts, `${pending}${def.outputFile} was not written by this run — ${why}`, finish, free);
                return;
            }
            const validation = await this.validateOutput(taskId, def);
            if (!validation.ok) {
                this.retryContract(taskId, def, opts, `${pending}${validation.error}`, finish, free);
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

    // The stage's output file exists but fails its contract: re-run the stage (same session outside the fresh-session
    // QA stages) with the validation error as notes, up to MAX_CONTRACT_ATTEMPTS; then fail for the human.
    // `free`: the run ended with background commands pending (see backgroundNote) — resumed without spending a
    // contract attempt, once per round.
    private retryContract(taskId: string, def: StageDef, opts: DispatchOpts, error: string, finish: (status: RunRow["status"], error?: string, resultJson?: string) => void, free = false): void {
        const n = opts.contractAttempt ?? 1;
        finish("failed", `contract: ${error}`);
        if (free || n < MAX_CONTRACT_ATTEMPTS) {
            const next = free ? n : n + 1;
            this.dispatch(taskId, def.stage, {
                ...(opts.attempt ? { attempt: opts.attempt } : {}),
                contractAttempt: next,
                ...(free || opts.backgroundResumed ? { backgroundResumed: true } : {}),
                ...(opts.operation ? { operation: opts.operation } : {}),
                notes: free
                    ? `## Your run ended with work still pending — resumed\n\n${error}\n\nFinish the work in the foreground, then write \`${this.taskDir(taskId)}/${def.outputFile}\` and reply DONE.`
                    : `## Output contract violation (fix this and rewrite the file) — attempt ${next} of ${MAX_CONTRACT_ATTEMPTS}\n\n${error}\n\n` +
                      `Rewrite \`${this.taskDir(taskId)}/${def.outputFile}\` to match the contract exactly, then reply DONE.`,
            });
            return;
        }
        this.setTaskStatus(taskId, "failed", `${def.label} · output contract failed ${MAX_CONTRACT_ATTEMPTS} times`);
    }

    // ---------- questions: the agent asks, the human answers, the stage resumes ----------

    // questions.json written (or rewritten) by this run and valid; a stale file from an earlier run does not count.
    private questionsAskedDuringRun(taskId: string, runId: string, file = "questions.json"): QuestionsFile | null {
        if (!this.outputWrittenDuringRun(taskId, file, runId)) return null;
        const raw = this.readArtifactJson<unknown>(taskId, file);
        const parsed = QuestionsFile.safeParse(raw);
        return parsed.success ? parsed.data : null;
    }

    private parkOnQuestions(taskId: string, runId: string | null, def: StageDef, asked: QuestionsFile, opts: DispatchOpts): void {
        const id = randomUUID();
        // Keep what the run was started with (reviewer notes, PR-fix failure text, attempt) so the resumed run gets the same brief.
        const resume = { notes: opts.notes ?? null, attempt: opts.attempt ?? 1, contractAttempt: opts.contractAttempt ?? 1, extraVars: opts.extraVars ?? {}, ...(opts.operation ? { operation: opts.operation } : {}) };
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
    answerQuestions(taskId: string, questionRowId: string, answers: Record<string, string>, files: SharedFile[] = []): void {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress");
        const row = this.db.prepare(`SELECT * FROM questions WHERE id = ? AND task_id = ?`).get(questionRowId, taskId) as QuestionRow | undefined;
        if (!row) throw new Error("questions not found");
        if (row.answers) throw new Error("these questions were already answered");
        const stored = JSON.parse(row.questions) as QuestionsFile & { resume?: { notes: string | null; attempt: number; contractAttempt?: number; extraVars: Record<string, string>; operation?: DispatchOpts["operation"] } };
        this.db.prepare(`UPDATE questions SET answers = ?, answered_at = ? WHERE id = ?`).run(JSON.stringify(answers), now(), row.id);
        this.addMessage(taskId, "user", stored.questions.map((q) => `**${q.id}** ${q.text}\n→ ${answers[q.id]?.trim() || "(no answer — decide yourself)"}`).join("\n\n"), null, null, files);
        // A corrected scenario step/seed/assert the human approved is written into design.json here (deterministic),
        // so a fresh QA session runs it instead of re-deriving the defect and asking again.
        try {
            const requests: FixRequest[] = [];
            for (const q of stored.questions) {
                const fix = parseStepFixAnswer(q.text, answers[q.id]);
                if (fix) requests.push({ fix, by: "human", question: q.text, reason: q.context });
            }
            const applied = applyQaFixes(join(this.taskDir(taskId), "design.json"), requests);
            if (applied.lines.length) this.addAgentNote(taskId, `🛠 Applied to design.json from your answers:\n${applied.lines.map((a) => `- ${a}`).join("\n")}`);
            // An approved correction that did not apply is said out loud: silence let the runner ask the same question again.
            if (applied.skipped.length) this.addAgentNote(taskId, `⚠️ Not applied to design.json from your answers — the runner still sees the old scenario:\n${applied.skipped.map((a) => `- ${a}`).join("\n")}`);
            if (applied.changes.length) this.onQaChanges(taskId, row.stage, applied.changes);
        } catch (e) {
            console.warn(`[stagehand] applying approved step fixes for ${task.ticket_id}: ${String((e as Error).message ?? e)}`);
        }
        this.resumeAfterAnswers(taskId, row.stage, renderAnswers(stored.questions, answers) + renderSharedFiles(files, this.taskDir(taskId)), stored.resume);
    }

    // The resumed run after the answers (the human's or Jev's): the same brief the asking run had, the answers on top,
    // and — for a QA pass that asked mid-way — only the scenarios still open.
    private resumeAfterAnswers(taskId: string, stage: Stage, answerNotes: string, resume: { notes: string | null; attempt: number; contractAttempt?: number | undefined; extraVars: Record<string, string>; operation?: DispatchOpts["operation"] | undefined } | undefined): void {
        const prior = resume?.notes?.trim();
        this.setStage(taskId, stage);
        let extraVars: Record<string, string> = resume?.extraVars ?? {};
        if (stage === "qa_baseline" || stage === "manual_qa") {
            const pass = stage === "qa_baseline" ? "before" : "after";
            const recorded = this.readPartial(taskId, pass);
            if (recorded.length) {
                const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
                const remaining = this.qaScenariosForPass(design, stage).map((s) => s.id).filter((id) => !recorded.some((r) => r.id === id));
                extraVars = { ...extraVars, ...this.resumeVars(taskId, pass, recorded, remaining) };
                delete extraVars["seedReport"];
            }
        }
        this.dispatch(taskId, stage, {
            notes: prior ? `${answerNotes}\n\n---\n\n${prior}` : answerNotes,
            attempt: resume?.attempt ?? 1,
            contractAttempt: resume?.contractAttempt ?? 1,
            ...(resume?.operation ? { operation: resume.operation } : {}),
            ...(Object.keys(extraVars).length ? { extraVars } : {}),
        });
    }

    // ---------- QA corrections: Jev's approval, the change log, the baseline that a change makes stale ----------

    // Every QA question that proposes a correction goes past Jev before it reaches the human (qa-autofix.ts): the
    // mechanical kinds the environment allows are applied at once, the rest wait for the human with Jev's reading shown.
    // When nothing is left to ask, the pass resumes right away.
    private async parkOrAutoAnswer(taskId: string, runId: string | null, def: StageDef, asked: QuestionsFile, opts: DispatchOpts): Promise<void> {
        if (def.stage !== "qa_baseline" && def.stage !== "manual_qa") {
            this.parkOnQuestions(taskId, runId, def, asked, opts);
            return;
        }
        let outcome: { remaining: AgentQuestion[]; answers: Record<string, string>; notes: string[] };
        try {
            outcome = await this.autoApproveQaFixes(taskId, def, asked);
        } catch (e) {
            console.warn(`[stagehand] qa auto-fix ${taskId}: ${String((e as Error).message ?? e).slice(0, 200)}`);
            this.parkOnQuestions(taskId, runId, def, asked, opts);
            return;
        }
        if (outcome.notes.length) this.addMessage(taskId, "agent", outcome.notes.join("\n"));
        if (outcome.remaining.length) {
            this.parkOnQuestions(taskId, runId, def, { questions: outcome.remaining }, opts);
            return;
        }
        // Everything answered by Jev: record the round as answered, consume the file, resume.
        const auto = asked.questions.filter((q) => outcome.answers[q.id] !== undefined);
        this.db
            .prepare(`INSERT INTO questions (id, task_id, run_id, stage, questions, answers, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), taskId, runId, def.stage, JSON.stringify({ questions: auto }), JSON.stringify(outcome.answers), now(), now());
        const p = join(this.taskDir(taskId), "questions.json");
        if (existsSync(p)) renameSync(p, join(this.taskDir(taskId), `questions-${Date.now()}.json`));
        const answerNotes = `## Corrections applied by Stagehand (approved by Jev, no human involved) — continue from where you stopped\n\n${auto.map((q) => `- **${q.id}** ${q.text}\n  → applied: ${outcome.answers[q.id]!.slice(0, 300)}`).join("\n")}`;
        this.resumeAfterAnswers(taskId, def.stage, answerNotes, { notes: opts.notes ?? null, attempt: opts.attempt ?? 1, contractAttempt: opts.contractAttempt ?? 1, extraVars: opts.extraVars ?? {}, ...(opts.operation ? { operation: opts.operation } : {}) });
    }

    private async autoApproveQaFixes(taskId: string, def: StageDef, asked: QuestionsFile): Promise<{ remaining: AgentQuestion[]; answers: Record<string, string>; notes: string[] }> {
        const task = this.getTask(taskId)!;
        const env = this.env(task.env_id);
        const scope = env.qa_auto_fix ?? DEFAULT_QA_AUTO_FIX;
        const allowed = autoFixKinds(scope);
        const remaining: AgentQuestion[] = [];
        const answers: Record<string, string> = {};
        const notes: string[] = [];
        if (allowed.size === 0 || !jevEnabled(this.cfg)) return { remaining: asked.questions, answers, notes };
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const pass: "before" | "after" = def.stage === "qa_baseline" ? "before" : "after";
        const ticket = renderTicketsForPrompt(this.tickets(task), this.taskDir(taskId));
        const contract = this.designContract(taskId);
        const partial = this.readPartial(taskId, pass);
        const approved: FixRequest[] = [];
        for (const q of asked.questions) {
            const option = proposedOption(q);
            const fix = option ? parseStepFixAnswer(q.text, option) : null;
            const scenario = fix ? design?.qa.find((s) => s.id.toUpperCase() === fix.scenario) : undefined;
            if (!fix || !scenario) {
                remaining.push(q);
                continue;
            }
            const label = `${fix.scenario} ${fix.kind}${fix.index >= 0 ? ` ${fix.index + 1}` : ""}`;
            if (!allowed.has(fix.kind)) {
                remaining.push(q);
                notes.push(`🧭 ${label}: a ${fix.kind} correction waits for you (this environment lets Jev approve ${scope})`);
                continue;
            }
            const dry = applyFixToScenario(scenario as Parameters<typeof applyFixToScenario>[0], fix);
            if (!dry) {
                remaining.push(q);
                continue;
            }
            const guard = guardQaFix(scenario as Parameters<typeof guardQaFix>[0], dry.after, fix.kind);
            if (!guard.ok) {
                remaining.push({ ...q, context: `${q.context ? `${q.context} ` : ""}[Stagehand: not auto-approved — ${guard.reason}]` });
                notes.push(`🧭 ${label}: left for you — ${guard.reason}`);
                continue;
            }
            const observation = partial.find((s) => s.id === scenario.id)?.observation ?? "";
            let verdict;
            try {
                verdict = await jevQaFixVerdict(this.cfg, this.db, { accountId: null, envId: env.id, taskId, runId: null, stage: def.stage }, { ticket, contract, pass, fixKind: fix.kind, question: q.text, reason: q.context ?? "", observation, before: scenario, after: dry.after });
            } catch (e) {
                remaining.push(q);
                notes.push(`🧭 ${label}: left for you — Jev did not answer (${String((e as Error).message ?? e).slice(0, 120)})`);
                continue;
            }
            const decision = decideQaFix(verdict, fix.kind, scope);
            if (!decision.approve) {
                remaining.push({ ...q, context: `${q.context ? `${q.context} ` : ""}[Jev: ${decision.why}]` });
                notes.push(`🧭 ${label}: left for you — ${decision.why}`);
                continue;
            }
            approved.push({ fix, by: "jev", question: q.text, reason: q.context, jev: { legit: verdict.legit, weakens: verdict.weakens, kind: verdict.kind } });
            answers[q.id] = option!;
            notes.push(`🧭 Jev approved ${label} (${decision.why})${q.context ? ` — ${q.context.slice(0, 160)}` : ""}`);
        }
        if (approved.length) {
            const applied = applyQaFixes(join(this.taskDir(taskId), "design.json"), approved);
            if (applied.changes.length) this.onQaChanges(taskId, def.stage, applied.changes);
            if (applied.lines.length) notes.push(`🛠 Applied to design.json:\n${applied.lines.map((l) => `- ${l}`).join("\n")}`);
        }
        return { remaining, answers, notes };
    }

    // What the change must do — the Problem statement and the Suggested approach with its Invariant (an older proposal:
    // its Contract section) — the acceptance Jev judges corrections against.
    private designContract(taskId: string): string {
        const p = join(this.taskDir(taskId), "design.md");
        if (!existsSync(p)) return "";
        const md = readFileSync(p, "utf8");
        const part = (name: string): string | null => new RegExp(`^##[^\\n]*${name}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "im").exec(md)?.[1]?.trim() ?? null;
        const now = [part("problem statement"), part("suggested approach")].filter((x): x is string => !!x);
        return (now.length ? now.join("\n\n") : (part("contract") ?? md)).trim().slice(0, 4000);
    }

    // Every applied correction is logged; a step, assert, seed or scenario change during Manual QA also makes that
    // scenario's baseline stale: the before.json entry is marked superseded. No baseline runs again for it — the
    // baseline belongs to the design stage only (the user, 2026-10-06), so Manual QA compares it without one.
    private onQaChanges(taskId: string, stage: Stage, changes: QaChange[]): void {
        const dir = join(this.taskDir(taskId), "qa");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "changes.json");
        const log = this.readArtifactJson<QaChange[]>(taskId, "qa/changes.json") ?? [];
        writeFileSync(path, JSON.stringify([...log, ...changes], null, 2));
        if (stage !== "manual_qa") return;
        const stale = changes.filter((c) => c.kind !== "teardown");
        if (!stale.length) return;
        for (const c of stale) this.supersedeBaseline(taskId, c.scenario, c.id);
        this.emitTask(taskId);
    }

    private supersedeBaseline(taskId: string, scenarioId: string, changeId: string): void {
        const path = join(this.taskDir(taskId), "qa", "before.json");
        const before = this.readArtifactJson<QaPassResult>(taskId, "qa/before.json");
        if (!before) return;
        const scenarios = before.scenarios.map((s) => (s.id === scenarioId && !s.superseded ? { ...s, superseded: changeId, observation: `superseded — the scenario changed after this baseline (change ${changeId}). ${s.observation}` } : s));
        writeFileSync(path, JSON.stringify({ ...before, scenarios }, null, 2));
    }

    listQaChanges(taskId: string): QaChange[] {
        return this.readArtifactJson<QaChange[]>(taskId, "qa/changes.json") ?? [];
    }

    // Puts the scenario back as it was before the change; the next QA pass runs the original again.
    revertQaChangeById(taskId: string, changeId: string): QaChange {
        const task = this.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("a run is in progress — stop it first");
        const log = this.listQaChanges(taskId);
        const change = log.find((c) => c.id === changeId);
        if (!change) throw new Error("no such change");
        if (change.revertedAt) throw new Error("already reverted");
        if (!revertQaChange(join(this.taskDir(taskId), "design.json"), change)) throw new Error("the scenario is no longer in design.json");
        const reverted = { ...change, revertedAt: now() };
        writeFileSync(join(this.taskDir(taskId), "qa", "changes.json"), JSON.stringify(log.map((c) => (c.id === changeId ? reverted : c)), null, 2));
        this.addMessage(taskId, "agent", `↩️ Reverted the ${change.kind} correction on ${change.scenario} (${change.by === "jev" ? "Jev-approved" : "your answer"}); design.json holds the original again.`);
        this.emitTask(taskId);
        return reverted;
    }

    private async finishBaselineRerun(taskId: string, marker: BaselineRerun): Promise<void> {
        const task = this.getTask(taskId);
        const taskDir = this.taskDir(taskId);
        rmSync(join(taskDir, "qa", "baseline-rerun.json"), { force: true });
        if (!task) return;
        const env = this.env(task.env_id);
        const lines: string[] = [];
        if (task.branch) {
            for (const repo of this.prRepos(env)) {
                const cwd = this.checkoutOf(task, env, repo);
                try {
                    await this.git(cwd, ["checkout", task.branch], env);
                    const head = await this.headSha(cwd, env);
                    if (marker.heads[repo] && head !== marker.heads[repo]) lines.push(`⚠️ ${repoLabel(repo)}: back on ${task.branch} but at ${(head ?? "?").slice(0, 10)}, not ${marker.heads[repo].slice(0, 10)}`);
                } catch (e) {
                    lines.push(`❌ ${repoLabel(repo)}: could not return to ${task.branch}: ${String((e as Error).message ?? e).slice(0, 160)} — run \`git checkout ${task.branch}\` there`);
                }
            }
        }
        await this.services.stopAll(taskId).catch(() => undefined);
        const before = this.readArtifactJson<QaPassResult>(taskId, "qa/before.json");
        const results = marker.ids.map((id) => {
            const s = before?.scenarios.find((x) => x.id === id);
            return `${id} → ${s?.outcome ?? "?"}${s?.observation ? ` (${s.observation.slice(0, 120)})` : ""}`;
        });
        this.addMessage(taskId, "agent", `🔁 Baseline re-run done: ${results.join(" · ")}. Worktree back on ${task.branch ?? "the branch"}.${lines.length ? `\n${lines.join("\n")}` : ""}`);
        this.advance(taskId, marker.next);
    }



    // True when the stage's output file was (re)written after this run started — a stale file from an earlier pass doesn't count.
    private outputWrittenDuringRun(taskId: string, outputFile: string, runId: string): boolean {
        const run = this.db.prepare(`SELECT started_at FROM runs WHERE id = ?`).get(runId) as { started_at: string | null } | undefined;
        const path = join(this.taskDir(taskId), outputFile);
        if (!run?.started_at || !existsSync(path)) return false;
        return statSync(path).mtimeMs >= new Date(run.started_at).getTime() - 1000;
    }

    private async validateOutput(taskId: string, def: StageDef): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
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
        // A resumed QA pass: scenarios the previous attempt recorded (qa/<pass>.partial.json) that the runner did not
        // copy into its output are merged in here, so nothing recorded is lost or driven twice.
        if (def.stage === "qa_baseline" || def.stage === "manual_qa") {
            const qa = parsed.data as QaPassResult;
            const missing = mergeScenarios(this.readCarry(taskId, qa.pass), this.readPartial(taskId, qa.pass)).filter((s) => !qa.scenarios.some((o) => o.id === s.id));
            if (missing.length) {
                qa.scenarios = mergeScenarios(qa.scenarios, missing);
                writeFileSync(path, JSON.stringify(qa, null, 2));
            }
        }
        if (def.stage === "design_proposal") {
            const md = this.designMdProblems(taskId);
            if (md) return { ok: false, error: md };
            const seeds = await this.seedDryRunProblems(taskId, parsed.data as DesignResult);
            if (seeds) return { ok: false, error: seeds };
            const contract = qaContractProblems((parsed.data as DesignResult).qa ?? []);
            if (contract) return { ok: false, error: contract };
            const owner = this.getTask(taskId);
            // The shared dependency is always started before a pass; a design that names it anyway is not wrong.
            const known = owner ? [...componentsOf(this.env(owner.env_id)).map((c) => c.key), ...(this.env(owner.env_id).depends_on_env_id ? [DEPENDENCY_KIND] : [])] : [];
            const unknown = ((parsed.data as DesignResult).qa ?? []).flatMap((s) => (s.services ?? []).filter((k) => !known.includes(k)).map((k) => `${s.id}: "${k}"`));
            if (unknown.length) return { ok: false, error: `QA scenarios name optional components this environment does not define: ${unknown.join(", ")} — available: ${known.length ? known.map((k) => `"${k}"`).join(", ") : "none (drop the services list)"}` };
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

    // Every psql seed step the design wrote is parsed by the real database before the design is accepted: the SQL is
    // run inside BEGIN … ROLLBACK, so a wrong column or table (the way ENG-24349's QA got stuck twice) fails the
    // contract here, when the agent can still fix it, instead of blocking the QA pass. Rows the seed depends on may
    // not exist yet (a ui: step creates them), so only SQL errors count; a database that is not reachable is logged and
    // ignored — that is an environment matter, not the design's.
    private async seedDryRunProblems(taskId: string, design: DesignResult): Promise<string | null> {
        const task = this.getTask(taskId);
        if (!task) return null;
        const env = this.env(task.env_id);
        const cwd = task.worktree_path ?? env.path;
        const problems: string[] = [];
        // Placeholders resolve to harmless values for the dry run; the Django steps roll back anyway.
        const dryVars: QaVars = { beUrl: "http://localhost:0", feUrl: "http://localhost:0", appUrl: "http://localhost:0", qaPass: "dryrun" };
        const django: Array<{ label: string; prefix: string; code: string }> = [];
        for (const s of design.qa ?? []) {
            const all = [...(s.teardown ?? []).map((step, i) => ({ step, label: `${s.id} teardown ${i + 1}` })), ...(s.seed ?? []).map((step, i) => ({ step, label: `${s.id} seed ${i + 1}` }))];
            for (const { step, label } of all) {
                const m = /^\s*(shell|sql)\s*:\s*/i.exec(step);
                if (!m) continue;
                const cmd = fillQaVars(step.slice(m[0].length), dryVars);
                // An interpreter called bare in command position (`cd backend && python manage.py …`) must exist on the
                // orchestrator's PATH; this host has python3 and `poetry run python` but no `python` (INV-130's S2 seed
                // failed in Manual QA with "python: command not found"). Checked with the same login shell the seed runs in.
                const bare = /(?:^|&&|\|\||;|\|)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(python3?|node|ruby|php)\b/.exec(cmd);
                if (bare) {
                    const interp = bare[1]!;
                    try {
                        await execFileAsync("bash", loginShellArgs(`command -v ${interp}`), { cwd, env: loginShellEnv(parseEnvVars(env.env_vars)), timeout: 10_000 });
                    } catch {
                        problems.push(`${label} runs \`${interp}\` directly, which is not on the orchestrator's PATH — invoke it the way the repository's own commands do (\`poetry run ${interp} …\`, \`uv run ${interp} …\`, \`npx …\`)`);
                    }
                }
                const unit = planSeedUnits([{ label, cmd }])[0];
                if (unit?.kind === "django") {
                    django.push({ label, prefix: unit.prefix, code: unit.items[0]!.code });
                    continue;
                }
                if (!/\bpsql\b/.test(cmd) || /<[a-z ]+>/i.test(cmd)) continue;
                const dry = wrapPsqlInRollback(cmd);
                if (dry === cmd) continue;
                try {
                    await execFileAsync("bash", loginShellArgs(dry), { cwd, env: loginShellEnv(parseEnvVars(env.env_vars)), timeout: 60_000, maxBuffer: 1024 * 1024 });
                } catch (e) {
                    const err = e as { stderr?: string; stdout?: string; message?: string };
                    const text = String(err.stderr ?? err.stdout ?? err.message ?? e);
                    const sqlErr = /ERROR:\s+(.+)/.exec(text);
                    if (sqlErr) problems.push(`${label}: the database rejects this SQL — ${sqlErr[1]!.trim().slice(0, 200)}`);
                    else console.warn(`[stagehand] seed dry-run skipped for ${task.ticket_id} ${label}: ${text.trim().split("\n").slice(-1)[0]?.slice(0, 160)}`);
                }
            }
        }
        // Django-shell steps: one process per distinct prefix, every step inside transaction.atomic() and rolled back
        // — an ImportError, a missing model or field, a wrong keyword surfaces here (INV-133's S4 seed imported a
        // model that only exists after the implementation; INV-136's seeds created a fixed sku twice).
        const byPrefix = new Map<string, SeedItem[]>();
        for (const d of django) byPrefix.set(d.prefix, [...(byPrefix.get(d.prefix) ?? []), { label: d.label, code: d.code }]);
        for (const [prefix, items] of byPrefix) {
            const results = await this.runDjangoBatch(task, env, prefix, items, "dryrun");
            for (const r of results) {
                if (r.ok) continue;
                if (/did not start/.test(r.error)) {
                    console.warn(`[stagehand] Django seed dry-run skipped for ${task.ticket_id}: ${r.error.slice(0, 200)}`);
                    break;
                }
                problems.push(`${r.label}: ${r.error.slice(0, 240)}`);
            }
        }
        return problems.length ? `seed and teardown steps must run against the real code and schema (psql steps are dry-run inside BEGIN…ROLLBACK, Django-shell steps inside transaction.atomic() and rolled back): ${problems.join("; ")} — a step may only use models, fields and functions that exist on the base branch (add feature-only records with getattr / try-import), check the table's columns (\\d <table>) and the models, then fix the step text` : null;
    }

    private designMdProblems(taskId: string): string | null {
        const p = join(this.taskDir(taskId), "design.md");
        if (!existsSync(p)) return "design.md was not written";
        const task = this.getTask(taskId);
        const repos = task ? envRepos(this.env(task.env_id)) : [];
        return designMdProblems(readFileSync(p, "utf8"), { repos });
    }

    // Verification-command failures in a row per task; reset when it passes.
    private readonly checkFailures = new Map<string, number>();
    private static readonly MAX_CHECK_ATTEMPTS = 2;

    private afterStage(taskId: string, def: StageDef, data: unknown): void {
        const task = this.getTask(taskId)!;
        const env = this.env(task.env_id);
        if ((def.stage === "implementation" || def.stage === "pr_fix" || def.stage === "code_review") && env.check_command?.trim() && task.worktree_path) {
            void this.verifyThenContinue(taskId, def, data, env);
            return;
        }
        if ((def.stage === "manual_qa" || def.stage === "qa_baseline") && jevEnabled(this.cfg)) {
            const parsedQa = QaPassResult.parse(data);
            void (def.stage === "manual_qa" ? this.gradeQaWithJev(taskId, env, parsedQa) : Promise.resolve(parsedQa))
                .catch((e: unknown) => {
                    console.warn(`[stagehand] jev grading ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`);
                    return parsedQa;
                })
                .then(async (qa) => {
                    await this.classifyQaBlockers(taskId, env, qa).catch((e: unknown) => console.warn(`[stagehand] jev blocker sorting ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 200)}`));
                    this.archiveQaPass(taskId, def.stage === "qa_baseline" ? "before" : "after");
                    this.afterStageChecked(taskId, def, qa);
                });
            return;
        }
        if (def.stage === "manual_qa" || def.stage === "qa_baseline") this.archiveQaPass(taskId, def.stage === "qa_baseline" ? "before" : "after");
        this.afterStageChecked(taskId, def, data);
    }

    // Every finished pass is kept under qa/history/<pass>-<time>/: the merged result (with Jev's grades), the seed log
    // and the screenshots — qa/<pass>.json, seed-<pass>.log and qa/<pass>/ are overwritten by the next pass.
    private archiveQaPass(taskId: string, pass: "before" | "after"): void {
        const qaDir = join(this.taskDir(taskId), "qa");
        const dest = join(qaDir, "history", `${pass}-${now().replace(/[:.]/g, "-")}`);
        try {
            mkdirSync(dest, { recursive: true });
            for (const f of [`${pass}.json`, `seed-${pass}.log`]) if (existsSync(join(qaDir, f))) copyFileSync(join(qaDir, f), join(dest, f));
            if (existsSync(join(qaDir, pass))) cpSync(join(qaDir, pass), join(dest, pass), { recursive: true });
        } catch (e) {
            console.warn(`[stagehand] qa history ${taskId}: ${String((e as Error).message ?? e).slice(0, 160)}`);
        }
    }

    // Jev's verdict per blocked scenario of the pass just finished (task id → scenario id → kind), read once by afterStageChecked.
    private readonly blockerVerdicts = new Map<string, Record<string, BlockerKind>>();

    // Sorts every blocked scenario before the automatic unblock retry spends a full pass on it: a seed/design defect
    // or an environment problem goes to the human at once, an application error counts as a failure, only
    // bridge/auth (self-healing) and the undecidable rest keep the retry.
    private async classifyQaBlockers(taskId: string, env: EnvRow, qa: QaPassResult): Promise<void> {
        const blocked = qa.scenarios.filter((s) => s.outcome === "blocked");
        if (blocked.length === 0 || !jevEnabled(this.cfg)) return;
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const verdicts: Record<string, BlockerKind> = {};
        const lines: string[] = [];
        for (const s of blocked) {
            const spec = design?.qa.find((d) => d.id === s.id);
            try {
                const r = await jevAsk(
                    this.cfg,
                    { scenario: { id: s.id, title: spec?.title ?? "", kind: spec?.kind ?? "browser", seed: spec?.seed ?? [], steps: (spec?.steps ?? []).map((st) => st.action) }, runner: { observation: s.observation, log: (s.log ?? "").slice(-1200), blockers: qa.blockers } },
                    {
                        kind: {
                            type: "choice",
                            instructions: "Why could this scenario not be exercised",
                            criteria: {
                                bridge_or_auth: "The browser extension was not connected, or the app required a login",
                                seed_or_design_defect: "A seed, teardown or step is wrong as written: wrong path, host, field, model, import, value, or data that collides because the teardown is incomplete",
                                environment: "The backend, frontend, worker, database or a dependency was down, unreachable, unmigrated or misconfigured — not the code under test",
                                app_bug: "The application answered with an error (a 500, an exception, a crash, a broken page) while the step was correct and the environment healthy",
                                other: "None of the above, or the observation does not say enough",
                            },
                        },
                    },
                    { db: this.db, ctx: { accountId: null, envId: env.id, taskId, runId: null, stage: qa.pass === "before" ? "qa_baseline" : "manual_qa" } },
                );
                const a = r.answers.kind;
                const kind = (a.confidence >= 0.5 ? a.choice : "other") as BlockerKind;
                verdicts[s.id] = kind;
                lines.push(`${s.id} ${kind} (${Math.round((a.probabilities[a.choice] ?? 0) * 100)}%)`);
            } catch (e) {
                console.warn(`[stagehand] jev blocker ${taskId} ${s.id}: ${String((e as Error).message ?? e).slice(0, 160)}`);
            }
        }
        if (Object.keys(verdicts).length) {
            this.blockerVerdicts.set(taskId, verdicts);
            this.addMessage(taskId, "agent", `🧭 Jev sorted the blocked scenarios: ${lines.join(" · ")}`);
        }
    }

    // Jev grades every Manual QA scenario the runner marked pass or fail: 0–100 = how sure it is that every expected
    // result held, from the scenario's steps/asserts and the runner's observation (user, 2026-09-22: "auto-use it to
    // score Manual QA - did it pass or not, 0-100, with 85+ graded as Pass"). A runner "pass" graded under 85 becomes
    // needs_human with the grade (the human checks it); a runner "fail" keeps its outcome, the grade is only shown.
    // Grades land in qa/after.json (`jev` per scenario), the summary in Chat.
    private static readonly JEV_PASS_GRADE = 85;
    private async gradeQaWithJev(taskId: string, env: EnvRow, qa: QaPassResult): Promise<QaPassResult> {
        type Scenario = QaPassResult["scenarios"][number];
        const design = this.readArtifactJson<DesignResult>(taskId, "design.json");
        const grades: Record<string, { grade: number; verdict: "pass" | "fail"; runner: string; reason?: string }> = {};
        const scenarios: Scenario[] = await Promise.all(
            qa.scenarios.map(async (s): Promise<Scenario> => {
                if (s.outcome !== "pass" && s.outcome !== "fail") return s;
                const spec = design?.qa.find((d) => d.id === s.id);
                try {
                    const r = await jevAsk(
                        this.cfg,
                        {
                            scenario: { id: s.id, title: spec?.title ?? "", kind: spec?.kind ?? "browser", steps: (spec?.steps ?? []).map((st, i) => ({ n: i + 1, action: st.action, expected: st.assert })) },
                            // The pass's blockers are shared by every scenario (and are sometimes plain notes): Jev weighs one only when it
                            // touches this scenario's steps (INV-149 and INV-155, 2026-10: one note failed every scenario of the pass).
                            runner: { outcome: s.outcome, observation: s.observation, log: (s.log ?? "").slice(-1500), passBlockers: qa.blockers },
                        },
                        {
                            passed: {
                                type: "noul",
                                instructions: "Every expected result of this scenario held in the observed run",
                                criteria: {
                                    true: "The observation confirms each expected result with concrete evidence (values, states, messages); no step skipped, no contradiction, no workaround, no blocker in this scenario's steps",
                                    false: "An expected result is contradicted, unverified or skipped, holds only through a workaround, or an error or a pass blocker stopped or altered one of THIS scenario's steps (pass blockers that concern other scenarios or are mere notes do not count)",
                                },
                            },
                            // Jev answers with probabilities, never prose: the reason is a second, categorical question, so a
                            // low grade tells the human what to look at (INV-135, 2026-09-25: 24/100 and 41/100 with nothing to go on).
                            reason: {
                                type: "choice",
                                instructions: "The main thing that keeps this run from being a clean pass",
                                criteria: {
                                    clean: "every expected result is confirmed with concrete evidence, nothing skipped, no workaround",
                                    contradicted: "an observed value or state contradicts an expected result",
                                    unverified: "an expected result is asserted without concrete evidence (no value, state or message quoted)",
                                    skipped: "a step or an expected result is not covered by the observation at all",
                                    workaround: "the runner changed data, route or input to get past something (a substitution, a manual seed, a different record)",
                                    blocker: "an error or a pass blocker stopped or altered this scenario's steps",
                                },
                            },
                        },
                        { db: this.db, ctx: { accountId: null, envId: env.id, taskId, runId: null, stage: "manual_qa" } },
                    );
                    const grade = Math.round(r.answers.passed.noul * 100);
                    const verdict: "pass" | "fail" = grade >= Engine.JEV_PASS_GRADE ? "pass" : "fail";
                    const reason = r.answers.reason.choice;
                    grades[s.id] = { grade, verdict, runner: s.outcome, reason };
                    if (s.outcome === "pass" && verdict === "fail") {
                        return { ...s, outcome: "needs_human", observation: `Jev grades this run ${grade}/100 (a pass needs ${Engine.JEV_PASS_GRADE}; reason: ${reason}) — check it yourself. Runner: ${s.observation}` };
                    }
                    return s;
                } catch (e) {
                    console.warn(`[stagehand] jev grade ${taskId} ${s.id}: ${String((e as Error).message ?? e).slice(0, 200)}`);
                    return s;
                }
            }),
        );
        if (Object.keys(grades).length === 0) return qa;
        const path = join(this.taskDir(taskId), "qa", "after.json");
        try {
            const raw = JSON.parse(readFileSync(path, "utf8")) as { scenarios?: Array<{ id: string; outcome: string; observation: string; jev?: unknown }> };
            for (const sc of raw.scenarios ?? []) {
                const g = grades[sc.id];
                if (!g) continue;
                sc.jev = g;
                const adjusted = scenarios.find((x) => x.id === sc.id);
                if (adjusted && adjusted.outcome !== sc.outcome) {
                    sc.outcome = adjusted.outcome;
                    sc.observation = adjusted.observation;
                }
            }
            writeFileSync(path, JSON.stringify(raw, null, 2));
        } catch (e) {
            console.warn(`[stagehand] jev grades not written to ${path}: ${String((e as Error).message ?? e).slice(0, 160)}`);
        }
        this.addMessage(
            taskId,
            "agent",
            `🎯 Jev graded Manual QA (pass ≥ ${Engine.JEV_PASS_GRADE}/100): ${Object.entries(grades)
                .map(([id, g]) => `${id} ${g.grade}/100 → ${g.verdict}${g.reason && g.reason !== "clean" ? ` (${g.reason})` : ""}${g.runner !== g.verdict ? ` (runner said ${g.runner}${g.runner === "pass" ? " → needs your check" : ""})` : ""}`)
                .join(" · ")}`,
        );
        return { ...qa, scenarios };
    }

    // The env's verification command runs from the worktree after every implementation / PR-fix run — what tests and a
    // dev server never exercise. INV-131, 2026-09-21: a 31-character index name passed pytest, runserver_plus (no system
    // checks) and CI (`makemigrations --check` only), merged, then failed `migrate` on production with models.E034;
    // `manage.py check --database default` reports it in seconds. A failure goes back to the same stage with the output.
    private async verifyThenContinue(taskId: string, def: StageDef, data: unknown, env: EnvRow): Promise<void> {
        const task = this.getTask(taskId);
        if (!task?.worktree_path || !env.check_command) return;
        this.setTaskStatus(taskId, "running", `${def.label} · running the env's verification command`);
        let out = "";
        let ok = true;
        try {
            out = await runWorktreeSetup(task.worktree_path, env.path, withPrepare(env, env.check_command), parseEnvVars(env.env_vars));
        } catch (e) {
            ok = false;
            const err = e as { stdout?: string; stderr?: string; message?: string };
            out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || String(err.message ?? e);
        }
        if (ok) {
            this.checkFailures.delete(taskId);
            this.afterStageChecked(taskId, def, data);
            return;
        }
        const n = (this.checkFailures.get(taskId) ?? 0) + 1;
        this.checkFailures.set(taskId, n);
        const tail = out.split("\n").slice(-40).join("\n").slice(-3000);
        this.addMessage(taskId, "agent", `❌ The env's verification command failed after ${def.label} (attempt ${n}/${Engine.MAX_CHECK_ATTEMPTS}):\n\n\`\`\`\n${tail}\n\`\`\``);
        if (n <= Engine.MAX_CHECK_ATTEMPTS) {
            this.dispatch(taskId, def.stage, {
                notes:
                    `## The environment's verification command failed (attempt ${n} of ${Engine.MAX_CHECK_ATTEMPTS})\n\nStagehand ran this from the worktree after your run:\n\n\`\`\`\n${env.check_command}\n\`\`\`\n\nIt exited non-zero:\n\n\`\`\`\n${tail}\n\`\`\`\n\n` +
                    `Fix the cause at the source (a model or migration problem, a failing system check, a missing dependency), run the command yourself until it passes, commit, then rewrite your output file and reply DONE.`,
            });
            return;
        }
        this.checkFailures.delete(taskId);
        this.setTaskStatus(taskId, "blocked", `${def.label} · the env's verification command still fails after ${Engine.MAX_CHECK_ATTEMPTS} fix attempts — fix it in the worktree, then Retry`);
    }

    private afterStageChecked(taskId: string, def: StageDef, data: unknown): void {
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
            const prefix = rulesOf(this.configDirOf(env)).branchPrefix;
            const branch = prefix && !r.branchName.startsWith(prefix) ? `${prefix}${r.branchName}` : r.branchName;
            this.db.prepare(`UPDATE tasks SET title = ?, branch = ?, updated_at = ? WHERE id = ?`).run(r.title, branch, now(), taskId);
            this.setTaskStatus(taskId, "running", "creating worktree");
            const envVars = parseEnvVars(env.env_vars);
            void createWorktree(this.layoutOf(this.getTask(taskId) ?? { base_branch: null }, env), branch, envVars)
                .then(async (wt) => {
                    this.db.prepare(`UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE id = ?`).run(wt.path, now(), taskId);
                    if (wt.reused) {
                        this.setTaskStatus(taskId, "running", `reusing existing worktree/branch with ${wt.existingCommits} commit(s) ahead of ${this.baseBranchOf(this.getTask(taskId) ?? { base_branch: null }, env)}`);
                    }
                    if (env.depends_on_env_id) {
                        this.setTaskStatus(taskId, "running", "starting the dependency service this env needs");
                        const dep = await this.services.ensureDependency(env);
                        if (dep) envVars.STAGEHAND_DEP_URL = dep.url;
                    }
                    // The task's own database first (docs/db-isolation.md): setup then sees $STAGEHAND_TASK_DB, and
                    // connect points the worktree's config at it once setup has written that config.
                    if (taskDbActive(taskDbOf(env))) {
                        const cur = this.getTask(taskId)!;
                        try {
                            await this.taskDbs.create({ id: cur.id, slug: cur.ticket_id, kind: "task" }, env, (line) => this.setTaskStatus(taskId, "running", `task database · ${line}`));
                        } catch (e) {
                            this.setTaskStatus(taskId, "blocked", `Task database · could not be created: ${String((e as Error).message ?? e).slice(0, 300)} — fix it, then Recreate the database on the task page`, { notify: true });
                            return;
                        }
                        Object.assign(envVars, taskDbEnv(this.db, taskId));
                    }
                    if (env.setup_command) {
                        this.setTaskStatus(taskId, "running", "running worktree setup");
                        const out = await runWorktreeSetup(wt.path, env.path, withPrepare(env, env.setup_command), envVars);
                        // The tail of what setup printed goes to server.log: an `npm ci` that skips a native binding
                        // only says so here (npm WARN EBADENGINE), and the FE fails minutes later with no trace of why.
                        if (out) console.error(`[setup] ${task.ticket_id} ${wt.path}\n${out.slice(-1500)}`);
                    }
                    if (taskDbRow(this.db, taskId)?.status === "ready") await this.taskDbs.connect(this.getTask(taskId)!, env);
                    this.advance(taskId, "design_proposal");
                })
                .catch((e: unknown) => this.setTaskStatus(taskId, "failed", `worktree: ${String(e).slice(0, 160)}`));
            return;
        }
        if (def.stage === "design_proposal") {
            this.afterDesign(taskId);
            return;
        }
        if (def.stage === "pr_fix") void this.fillFixReplies(taskId).catch((e: unknown) => console.warn(`[stagehand] fix replies ${taskId}: ${String((e as Error).message ?? e).slice(0, 160)}`));
        if (def.stage === "pr_fix" && this.autopilotAfterFix(taskId)) return;
        if (def.kind === "wait") {
            this.setTaskStatus(taskId, "waiting_user", `${def.label} · needs you`);
            if (def.stage === "pr_creation_review") void this.annotateStackedDrafts(taskId);
            return;
        }
        if (def.stage === "qa_baseline" || def.stage === "manual_qa") {
            let qa = QaPassResult.parse(data);
            const taskDirQa = this.taskDir(taskId);
            // The pass consumed its partial results (a resumed pass) and its shards' files; a leftover would resume the next pass wrongly.
            this.clearPassFiles(taskId, qa.pass);
            // Jev's sorting of the blocked scenarios (classifyQaBlockers): an application error is a failure, not a block.
            const verdicts = this.blockerVerdicts.get(taskId) ?? {};
            this.blockerVerdicts.delete(taskId);
            if (qa.scenarios.some((s) => s.outcome === "blocked" && verdicts[s.id] === "app_bug")) {
                qa = { ...qa, scenarios: qa.scenarios.map((s) => (s.outcome === "blocked" && verdicts[s.id] === "app_bug" ? { ...s, outcome: "fail" as const, observation: `application error (Jev: not an environment or seed problem) — ${s.observation}` } : s)) };
                writeFileSync(join(taskDirQa, "qa", `${qa.pass}.json`), JSON.stringify(qa, null, 2));
            }
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
            // A blocked scenario never got far enough to assert anything — the reported bug from earlier, a stale
            // dev-server, missing data — so it is not treated as a normal fail/pass result on its own. Unlike
            // bridge-miss/auth (self-resolving, handled and retried above), give the SAME runner one budgeted
            // chance to investigate and fix the cause itself and retry THIS stage (see renderUnblockHint), before
            // falling back to blocking for a human. This applies to both qa_baseline (a blocked scenario there is
            // not a solid "before" state to diff manual_qa against later either) and manual_qa.
            if (blocked.length > 0) {
                const taskDir = this.taskDir(taskId);
                const pass = def.stage === "qa_baseline" ? "before" : "after";
                const prefix = `${pass}-blocked-attempt`;
                const priorAttempts = attemptFiles(taskDir, prefix).length;
                const reason = qa.blockers[0] ?? blocked[0]!.observation;
                // Jev says an environment problem: a retry would only repeat it — go to the human now. A seed/design defect
                // goes the same way unless this environment lets Jev approve seed corrections: then the unblock attempt is
                // where the runner proposes the corrected command and the gate (parkOrAutoAnswer) applies it without the
                // human (INV-150, 2026-09-27: "Only one top level company allowed" went straight to the human instead).
                const seedFixesAllowed = autoFixKinds(this.env(task.env_id).qa_auto_fix ?? DEFAULT_QA_AUTO_FIX).has("seed") && jevEnabled(this.cfg);
                const forHuman = blocked.filter((s) => verdicts[s.id] === "environment" || (verdicts[s.id] === "seed_or_design_defect" && (!seedFixesAllowed || priorAttempts >= MAX_UNBLOCK_ATTEMPTS)));
                if (forHuman.length) {
                    const why = `${forHuman.map((s) => `${s.id}: ${verdicts[s.id] === "environment" ? "environment problem" : "seed or step wrong as written"}`).join("; ")} — ${reason}`;
                    if (def.stage === "qa_baseline" && this.designBaselineEnded(task, qa, why)) return;
                    this.setTaskStatus(taskId, "blocked", `${def.label} · ${why} — fix it (design.json, or the environment), then Retry`);
                    return;
                }
                if (priorAttempts < MAX_UNBLOCK_ATTEMPTS) {
                    const attemptNum = priorAttempts + 1;
                    const passPath = join(taskDir, "qa", `${pass}.json`);
                    if (existsSync(passPath)) copyFileSync(passPath, join(taskDir, "qa", `${prefix}-${attemptNum}.json`));
                    const r = rulesOf(this.configDirOf(this.env(task.env_id)));
                    const commitRule = r.allowCommit
                        ? `If you do fix something, commit it: every message must match \`${r.commitPattern}\` — ${r.commitHint}${r.commitForbid.length ? ` Never include ${r.commitForbid.map((f) => `\`${f}\``).join(", ")}.` : ""}`
                        : "Commits are NOT allowed in this environment: leave any fix uncommitted (staging is fine) and mention it in your observation; the human commits.";
                    const unblockHint = renderUnblockHint(qa, blocked, attemptNum, commitRule, taskDir);
                    this.setTaskStatus(
                        taskId,
                        "running",
                        `${def.label} · ${blocked.length}/${qa.scenarios.length} scenario(s) blocked — ${reason} — attempting to unblock and retry (${attemptNum}/${MAX_UNBLOCK_ATTEMPTS})`,
                    );
                    // Only the blocked scenarios run again; the verdicts and hand-offs of this attempt carry over.
                    const recorded = qa.scenarios.filter(isRecorded);
                    this.dispatch(taskId, def.stage, { extraVars: { unblockHint, ...this.resumeVars(taskId, pass, recorded, blocked.map((s) => s.id)) } });
                    return;
                }
                const why = `${blocked.length}/${qa.scenarios.length} scenario(s) still blocked after ${MAX_UNBLOCK_ATTEMPTS} automatic unblock attempts — ${reason}`;
                if (def.stage === "qa_baseline" && this.designBaselineEnded(task, qa, why)) return;
                this.setTaskStatus(taskId, "blocked", `${def.label} · ${why} — fix it, then Retry`);
                return;
            }
            if (def.stage === "qa_baseline" && this.designBaselineEnded(task, qa, null)) return;
            if (def.stage === "manual_qa" && (failed > 0 || needsHuman > 0)) {
                const parts = [failed > 0 ? `${failed} scenario(s) failed` : null, needsHuman > 0 ? `${needsHuman} need your own check` : null].filter(Boolean);
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
                        this.stopServicesAfterQa(task);
                        this.dispatch(taskId, "implementation", { notes });
                        return;
                    }
                    this.db
                        .prepare(`UPDATE tasks SET status_line = ?, updated_at = ? WHERE id = ?`)
                        .run(`Manual QA · ${failed} scenario(s) still failing after ${MAX_AUTO_QA_RETURNS} automatic fix attempts — needs your review`, now(), taskId);
                }
            }
            this.stopServicesAfterQa(task);
        }
        if (def.stage === "qa_baseline" || def.stage === "manual_qa") {
            const marker = this.readArtifactJson<BaselineRerun>(taskId, "qa/baseline-rerun.json");
            if (def.stage === "qa_baseline" && marker?.active) {
                void this.finishBaselineRerun(taskId, marker).catch((e: unknown) => console.warn(`[stagehand] baseline re-run finish ${taskId}: ${String((e as Error).message ?? e).slice(0, 200)}`));
                return;
            }
        }
        // Code Review (gstack's checklist, fresh session): fixed findings are already committed; serious open ones
        // (P0/P1 at confidence ≥ 7) send the task back to Implementation once, with the findings as the brief; the
        // second review after that goes on regardless, and every finding stays visible at User Review.
        if (def.stage === "code_review") {
            const review = ReviewResult.parse(data);
            const fixed = review.findings.filter((f) => f.status === "fixed");
            const open = review.findings.filter((f) => f.status === "open");
            const serious = open.filter((f) => (f.severity === "P0" || f.severity === "P1") && f.confidence >= 7);
            const line = (f: ReviewResult["findings"][number]): string => `- **${f.severity}** (${f.confidence}/10) \`${f.file}${f.line ? `:${f.line}` : ""}\` — ${f.title}${f.status === "fixed" && f.commit ? ` (fixed in ${f.commit.slice(0, 7)})` : ""}`;
            this.addMessage(
                taskId,
                "agent",
                `🔎 Code review: ${review.summary}` +
                    (fixed.length ? `\n\nFixed:\n${fixed.map(line).join("\n")}` : "") +
                    (open.length ? `\n\nOpen (for you):\n${open.map(line).join("\n")}` : ""),
            );
            const marker = join(this.taskDir(taskId), "review-attempt-1.json");
            if (serious.length && !existsSync(marker)) {
                copyFileSync(join(this.taskDir(taskId), "review.json"), marker);
                const notes =
                    `## Code review found ${serious.length} serious open finding(s) — fix them (attempt 1 of 1; after this the task goes on to QA regardless)\n\n` +
                    serious.map((f) => `${line(f)}\n  ${f.detail}${f.quote ? `\n  > ${f.quote.replace(/\n/g, " ")}` : ""}`).join("\n") +
                    `\n\nFix each at its root cause, keep the tests green, commit, and rewrite impl.json. Do not touch anything the review did not raise.`;
                this.setStage(taskId, "implementation");
                this.setTaskStatus(taskId, "running", `Code Review · ${serious.length} serious finding(s) — sending back to Implementation`);
                this.dispatch(taskId, "implementation", { notes });
                return;
            }
        }
        if (def.next) this.advance(taskId, def.next);
    }

    // A QA pass that is over — the task moves on to Implementation or User Review — no longer needs the task's BE/FE,
    // and a Next dev server left running grows for hours (5 GB seen on a task parked at User Review). Stop the pair here;
    // the next browser stage brings it back up on demand, and the task page's Start button does too. Same-stage retries
    // and human-blocked states (log in, "fix it then Retry") return before reaching this, so the app stays up for them.
    private stopServicesAfterQa(task: TaskRow): void {
        // The env may prefer warm servers across the stages (envs.keep_services): then only done / cleanup stop them.
        if (this.env(task.env_id).keep_services) return;
        void this.services.stopAll(task.id).catch((e: unknown) => console.warn(`[stagehand] stop BE/FE after QA ${task.ticket_id}: ${String((e as Error).message ?? e).slice(0, 160)}`));
    }
}
