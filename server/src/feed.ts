import { randomUUID } from "node:crypto";
import type { DB, Stage, TaskRow } from "./db.js";
import { now } from "./db.js";
import { STAGE_DEFS } from "./stages/registry.js";

// The activity feed (feed_events): a durable log of what happened to tasks, derived from every (stage, status) change
// (Engine.recordTaskEvent) plus a few direct hooks. Events a human must act on (category needs_you) stay open until
// the task leaves attention.

export type FeedCategory = "needs_you" | "agent" | "pr" | "system" | "lifecycle";

export interface FeedEvent {
    id: string;
    at: string;
    task_id: string;
    env_id: string;
    ticket_id: string | null;
    task_title: string | null;
    kind: string;
    category: FeedCategory;
    text: string;
    detail: string | null;
    stage: string | null;
    status: string | null;
    repo: string | null;
    resolved_at: string | null;
    seen_at: string | null;
}

export interface Derived {
    kind: string;
    category: FeedCategory;
    text: string;
    detail?: string | null;
}

export const FEED_KEEP = 5000;
const DEDUPE_MS = 60_000;
const ATTENTION = new Set(["waiting_user", "blocked", "failed"]);
export const isAttention = (status: string): boolean => ATTENTION.has(status);

const stageLabel = (stage: string): string => STAGE_DEFS[stage as Stage]?.label ?? stage;

const WAITING_KIND: Record<string, [string, string]> = {
    design_proposal: ["design_ready", "Design ready to approve"],
    user_review: ["user_review", "Ready for your review"],
    pr_creation_review: ["pr_drafts", "Pull request drafts ready"],
};

const PR_STAGES: Record<string, [string, string]> = {
    pr_waiting: ["pr_waiting", "Waiting on GitHub"],
    pr_green: ["pr_green", "All checks passed"],
    pr_approved: ["pr_approved", "Pull request approved"],
    pr_fix: ["pr_fix", "PR fix started"],
};

// The event one (stage, status) change earns, or null. `prev` is the last recorded (stage, status) of the task.
export const deriveEvent = (prev: { stage: string; status: string } | null, cur: { stage: string; status: string }, statusLine: string | null): Derived | null => {
    const line = statusLine?.trim() || null;
    if (cur.status === "waiting_user") {
        if (line && /question/i.test(line)) return { kind: "questions", category: "needs_you", text: "Agent has questions for you", detail: line };
        const [kind, text] = WAITING_KIND[cur.stage] ?? ["needs_review", "Needs your review"];
        return { kind, category: "needs_you", text, detail: line };
    }
    if (cur.status === "blocked") return { kind: "blocked", category: "needs_you", text: `Blocked: ${(line ?? "").slice(0, 120)}`.trimEnd(), detail: line };
    if (cur.status === "failed") return { kind: "failed", category: "needs_you", text: `${stageLabel(cur.stage)} failed`, detail: line };
    if (cur.status === "rate_limited") return { kind: "rate_limited", category: "system", text: "Rate limited", detail: line };
    if (cur.status === "done") return { kind: "done", category: "lifecycle", text: "Done", detail: line };
    if (cur.status === "stopped") return { kind: "stopped", category: "lifecycle", text: "Stopped", detail: null };
    if (prev && prev.stage !== cur.stage) {
        const pr = PR_STAGES[cur.stage];
        if (pr) return { kind: pr[0], category: "pr", text: pr[1] };
        if (STAGE_DEFS[cur.stage as Stage]?.kind === "terminal") return null;
        return { kind: "stage_started", category: "agent", text: `${stageLabel(cur.stage)} started` };
    }
    return null;
};

type Emit = (e: FeedEvent) => void;

const SELECT = `SELECT f.*, t.title AS task_title FROM feed_events f LEFT JOIN tasks t ON t.id = f.task_id`;

export const getFeedEvent = (db: DB, id: string): FeedEvent | null => (db.prepare(`${SELECT} WHERE f.id = ?`).get(id) as FeedEvent | undefined) ?? null;

// Resolves the task's open needs_you events; every one resolved is emitted.
export const resolveOpen = (db: DB, taskId: string, emit?: Emit): number => {
    const ids = (db.prepare(`SELECT id FROM feed_events WHERE task_id = ? AND category = 'needs_you' AND resolved_at IS NULL`).all(taskId) as Array<{ id: string }>).map((r) => r.id);
    if (!ids.length) return 0;
    const at = now();
    const upd = db.prepare(`UPDATE feed_events SET resolved_at = ? WHERE id = ?`);
    for (const id of ids) {
        upd.run(at, id);
        const e = getFeedEvent(db, id);
        if (e && emit) emit(e);
    }
    return ids.length;
};

export interface InsertOpts {
    task: Pick<TaskRow, "id" | "env_id" | "ticket_id">;
    stage?: string | null;
    status?: string | null;
    repo?: string | null | undefined;
    at?: string;
}

// Inserts one event unless the task's newest event has the same kind and text within 60 s; prunes to the newest 5000.
export const insertFeedEvent = (db: DB, d: Derived, o: InsertOpts, emit?: Emit): FeedEvent | null => {
    const last = db.prepare(`SELECT kind, text, at FROM feed_events WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`).get(o.task.id) as { kind: string; text: string; at: string } | undefined;
    const at = o.at ?? now();
    if (last && last.kind === d.kind && last.text === d.text && Math.abs(Date.parse(at) - Date.parse(last.at)) < DEDUPE_MS) return null;
    // A task has one current ask: a new one supersedes the open ones.
    if (d.category === "needs_you") resolveOpen(db, o.task.id, emit);
    const id = randomUUID();
    db.prepare(
        `INSERT INTO feed_events (id, at, task_id, env_id, ticket_id, kind, category, text, detail, stage, status, repo, resolved_at, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(id, at, o.task.id, o.task.env_id, o.task.ticket_id ?? null, d.kind, d.category, d.text, d.detail ?? null, o.stage ?? null, o.status ?? null, o.repo ?? null);
    db.prepare(`DELETE FROM feed_events WHERE rowid IN (SELECT rowid FROM feed_events ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(FEED_KEEP);
    const e = getFeedEvent(db, id);
    if (e && emit) emit(e);
    return e;
};

// Called for every recorded (stage, status) change, before the new task_events row is written (so `prev` is the last one).
export const recordFeedChange = (db: DB, task: TaskRow, stage: string, status: string, prev: { stage: string; status: string } | null, emit?: Emit): void => {
    if (!isAttention(status)) resolveOpen(db, task.id, emit);
    const d = deriveEvent(prev, { stage, status }, task.status_line);
    if (d) insertFeedEvent(db, d, { task, stage, status }, emit);
};

// Idempotent: a task in an attention status with no open needs_you event gets one from its current state.
export const backfillFeed = (db: DB, emit?: Emit): number => {
    const tasks = db
        .prepare(
            `SELECT * FROM tasks WHERE status IN ('waiting_user', 'blocked', 'failed')
             AND NOT EXISTS (SELECT 1 FROM feed_events f WHERE f.task_id = tasks.id AND f.category = 'needs_you' AND f.resolved_at IS NULL)`,
        )
        .all() as TaskRow[];
    let n = 0;
    for (const t of tasks) {
        const d = deriveEvent(null, { stage: t.stage, status: t.status }, t.status_line);
        if (d && insertFeedEvent(db, d, { task: t, stage: t.stage, status: t.status, at: t.updated_at }, emit)) n++;
    }
    return n;
};

export interface FeedPage {
    events: FeedEvent[];
    open: FeedEvent[];
    unseen: number;
}

export const readFeed = (db: DB, q: { env?: string | undefined; limit?: number | undefined; before?: string | undefined }): FeedPage => {
    const limit = Math.min(200, Math.max(1, Math.floor(q.limit ?? 50) || 50));
    const envSql = q.env ? ` AND f.env_id = ?` : "";
    const envArg = q.env ? [q.env] : [];
    const beforeSql = q.before ? ` AND f.at < ?` : "";
    const events = db.prepare(`${SELECT} WHERE 1=1${envSql}${beforeSql} ORDER BY f.at DESC, f.rowid DESC LIMIT ?`).all(...envArg, ...(q.before ? [q.before] : []), limit) as FeedEvent[];
    const open = db.prepare(`${SELECT} WHERE f.category = 'needs_you' AND f.resolved_at IS NULL${envSql} ORDER BY f.at DESC, f.rowid DESC`).all(...envArg) as FeedEvent[];
    const unseen = (db.prepare(`SELECT COUNT(*) AS n FROM feed_events f WHERE f.seen_at IS NULL${envSql}`).get(...envArg) as { n: number }).n;
    return { events, open, unseen };
};

export const markSeen = (db: DB, q: { ids?: string[] | undefined; taskId?: string | undefined; env?: string | undefined; all?: boolean | undefined }): number => {
    const at = now();
    let n = 0;
    if (q.ids?.length) {
        const upd = db.prepare(`UPDATE feed_events SET seen_at = ? WHERE id = ? AND seen_at IS NULL`);
        for (const id of q.ids) n += upd.run(at, id).changes;
    }
    if (q.taskId) n += db.prepare(`UPDATE feed_events SET seen_at = ? WHERE task_id = ? AND seen_at IS NULL`).run(at, q.taskId).changes;
    if (q.all) n += (q.env ? db.prepare(`UPDATE feed_events SET seen_at = ? WHERE env_id = ? AND seen_at IS NULL`).run(at, q.env) : db.prepare(`UPDATE feed_events SET seen_at = ? WHERE seen_at IS NULL`).run(at)).changes;
    return n;
};
