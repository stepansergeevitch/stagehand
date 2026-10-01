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
                { id: "C1", severity: "high", area: "scope", title: "Density must lock", body: "D16 says lock after first use." },
                { id: "C2", severity: "low", area: "question", title: "Label wording", body: "Minor." },
                { id: "C3", severity: "medium", area: "qa", title: "No QA for M3", body: "Add one.", thread: [{ role: "user", text: "Needed?", at: "t" }, { role: "po", text: "Yes, M3 is common.", at: "t" }] },
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
        expect(notes).toContain("### C3 · medium · qa");
        expect(notes).toContain("**Product Owner:** Yes, M3 is common.");
        expect(notes).not.toContain("Label wording");
        expect(notes).toContain("1 other(s) are skipped");
    });
    it("reads the old state-only po-review.json as no review", () => {
        const old = mkdtempSync(join(tmpdir(), "po-review-old-"));
        writeFileSync(join(old, "po-review.json"), JSON.stringify({ status: "done", at: "t" }));
        expect(readReview(old)).toBeNull();
    });
});
