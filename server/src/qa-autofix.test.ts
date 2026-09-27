import { describe, expect, it } from "vitest";
import { autoFixKinds, decideQaFix } from "./qa-autofix.js";

describe("autoFixKinds", () => {
    it("widens with the scope and is empty when off or unknown", () => {
        expect([...autoFixKinds("off")]).toEqual([]);
        expect([...autoFixKinds(null)]).toEqual([]);
        expect([...autoFixKinds("seeds")]).toEqual(["seed", "teardown"]);
        expect([...autoFixKinds("seeds+steps")]).toEqual(["seed", "teardown", "step"]);
        expect([...autoFixKinds("seeds+steps+asserts")]).toEqual(["seed", "teardown", "step", "assert", "scenario"]);
    });
});

describe("decideQaFix", () => {
    const good = { legit: 0.94, weakens: 0.03, kind: "seed_fix" as const };
    it("approves a legitimate seed fix within scope", () => {
        expect(decideQaFix(good, "seed", "seeds+steps")).toEqual({ approve: true, why: "legit 94 %, weakens 3 %, read as seed_fix" });
    });
    it("refuses kinds outside the scope, scope cuts, mismatched readings and weak numbers", () => {
        expect(decideQaFix({ ...good, kind: "assert_semantics" }, "assert", "seeds+steps").approve).toBe(false);
        expect(decideQaFix({ ...good, kind: "scope_cut" }, "seed", "seeds+steps").why).toMatch(/scope cut/);
        expect(decideQaFix({ ...good, kind: "assert_semantics" }, "seed", "seeds+steps").why).toMatch(/reads the change as assert_semantics/);
        expect(decideQaFix({ ...good, legit: 0.8 }, "seed", "seeds").why).toMatch(/not clearly legitimate/);
        expect(decideQaFix({ ...good, weakens: 0.2 }, "seed", "seeds").why).toMatch(/weaken/);
        expect(decideQaFix({ ...good, kind: "step_mechanics" }, "step", "seeds").approve).toBe(false);
        expect(decideQaFix({ ...good, kind: "step_mechanics" }, "step", "seeds+steps").approve).toBe(true);
        expect(decideQaFix({ ...good, kind: "assert_semantics" }, "scenario", "seeds+steps+asserts").approve).toBe(true);
    });
});
