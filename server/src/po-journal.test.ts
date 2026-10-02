import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { now, openDb } from "./db.js";
import { PoJournal } from "./po-journal.js";
import { impactOf, unifiedDiff } from "./product-owners.js";

describe("unifiedDiff", () => {
    it("keeps changed lines with context and marks gaps", () => {
        const a = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
        const b = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "J"].join("\n");
        expect(unifiedDiff(a, b, 1)).toEqual(["  a", "- b", "+ B", "  c", "…", "  i", "- j", "+ J"]);
    });
    it("is empty for equal texts and covers a new file", () => {
        expect(unifiedDiff("x", "x")).toEqual([]);
        expect(unifiedDiff("", "one\ntwo")).toEqual(["- ", "+ one", "+ two"]);
    });
});

describe("impactOf", () => {
    it("takes the closing Impact paragraph, bold or not", () => {
        expect(impactOf("Done.\n\nImpact: the unit menu moves to Settings.")).toBe("the unit menu moves to Settings.");
        expect(impactOf("Done.\n\n**Impact:** none.")).toBe("none.");
        expect(impactOf("No paragraph here.")).toBeNull();
    });
});

describe("PoJournal", () => {
    let dir = "";
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const journal = () => {
        dir = mkdtempSync(join(tmpdir(), "po-journal-"));
        const db = openDb(dir);
        db.pragma("foreign_keys = OFF");
        db.prepare(`INSERT INTO product_owners (id, title, slug, source, scope_kind, scope_id, phase, status, session_id, created_at, updated_at, env_id) VALUES ('po', 'P', 'po-p', 'linear', 'project', 's', 'live', 'idle', 'x', ?, ?, 'e')`).run(now(), now());
        return new PoJournal(db);
    };

    it("numbers questions and finds them by key", () => {
        const j = journal();
        j.addQuestion("po", "Where does the menu go?", "", null);
        const q2 = j.addQuestion("po", "Text or dropdown?", "density source", "ev1");
        expect(q2.key).toBe("Q2");
        expect(j.question("po", "q2")?.id).toBe(q2.id);
        j.pushThread(q2.id, { role: "user", text: "text", at: now() });
        j.patchQuestion(q2.id, { status: "proposed", resolution: "A text field." });
        const v = j.questions("po").find((q) => q.key === "Q2")!;
        expect(v.status).toBe("proposed");
        expect(v.thread).toHaveLength(1);
        expect(j.linked("ev1").questions).toEqual(["Q2"]);
    });

    it("finishes an event and leaves interrupted ones unread", () => {
        const j = journal();
        const e1 = j.addEvent({ poId: "po", kind: "artifact", title: "Uploaded x", prompt: "read it", status: "processing", refs: { artifacts: ["a1"] } });
        const e2 = j.addEvent({ poId: "po", kind: "artifact", title: "Uploaded y", prompt: "read it", status: "waiting", refs: { artifacts: ["a2"] } });
        j.finishEvent(e1.id, { status: "done", brief: "none.", changes: { context: ["+ x"] }, memory: [{ tool: "add_drawer", input: "{}" }] });
        expect(j.waitingFor("po", "a2").map((e) => e.id)).toEqual([e2.id]);
        j.setEventStatus(e2.id, "pending");
        j.interrupted();
        const views = j.events("po");
        expect(views.find((e) => e.id === e1.id)).toMatchObject({ status: "done", brief: "none.", changes: { context: ["+ x"] }, retryable: true });
        expect(views.find((e) => e.id === e2.id)?.status).toBe("unread");
    });

    it("replaces an open ticket correction with a newer one", () => {
        const j = journal();
        const c1 = j.addCorrection({ po_id: "po", kind: "ticket", target: "INV-1", title: "t", body: "", before: "a", after: "b", event_id: null });
        j.addCorrection({ po_id: "po", kind: "ticket", target: "inv-1", title: "t2", body: "", before: "a", after: "c", event_id: null });
        expect(j.correction("po", c1.id)?.status).toBe("withdrawn");
        expect(j.corrections("po").filter((c) => c.status === "open")).toHaveLength(1);
    });
});
