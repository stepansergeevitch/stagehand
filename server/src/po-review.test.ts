import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReview, reviewNotes } from "./product-owners.js";

describe("PO design review", () => {
    const dir = mkdtempSync(join(tmpdir(), "po-review-"));
    writeFileSync(
        join(dir, "po-review.json"),
        JSON.stringify({
            verdict: "changes",
            summary: "Density rule contradicts D16.",
            comments: [
                { id: "C1", severity: "high", area: "scope", title: "Density must lock", body: "D16 says lock after first use.", note: "Keep the existing EA items unlocked." },
                { id: "C2", severity: "low", area: "question", title: "Label wording", body: "Minor." },
                { id: "C3", severity: "medium", area: "qa", laterTicket: "INV-155", title: "No QA for M3", body: "Add one.", thread: [{ role: "user", text: "Needed?", at: "t" }, { role: "po", text: "Yes, M3 is common.", at: "t" }] },
            ],
        }),
    );
    it("picks high and medium by default, not low", () => {
        const r = readReview(dir)!;
        expect(r.comments.map((c) => c.include)).toEqual([true, false, true]);
    });
    it("sends only the picked comments, with their discussion", () => {
        const notes = reviewNotes(readReview(dir)!, "UoM");
        expect(notes).toContain("### C1 · high · scope — Density must lock");
        expect(notes).toContain("### C3 · medium · qa · for INV-155");
        expect(notes).toContain("**Product Owner:** Yes, M3 is common.");
        expect(notes).toContain("**The human's note:** Keep the existing EA items unlocked.");
        expect(notes).not.toContain("Label wording");
        expect(notes).toContain("1 other(s) are skipped");
    });
    it("lists the files attached to a note and to a discussion message", () => {
        const f = { name: "a.png", file: "shared/1-a.png", mime: "image/png", size: 3 };
        const r = readReview(dir)!;
        r.comments[0]!.noteFiles = [f];
        r.comments[2]!.thread[0]!.files = [f];
        const notes = reviewNotes(r, null, "/t/x");
        expect(notes).toContain("Keep the existing EA items unlocked.\n\n### Files from the human (1)");
        expect(notes).toContain("`/t/x/shared/1-a.png`");
    });
});
