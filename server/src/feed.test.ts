import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB, type TaskRow } from "./db.js";
import { backfillFeed, deriveEvent, FEED_KEEP, insertFeedEvent, markSeen, readFeed, recordFeedChange, type FeedEvent } from "./feed.js";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fresh = (): DB => {
    const dir = mkdtempSync(join(tmpdir(), "feed-"));
    dirs.push(dir);
    const db = openDb(dir);
    db.pragma("foreign_keys = OFF");
    return db;
};
const addTask = (db: DB, id: string, over: Partial<Record<string, string | null>> = {}): TaskRow => {
    const row = { id, env_id: "e1", ticket_id: `T-${id}`, source: "linear", session_id: id, stage: "research", status: "running", status_line: null, title: `Title ${id}`, ...over };
    db.prepare(`INSERT INTO tasks (id, env_id, ticket_id, source, session_id, stage, status, status_line, title, pinned, created_at, updated_at) VALUES (@id, @env_id, @ticket_id, @source, @session_id, @stage, @status, @status_line, @title, 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(row);
    return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow;
};
const setTask = (db: DB, id: string, stage: string, status: string, line: string | null): TaskRow => {
    db.prepare(`UPDATE tasks SET stage = ?, status = ?, status_line = ? WHERE id = ?`).run(stage, status, line, id);
    return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow;
};

describe("deriveEvent", () => {
    const run = { stage: "implementation", status: "running" };
    it("maps attention statuses", () => {
        expect(deriveEvent(run, { stage: "design_proposal", status: "waiting_user" }, "Design ready")).toMatchObject({ kind: "design_ready", category: "needs_you", text: "Design ready to approve", detail: "Design ready" });
        expect(deriveEvent(run, { stage: "user_review", status: "waiting_user" }, "x")).toMatchObject({ kind: "user_review", text: "Ready for your review" });
        expect(deriveEvent(run, { stage: "pr_creation_review", status: "waiting_user" }, "x")).toMatchObject({ kind: "pr_drafts", text: "Pull request drafts ready" });
        expect(deriveEvent(run, { stage: "research", status: "waiting_user" }, "x")).toMatchObject({ kind: "needs_review" });
        expect(deriveEvent(run, { stage: "design_proposal", status: "waiting_user" }, "3 Questions pending")).toMatchObject({ kind: "questions", text: "Agent has questions for you" });
        const long = "b".repeat(300);
        const blocked = deriveEvent(run, { stage: "implementation", status: "blocked" }, long)!;
        expect(blocked).toMatchObject({ kind: "blocked", category: "needs_you", detail: long });
        expect(blocked.text).toBe(`Blocked: ${"b".repeat(120)}`);
        expect(deriveEvent(run, { stage: "implementation", status: "failed" }, "boom")).toMatchObject({ kind: "failed", text: "Implementation failed" });
    });
    it("maps stage changes and terminal statuses", () => {
        expect(deriveEvent(run, { stage: "manual_qa", status: "running" }, null)).toMatchObject({ kind: "stage_started", category: "agent", text: "Manual QA started" });
        expect(deriveEvent(run, { stage: "pr_waiting", status: "running" }, null)).toMatchObject({ kind: "pr_waiting", category: "pr", text: "Waiting on GitHub" });
        expect(deriveEvent(run, { stage: "pr_green", status: "running" }, null)).toMatchObject({ kind: "pr_green", text: "All checks passed" });
        expect(deriveEvent(run, { stage: "pr_approved", status: "running" }, null)).toMatchObject({ kind: "pr_approved", text: "Pull request approved" });
        expect(deriveEvent(run, { stage: "pr_fix", status: "running" }, null)).toMatchObject({ kind: "pr_fix", text: "PR fix started" });
        expect(deriveEvent(run, { stage: "implementation", status: "rate_limited" }, "resets 5pm")).toMatchObject({ kind: "rate_limited", category: "system", detail: "resets 5pm" });
        expect(deriveEvent(run, { stage: "done", status: "done" }, "merged")).toMatchObject({ kind: "done", category: "lifecycle", text: "Done", detail: "merged" });
        expect(deriveEvent(run, { stage: "implementation", status: "stopped" }, null)).toMatchObject({ kind: "stopped", text: "Stopped" });
    });
    it("is silent without a stage change, a previous row, or for the terminal stage", () => {
        expect(deriveEvent(run, { stage: "implementation", status: "idle" }, null)).toBeNull();
        expect(deriveEvent(null, { stage: "research", status: "running" }, null)).toBeNull();
        expect(deriveEvent(run, { stage: "done", status: "running" }, null)).toBeNull();
    });
});

describe("feed log", () => {
    it("opens a needs_you event and resolves it when the task leaves attention", () => {
        const db = fresh();
        addTask(db, "a");
        const out: FeedEvent[] = [];
        const emit = (e: FeedEvent): void => void out.push(e);
        const t = setTask(db, "a", "design_proposal", "waiting_user", "Design ready");
        recordFeedChange(db, t, "design_proposal", "waiting_user", { stage: "design_proposal", status: "running" }, emit);
        let page = readFeed(db, {});
        expect(page.open).toHaveLength(1);
        expect(page.open[0]!).toMatchObject({ kind: "design_ready", task_title: "Title a", ticket_id: "T-a", resolved_at: null, seen_at: null });
        expect(page.unseen).toBe(1);
        const t2 = setTask(db, "a", "implementation", "running", null);
        recordFeedChange(db, t2, "implementation", "running", { stage: "design_proposal", status: "waiting_user" }, emit);
        page = readFeed(db, {});
        expect(page.open).toHaveLength(0);
        expect(page.events.map((e) => e.kind)).toEqual(["stage_started", "design_ready"]);
        expect(page.events[1]!.resolved_at).not.toBeNull();
        expect(out.filter((e) => e.kind === "design_ready")).toHaveLength(2); // inserted, then resolved
    });
    it("supersedes an open ask with a newer one and resolves on done", () => {
        const db = fresh();
        const t = addTask(db, "a");
        insertFeedEvent(db, { kind: "blocked", category: "needs_you", text: "Blocked: x" }, { task: t });
        insertFeedEvent(db, { kind: "failed", category: "needs_you", text: "Research failed" }, { task: t });
        expect(readFeed(db, {}).open.map((e) => e.kind)).toEqual(["failed"]);
        recordFeedChange(db, setTask(db, "a", "done", "done", "merged"), "done", "done", { stage: "pr_approved", status: "running" });
        const page = readFeed(db, {});
        expect(page.open).toHaveLength(0);
        expect(page.events[0]!.kind).toBe("done");
    });
    it("dedupes the same kind and text within 60 s", () => {
        const db = fresh();
        const t = addTask(db, "a");
        const d = { kind: "pr_green", category: "pr" as const, text: "All checks passed" };
        expect(insertFeedEvent(db, d, { task: t, at: "2026-10-01T10:00:00.000Z" })).not.toBeNull();
        expect(insertFeedEvent(db, d, { task: t, at: "2026-10-01T10:00:30.000Z" })).toBeNull();
        expect(insertFeedEvent(db, d, { task: t, at: "2026-10-01T10:02:00.000Z" })).not.toBeNull();
        expect(readFeed(db, {}).events).toHaveLength(2);
    });
    it("marks seen by ids, task, env and all", () => {
        const db = fresh();
        const a = addTask(db, "a");
        const b = addTask(db, "b");
        const c = addTask(db, "c", { env_id: "e2" });
        const ids = [a, a, b, c].map((t, i) => insertFeedEvent(db, { kind: `k${i}`, category: "agent", text: `t${i}` }, { task: t })!.id);
        expect(readFeed(db, {}).unseen).toBe(4);
        expect(readFeed(db, { env: "e2" }).unseen).toBe(1);
        expect(markSeen(db, { ids: [ids[0]!] })).toBe(1);
        expect(markSeen(db, { ids: [ids[0]!] })).toBe(0);
        expect(markSeen(db, { taskId: "a" })).toBe(1);
        expect(markSeen(db, { all: true, env: "e2" })).toBe(1);
        expect(readFeed(db, {}).unseen).toBe(1);
        expect(markSeen(db, { all: true })).toBe(1);
        expect(readFeed(db, {}).unseen).toBe(0);
    });
    it("pages newest first by env, limit and before; events outlive their task", () => {
        const db = fresh();
        const a = addTask(db, "a");
        for (let i = 0; i < 5; i++) insertFeedEvent(db, { kind: `k${i}`, category: "agent", text: `t${i}` }, { task: a, at: `2026-10-01T10:0${i}:00.000Z` });
        expect(readFeed(db, { limit: 2 }).events.map((e) => e.kind)).toEqual(["k4", "k3"]);
        expect(readFeed(db, { limit: 2, before: "2026-10-01T10:03:00.000Z" }).events.map((e) => e.kind)).toEqual(["k2", "k1"]);
        expect(readFeed(db, { env: "other" }).events).toHaveLength(0);
        db.prepare(`DELETE FROM tasks WHERE id = 'a'`).run();
        expect(readFeed(db, {}).events[0]!.task_title).toBeNull();
    });
    it("keeps only the newest rows", () => {
        const db = fresh();
        const a = addTask(db, "a");
        const ins = db.prepare(`INSERT INTO feed_events (id, at, task_id, env_id, kind, category, text) VALUES (?, ?, 'a', 'e1', 'k', 'agent', ?)`);
        for (let i = 0; i < FEED_KEEP; i++) ins.run(`o${i}`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), `t${i}`);
        insertFeedEvent(db, { kind: "new", category: "agent", text: "new" }, { task: a });
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM feed_events`).get() as { n: number }).n;
        expect(n).toBe(FEED_KEEP);
        expect(db.prepare(`SELECT 1 FROM feed_events WHERE id = 'o0'`).get()).toBeUndefined();
        expect(readFeed(db, {}).events[0]!.kind).toBe("new");
    });
    it("backfills attention tasks without an open event, once", () => {
        const db = fresh();
        addTask(db, "a", { stage: "user_review", status: "waiting_user", status_line: "Ready" });
        addTask(db, "b", { stage: "implementation", status: "running" });
        addTask(db, "c", { stage: "manual_qa", status: "blocked", status_line: "stuck" });
        expect(backfillFeed(db)).toBe(2);
        expect(backfillFeed(db)).toBe(0);
        const open = readFeed(db, {}).open;
        expect(open.map((e) => e.kind).sort()).toEqual(["blocked", "user_review"]);
        expect(open.every((e) => e.at === "2026-10-01T00:00:00.000Z")).toBe(true);
    });
});
