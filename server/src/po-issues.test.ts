import { describe, expect, it } from "vitest";
import { describeChange, issueHash, lineDiff } from "./product-owners.js";
import type { TrackedIssue } from "./sources.js";

const base: TrackedIssue = {
    identifier: "INV-1", remoteId: "r1", url: "https://linear.app/x/issue/INV-1", title: "Units", status: "Backlog", description: "one\ntwo\nthree",
    labels: ["Backend"], assignee: null, priority: null, estimate: null, parent: null,
    comments: [{ id: "c1", author: "Ann", at: "2026-09-01T00:00:00Z", body: "first" }],
};

describe("issue change detection", () => {
    it("hashes the same state the same", () => {
        expect(issueHash({ ...base })).toBe(issueHash(JSON.parse(JSON.stringify(base)) as TrackedIssue));
        expect(issueHash({ ...base, status: "Done" })).not.toBe(issueHash(base));
    });
    it("diffs lines", () => {
        expect(lineDiff("one\ntwo\nthree", "one\n2\nthree")).toEqual(["- two", "+ 2"]);
    });
    it("names every kind of change", () => {
        const next: TrackedIssue = {
            ...base, status: "In Progress", labels: ["Frontend"], description: "one\ntwo\nthree\nfour",
            comments: [{ id: "c1", author: "Ann", at: base.comments[0]!.at, body: "first, edited" }, { id: "c2", author: "Bob", at: "2026-09-02T00:00:00Z", body: "new one" }],
        };
        const out = describeChange(base, next).join("\n");
        expect(out).toContain("**Status:** Backlog → In Progress");
        expect(out).toContain("+Frontend");
        expect(out).toContain("−Backend");
        expect(out).toContain("+ four");
        expect(out).toContain("**Comment edited** by Ann");
        expect(out).toContain("**New comment** by Bob");
        expect(describeChange(next, { ...next, comments: [] }).join("\n")).toContain("**Comment deleted**");
        expect(describeChange(base, base)).toEqual([]);
    });
});
