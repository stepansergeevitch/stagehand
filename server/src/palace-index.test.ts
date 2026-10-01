import { describe, expect, it } from "vitest";
import { CHUNK_MAX, chunkDocument, chunkText, drawerText, issueDrawers, looksLikeConversation } from "./palace-index.js";

describe("palace index chunks", () => {
    it("splits a document on its headings, with the heading path and lines", () => {
        const md = ["# Spec", "intro line", "", "## Density", "Density locks after first use.", "", "### Rules", "Rule one applies to every line."].join("\n");
        const c = chunkDocument(md);
        expect(c.map((x) => x.section)).toEqual(["Spec", "Spec › Density", "Spec › Density › Rules"]);
        expect(c[1]).toMatchObject({ lineFrom: 4, lineTo: 6 });
        expect(drawerText("Scope doc", "artifacts/a.md", c[1]!)).toMatch(/^\[Scope doc › Spec › Density · artifacts\/a\.md L4-6\]\n## Density/);
    });
    it("cuts a long section into overlapping windows within the size", () => {
        const para = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says one thing.`).join(" ");
        const c = chunkDocument(`## Long\n${para}`);
        expect(c.length).toBeGreaterThan(2);
        for (const x of c) expect(x.text.length).toBeLessThanOrEqual(CHUNK_MAX);
    });
    it("groups the turns of a conversation and names the speakers", () => {
        const convo = ["Austin: density must lock after use", "Stepan: agreed, and EA stays", "Austin: ok", "Stepan: next is M3", "Austin: M3 not M³"].join("\n");
        expect(looksLikeConversation(convo)).toBe(true);
        const c = chunkText(convo);
        expect(c).toHaveLength(1);
        expect(c[0]!.section).toBe("conversation: Austin, Stepan");
        expect(looksLikeConversation("# Title\nplain text\nmore text\nand more")).toBe(false);
    });
    it("files an issue head and one drawer per comment", () => {
        const d = issueDrawers({ identifier: "INV-1", remoteId: "r", url: "u", title: "Units", status: "Backlog", description: "Do units.", labels: ["Backend"], assignee: null, priority: null, estimate: null, parent: null, comments: [{ id: "c1", author: "Ann", at: "t", body: "Looks good" }] });
        expect(d.map((x) => x.part)).toEqual(["desc0", "cc1_0"]);
        expect(d[1]!.text).toContain("comment by Ann");
    });
});
