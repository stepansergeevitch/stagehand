import { randomUUID } from "node:crypto";
import { now, type DB, type SharedFile, type PoCorrectionRow, type PoEventRow, type PoQuestionRow } from "./db.js";

// The journal of a Product Owner: its events, its outstanding questions and its suggested corrections (rows only —
// ProductOwners runs the turns that fill them).
//
//   events       what reached the PO (a source, a task-manager change, a chat that changed its files, a resolved
//                question, a human edit) and what the turn that processed it did: the PO's brief, the diffs of
//                context.md / design.md / tickets.json with the revisions they produced, and the palace writes. The
//                context, design and memory can be replayed from them.
//   questions    the PO keeps the list (through the local API); the human discusses each one with the PO and confirms
//                the resolution the PO suggests; the PO then records it in its context.
//   corrections  after an event: a new description for an existing ticket, or a change to the design of an existing
//                task; the human sends the task ones to the task's agent, or discards them.

export type PoEventKind = "created" | "artifact" | "tracker" | "chat" | "system" | "design" | "tickets" | "question" | "edit" | "context";
export interface PoEventChanges {
    context?: string[];
    design?: string[];
    tickets?: string[];
    // The revision files the turn left (revisions/<file>.<ms>): the full text after the event.
    revisions?: Record<string, string>;
}
export interface PoMemoryWrite { tool: string; input: string }
export interface PoEventRefs { artifacts?: string[]; question?: string; turn?: "chat" | "system" }
export interface PoEventView extends Omit<PoEventRow, "changes" | "memory" | "refs" | "prompt"> {
    changes: PoEventChanges | null;
    memory: PoMemoryWrite[];
    refs: PoEventRefs;
    retryable: boolean;
}
export interface PoThreadMessage { role: "user" | "po"; text: string; at: string; files?: SharedFile[] }
export interface PoQuestionView extends Omit<PoQuestionRow, "thread" | "session_id"> { thread: PoThreadMessage[] }
export type PoCorrectionView = PoCorrectionRow;

const parse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try {
        return JSON.parse(s) as T;
    } catch {
        return fallback;
    }
};

export class PoJournal {
    constructor(private readonly db: DB) {}

    // ---------- events ----------

    addEvent(e: { poId: string; kind: PoEventKind; title: string; body?: string; prompt?: string | null; status: PoEventRow["status"]; refs?: PoEventRefs; id?: string; brief?: string | null; changes?: PoEventChanges | null; at?: string }): PoEventRow {
        const row: PoEventRow = {
            id: e.id ?? randomUUID(),
            po_id: e.poId,
            kind: e.kind,
            title: e.title.slice(0, 300),
            body: e.body ?? "",
            prompt: e.prompt ?? null,
            status: e.status,
            brief: e.brief ?? null,
            changes: e.changes ? JSON.stringify(e.changes) : null,
            memory: null,
            refs: e.refs ? JSON.stringify(e.refs) : null,
            error: null,
            created_at: e.at ?? now(),
            processed_at: e.status === "done" ? (e.at ?? now()) : null,
        };
        this.db
            .prepare(`INSERT INTO po_events (id, po_id, kind, title, body, prompt, status, brief, changes, memory, refs, error, created_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(row.id, row.po_id, row.kind, row.title, row.body, row.prompt, row.status, row.brief, row.changes, row.memory, row.refs, row.error, row.created_at, row.processed_at);
        return row;
    }
    event(id: string): PoEventRow | undefined {
        return this.db.prepare(`SELECT * FROM po_events WHERE id = ?`).get(id) as PoEventRow | undefined;
    }
    setEventStatus(id: string, status: PoEventRow["status"], error: string | null = null): void {
        this.db.prepare(`UPDATE po_events SET status = ?, error = ? WHERE id = ?`).run(status, error, id);
    }
    finishEvent(id: string, r: { status: "done" | "failed"; brief: string | null; changes: PoEventChanges | null; memory: PoMemoryWrite[]; error?: string | null }): void {
        this.db
            .prepare(`UPDATE po_events SET status = ?, brief = ?, changes = ?, memory = ?, error = ?, processed_at = ? WHERE id = ?`)
            .run(r.status, r.brief, r.changes ? JSON.stringify(r.changes) : null, r.memory.length ? JSON.stringify(r.memory) : null, r.error ?? null, now(), id);
    }
    // Events whose artifact waits for its description or text before the PO reads it.
    waitingFor(poId: string, artifactId: string): PoEventRow[] {
        return (this.db.prepare(`SELECT * FROM po_events WHERE po_id = ? AND status = 'waiting'`).all(poId) as PoEventRow[]).filter((e) => parse<PoEventRefs>(e.refs, {}).artifacts?.includes(artifactId));
    }
    events(poId: string, limit = 300): PoEventView[] {
        return (this.db.prepare(`SELECT * FROM po_events WHERE po_id = ? ORDER BY created_at DESC LIMIT ?`).all(poId, limit) as PoEventRow[]).map((e) => {
            const { prompt, changes, memory, refs, ...rest } = e;
            return { ...rest, changes: parse<PoEventChanges | null>(changes, null), memory: parse<PoMemoryWrite[]>(memory, []), refs: parse<PoEventRefs>(refs, {}), retryable: !!prompt };
        });
    }
    countEvents(poId: string): number {
        return (this.db.prepare(`SELECT COUNT(*) AS n FROM po_events WHERE po_id = ?`).get(poId) as { n: number }).n;
    }
    // A restart ends every turn: what was queued or being read is left unread, for the human to send again.
    interrupted(): void {
        this.db.prepare(`UPDATE po_events SET status = 'unread', error = 'interrupted by a Vortex restart' WHERE status IN ('pending', 'processing')`).run();
    }

    // ---------- questions ----------

    questions(poId: string): PoQuestionView[] {
        return (this.db.prepare(`SELECT * FROM po_questions WHERE po_id = ? ORDER BY created_at`).all(poId) as PoQuestionRow[]).map(({ thread, session_id: _s, ...q }) => ({ ...q, thread: parse<PoThreadMessage[]>(thread, []) }));
    }
    // By its id or its key (Q3).
    question(poId: string, ref: string): PoQuestionRow | undefined {
        return this.db.prepare(`SELECT * FROM po_questions WHERE po_id = ? AND (id = ? OR UPPER(key) = UPPER(?))`).get(poId, ref, ref) as PoQuestionRow | undefined;
    }
    addQuestion(poId: string, question: string, detail: string, eventId: string | null): PoQuestionRow {
        const keys = (this.db.prepare(`SELECT key FROM po_questions WHERE po_id = ?`).all(poId) as Array<{ key: string }>).map((r) => Number(r.key.replace(/^Q/i, "")) || 0);
        const row: PoQuestionRow = { id: randomUUID(), po_id: poId, key: `Q${Math.max(0, ...keys) + 1}`, question: question.trim(), detail: detail.trim(), status: "open", resolution: null, thread: "[]", session_id: null, event_id: eventId, created_at: now(), updated_at: now(), resolved_at: null };
        this.db
            .prepare(`INSERT INTO po_questions (id, po_id, key, question, detail, status, resolution, thread, session_id, event_id, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(row.id, row.po_id, row.key, row.question, row.detail, row.status, row.resolution, row.thread, row.session_id, row.event_id, row.created_at, row.updated_at, row.resolved_at);
        return row;
    }
    patchQuestion(id: string, patch: Partial<Pick<PoQuestionRow, "question" | "detail" | "status" | "resolution" | "session_id" | "resolved_at">>): void {
        const cur = this.db.prepare(`SELECT * FROM po_questions WHERE id = ?`).get(id) as PoQuestionRow | undefined;
        if (!cur) return;
        const n = { ...cur, ...patch };
        this.db.prepare(`UPDATE po_questions SET question = ?, detail = ?, status = ?, resolution = ?, session_id = ?, resolved_at = ?, updated_at = ? WHERE id = ?`).run(n.question, n.detail, n.status, n.resolution, n.session_id, n.resolved_at, now(), id);
    }
    pushThread(id: string, m: PoThreadMessage): void {
        const cur = this.db.prepare(`SELECT thread FROM po_questions WHERE id = ?`).get(id) as { thread: string } | undefined;
        if (!cur) return;
        this.db.prepare(`UPDATE po_questions SET thread = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify([...parse<PoThreadMessage[]>(cur.thread, []), m]), now(), id);
    }
    thread(id: string): PoThreadMessage[] {
        return parse<PoThreadMessage[]>((this.db.prepare(`SELECT thread FROM po_questions WHERE id = ?`).get(id) as { thread: string } | undefined)?.thread ?? null, []);
    }

    // ---------- corrections ----------

    corrections(poId: string): PoCorrectionView[] {
        return this.db.prepare(`SELECT * FROM po_corrections WHERE po_id = ? ORDER BY created_at DESC`).all(poId) as PoCorrectionRow[];
    }
    correction(poId: string, id: string): PoCorrectionRow | undefined {
        return this.db.prepare(`SELECT * FROM po_corrections WHERE po_id = ? AND id = ?`).get(poId, id) as PoCorrectionRow | undefined;
    }
    addCorrection(c: Omit<PoCorrectionRow, "id" | "status" | "created_at" | "updated_at">): PoCorrectionRow {
        // A newer suggestion for the same ticket's description replaces the open one.
        if (c.kind === "ticket") this.db.prepare(`UPDATE po_corrections SET status = 'withdrawn', updated_at = ? WHERE po_id = ? AND kind = 'ticket' AND UPPER(target) = UPPER(?) AND status = 'open'`).run(now(), c.po_id, c.target);
        const row: PoCorrectionRow = { ...c, id: randomUUID(), status: "open", created_at: now(), updated_at: now() };
        this.db
            .prepare(`INSERT INTO po_corrections (id, po_id, kind, target, title, body, before, after, status, event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(row.id, row.po_id, row.kind, row.target, row.title, row.body, row.before, row.after, row.status, row.event_id, row.created_at, row.updated_at);
        return row;
    }
    setCorrectionStatus(ids: string[], status: PoCorrectionRow["status"]): void {
        const st = this.db.prepare(`UPDATE po_corrections SET status = ?, updated_at = ? WHERE id = ?`);
        for (const id of ids) st.run(status, now(), id);
    }

    // Counts for the tab labels.
    linked(eventId: string): { questions: string[]; corrections: number } {
        return {
            questions: (this.db.prepare(`SELECT key FROM po_questions WHERE event_id = ?`).all(eventId) as Array<{ key: string }>).map((r) => r.key),
            corrections: (this.db.prepare(`SELECT COUNT(*) AS n FROM po_corrections WHERE event_id = ?`).get(eventId) as { n: number }).n,
        };
    }

    remove(poId: string): void {
        for (const t of ["po_events", "po_questions", "po_corrections"]) this.db.prepare(`DELETE FROM ${t} WHERE po_id = ?`).run(poId);
    }
}
