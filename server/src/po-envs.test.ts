import { describe, expect, it } from "vitest";
import { poEnvIds, poWorksFor } from "./product-owners.js";

describe("poEnvIds", () => {
    it("is the primary environment alone when env_ids is unset", () => {
        expect(poEnvIds({ env_id: "a", env_ids: null })).toEqual(["a"]);
    });
    it("puts the primary first and drops duplicates and junk", () => {
        expect(poEnvIds({ env_id: "a", env_ids: JSON.stringify(["b", "a", 3, "c"]) })).toEqual(["a", "b", "c"]);
        expect(poEnvIds({ env_id: "a", env_ids: "not json" })).toEqual(["a"]);
    });
    it("tells whether a PO works for an environment", () => {
        const po = { env_id: "a", env_ids: JSON.stringify(["a", "b"]) };
        expect(poWorksFor(po, "b")).toBe(true);
        expect(poWorksFor(po, "c")).toBe(false);
        expect(poWorksFor(undefined, "a")).toBe(false);
    });
});
