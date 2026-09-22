import { describe, expect, it } from "vitest";
import { mergeQuestions, mergeScenarios, planQaShards, shardFiles } from "./qa-shards.js";

const S = (id: string, kind: "browser" | "api" = "browser", exclusive = false) => ({ id, kind, exclusive });

describe("planQaShards", () => {
    it("keeps a single scenario as one shard", () => {
        const p = planQaShards("g", [S("S1")], { cloneMode: true, maxBrowser: 3, maxShards: 4 });
        expect(p).toEqual([{ group: "g", id: "all", scenarios: ["S1"], browser: true, phase: "parallel" }]);
    });
    it("does not shard when disabled", () => {
        const p = planQaShards("g", [S("S1"), S("S2", "api")], { cloneMode: true, maxBrowser: 3, maxShards: 0 });
        expect(p).toHaveLength(1);
        expect(p[0]!.scenarios).toEqual(["S1", "S2"]);
        expect(p[0]!.browser).toBe(true);
    });
    it("puts API scenarios in one Chrome-less shard and browser ones in one shared shard without clones", () => {
        const p = planQaShards("g", [S("S1"), S("S2", "api"), S("S3"), S("S4", "api")], { cloneMode: false, maxBrowser: 1, maxShards: 4 });
        expect(p.map((s) => [s.id, s.scenarios, s.browser])).toEqual([
            ["api", ["S2", "S4"], false],
            ["browser", ["S1", "S3"], true],
        ]);
    });
    it("gives every browser scenario its own shard in clone mode, packed to the clone cap", () => {
        const p = planQaShards("g", [S("S1"), S("S2"), S("S3"), S("S4"), S("S5", "api")], { cloneMode: true, maxBrowser: 3, maxShards: 6 });
        expect(p.map((s) => s.id)).toEqual(["api", "S1+S4", "S2", "S3"]);
        expect(p.filter((s) => s.browser)).toHaveLength(3);
    });
    it("respects the overall shard cap", () => {
        const p = planQaShards("g", [S("S1"), S("S2"), S("S3"), S("S4", "api")], { cloneMode: true, maxBrowser: 3, maxShards: 2 });
        expect(p.map((s) => s.id)).toEqual(["api", "S1+S2+S3"]);
    });
    it("runs exclusive scenarios alone after the parallel phase", () => {
        const p = planQaShards("g", [S("S1"), S("S2", "api"), S("S3", "browser", true)], { cloneMode: true, maxBrowser: 3, maxShards: 4 });
        expect(p.map((s) => [s.id, s.phase])).toEqual([
            ["api", "parallel"],
            ["S1", "parallel"],
            ["solo", "solo"],
        ]);
    });
    it("orders ids numerically inside a shard", () => {
        const p = planQaShards("g", [S("S10", "api"), S("S2", "api")], { cloneMode: false, maxBrowser: 1, maxShards: 4 });
        expect(p[0]!.scenarios).toEqual(["S2", "S10"]);
    });
});

describe("shard files and merges", () => {
    it("names per-shard files and the plain pass files", () => {
        expect(shardFiles("after", undefined)).toEqual({ output: "qa/after.json", partial: "qa/after.partial.json", questions: "questions.json" });
        expect(shardFiles("before", { group: "g", id: "S1+S2", scenarios: [], browser: true, phase: "parallel" })).toEqual({ output: "qa/before.S1+S2.json", partial: "qa/before.S1+S2.partial.json", questions: "qa/questions.before.S1+S2.json" });
    });
    it("merges scenarios by id, later wins, sorted", () => {
        const m = mergeScenarios([{ id: "S3", v: 1 }, { id: "S1", v: 1 }], [{ id: "S3", v: 2 }, { id: "S10", v: 1 }]);
        expect(m).toEqual([{ id: "S1", v: 1 }, { id: "S3", v: 2 }, { id: "S10", v: 1 }]);
    });
    it("prefixes colliding question ids with the shard", () => {
        const q = mergeQuestions([
            { shard: "S1", questions: [{ id: "q1" }, { id: "q2" }] },
            { shard: "S2", questions: [{ id: "q1" }, { id: "q3" }] },
        ]);
        expect(q.map((x) => x.id)).toEqual(["q1", "q2", "S2-q1", "q3"]);
    });
});
