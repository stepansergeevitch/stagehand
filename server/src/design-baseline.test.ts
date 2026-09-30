import { describe, expect, it } from "vitest";
import { scenarioHashes } from "./engine.js";
import type { DesignResult } from "./stages/contracts.js";

const design = (qa: unknown[]): DesignResult => ({ qa } as unknown as DesignResult);

describe("scenarioHashes", () => {
    it("ignores key order and keeps one hash per scenario", () => {
        const a = scenarioHashes(design([{ id: "S1", title: "t", steps: [{ action: "a", assert: "b" }] }, { id: "S2", title: "u", steps: [] }]));
        const b = scenarioHashes(design([{ steps: [{ assert: "b", action: "a" }], title: "t", id: "S1" }, { id: "S2", steps: [], title: "u" }]));
        expect(a).toEqual(b);
        expect(Object.keys(a)).toEqual(["S1", "S2"]);
    });
    it("changes only the edited scenario's hash", () => {
        const a = scenarioHashes(design([{ id: "S1", title: "t" }, { id: "S2", title: "u" }]));
        const b = scenarioHashes(design([{ id: "S1", title: "t" }, { id: "S2", title: "u2" }]));
        expect(b["S1"]).toBe(a["S1"]);
        expect(b["S2"]).not.toBe(a["S2"]);
    });
});
