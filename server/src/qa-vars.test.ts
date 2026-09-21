import { describe, expect, it } from "vitest";
import { fillQaVars, newQaPassId, qaContractProblems } from "./qa-vars.js";

const vars = { beUrl: "http://localhost:18002", feUrl: "http://localhost:13001", appUrl: "http://localhost:13001", qaPass: "b7k2x" };

describe("fillQaVars", () => {
    it("resolves every placeholder, repeatedly", () => {
        expect(fillQaVars("curl {{beUrl}}/public/v3-alpha/x -d '{\"serial\":\"QA-X001-{{qaPass}}\",\"b\":\"QA-X002-{{qaPass}}\"}' {{appUrl}}", vars)).toBe(
            "curl http://localhost:18002/public/v3-alpha/x -d '{\"serial\":\"QA-X001-b7k2x\",\"b\":\"QA-X002-b7k2x\"}' http://localhost:13001",
        );
    });
    it("makes pass ids that start with the pass letter", () => {
        expect(newQaPassId("qa_baseline", 1789900000000)).toMatch(/^b[0-9a-z]{5}$/);
        expect(newQaPassId("manual_qa", 1789900000000)).toMatch(/^a[0-9a-z]{5}$/);
    });
});

describe("qaContractProblems", () => {
    it("accepts a self-resetting API scenario addressed through placeholders", () => {
        expect(
            qaContractProblems([
                { id: "S1", kind: "api", teardown: ["shell: psql -c \"DELETE FROM items WHERE sku LIKE 'QA-INV-1%'\""], seed: ["shell: psql -c \"INSERT INTO items …\""], steps: [{ action: "curl -sS {{beUrl}}/public/v3-alpha/items/", assert: "200" }] },
            ]),
        ).toBeNull();
    });
    it("flags hard-coded hosts, bare paths, missing teardown and non-shell teardown", () => {
        const out = qaContractProblems([
            { id: "S1", kind: "api", seed: ["shell: poetry run python manage.py shell -c 'Item.objects.get_or_create(...)'"], steps: [{ action: "curl -sS http://localhost:18000/public/v3/x", assert: "201" }, { action: "curl -sS -X POST /public/v3/y", assert: "201" }] },
            { id: "S2", kind: "browser", teardown: ["ui: click delete"], seed: [], steps: [{ action: "open /x", assert: "ok" }] },
        ]);
        expect(out).toContain("S1 step 1 hard-codes a host");
        expect(out).toContain("S1 step 2 calls curl with a bare path");
        expect(out).toContain("S1 seeds create records but has no teardown");
        expect(out).toContain("S2 teardown 1 must be a `shell:` or `sql:` command");
    });
    it("does not demand a teardown from a scenario that only reads", () => {
        expect(qaContractProblems([{ id: "S3", kind: "api", seed: ["shell: cat /tmp/x.env"], steps: [{ action: "curl {{beUrl}}/x", assert: "200" }] }])).toBeNull();
    });
});
