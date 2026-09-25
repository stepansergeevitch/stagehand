import { describe, expect, it } from "vitest";
import { flagSubstitutions, isNetworkError } from "./qa-grade.js";

const pass = (id: string, observation: string) => ({ id, outcome: "pass" as const, observation, shots: [], log: "" });

describe("flagSubstitutions", () => {
    it("turns a pass with a substitution in its observation into needs_human", () => {
        const qa = flagSubstitutions({ pass: "after", scenarios: [pass("S1", "seeded customer not selectable — substituted Walk-In Customer, invoice posted")], blockers: [] });
        expect(qa.scenarios[0]!.outcome).toBe("needs_human");
        expect(qa.scenarios[0]!.observation).toMatch(/^the runner substituted data \("substituted" in its observation\)/);
    });

    it("uses a pass-level blocker when it names the scenario, or when the pass has one scenario", () => {
        const blockers = ["seeded customer (id 1, intercompany type) not selectable in invoice customer picker — substituted A1A Car Wash"];
        const two = flagSubstitutions({ pass: "after", scenarios: [pass("S1", "IN-540339 posted"), pass("S2", "CS-086472 posted")], blockers });
        expect(two.scenarios.map((s) => s.outcome)).toEqual(["pass", "pass"]);
        const named = flagSubstitutions({ pass: "after", scenarios: [pass("S1", "IN-540339 posted"), pass("S2", "CS-086472 posted")], blockers: ["S1: " + blockers[0]!] });
        expect(named.scenarios.map((s) => s.outcome)).toEqual(["needs_human", "pass"]);
        const one = flagSubstitutions({ pass: "after", scenarios: [pass("S1", "IN-540339 posted")], blockers });
        expect(one.scenarios[0]!.outcome).toBe("needs_human");
    });

    it("leaves fails, blocks and clean passes alone", () => {
        const qa = flagSubstitutions({ pass: "after", scenarios: [{ ...pass("S1", "substituted"), outcome: "fail" }, pass("S2", "picker listed only S2-A-; cash sale posted")], blockers: [] });
        expect(qa.scenarios.map((s) => s.outcome)).toEqual(["fail", "pass"]);
    });
});

describe("isNetworkError", () => {
    it("matches the CLI's network failures and nothing else", () => {
        expect(isNetworkError("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)")).toBe(true);
        expect(isNetworkError("API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)")).toBe(true);
        expect(isNetworkError("stopped at the 80-turn cap before writing qa/after.S1.json")).toBe(false);
        expect(isNetworkError("contract: after.json is not valid JSON")).toBe(false);
    });
});
