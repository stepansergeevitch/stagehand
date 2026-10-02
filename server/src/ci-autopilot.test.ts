import { describe, expect, it } from "vitest";
import { addedFiles, changedRanges, repoPath, testId, testSpan, verifyFailure, type TriageFailure, type VerifyCtx } from "./ci-autopilot.js";

const DIFF = `diff --git a/app/views.py b/app/views.py
--- a/app/views.py
+++ b/app/views.py
@@ -10,0 +11,3 @@ def list_items():
+    a = 1
+    b = 2
+    c = 3
@@ -40 +43 @@
-old
+new
diff --git a/tests/test_items.py b/tests/test_items.py
--- a/tests/test_items.py
+++ b/tests/test_items.py
@@ -20,0 +21,2 @@
+    assert x
+    assert y
diff --git a/app/migrations/0042_units.py b/app/migrations/0042_units.py
--- /dev/null
+++ b/app/migrations/0042_units.py
@@ -0,0 +1,5 @@
+x
+x
+x
+x
+x
`;
const TEST_SRC = ["import x", "", "def test_other():", "    assert 1", "", "@pytest.mark.db", "def test_budget(db):", "    items()", "    assert queries < 5", "", "def test_later():", "    pass"].join("\n");
const TEST_SRC_CHANGED = Array.from({ length: 30 }, (_, i) => (i === 19 ? "def test_mine():" : i === 21 ? "    assert x" : i === 2 ? "def test_untouched():" : `    line ${i}`)).join("\n");

const ctx = (over: Partial<VerifyCtx> = {}): VerifyCtx => {
    const files: Record<string, string> = { "app/views.py": "", "tests/test_items.py": TEST_SRC_CHANGED, "tests/test_budget.py": TEST_SRC, "app/migrations/0042_units.py": "", "app/migrations/0041_old.py": "" };
    return {
        changed: changedRanges(DIFF),
        added: addedFiles("M\tapp/views.py\nM\ttests/test_items.py\nA\tapp/migrations/0042_units.py"),
        known: (p) => p in files,
        headFile: (p) => files[p] ?? null,
        baseHasFile: async (p) => p !== "app/migrations/0042_units.py",
        baseCheck: async () => "success",
        localBase: async () => null,
        ...over,
    };
};
const f = (x: Partial<TriageFailure>): TriageFailure => ({ check: "tests", kind: "other", what: "", tests: [], locations: [], evidence: "", verdict: "allow", reason: "", ...x });

describe("git facts", () => {
    it("reads new-side ranges and added files", () => {
        const r = changedRanges(DIFF);
        expect(r.get("app/views.py")).toEqual([[11, 13], [43, 43]]);
        expect(r.get("app/migrations/0042_units.py")).toEqual([[1, 5]]);
        expect([...addedFiles("A\tx.py\nM\ty.py\nR100\ta\tb")]).toEqual(["x.py"]);
    });
    it("cuts CI paths to the repository", () => {
        expect(repoPath("/home/runner/work/app/app/app/views.py", (p) => p === "app/views.py")).toBe("app/views.py");
        expect(repoPath("./nope.py", () => false)).toBeNull();
    });
    it("finds a test's span with its decorators", () => {
        expect(testSpan(TEST_SRC, "test_budget")).toEqual([6, 9]);
        expect(testSpan("describe('x', () => {\n  it('adds', () => {\n    expect(1)\n  })\n})", "adds")).toEqual([2, 4]);
        expect(testId("tests/a.py::TestX::test_y[1]")).toEqual({ file: "tests/a.py", name: "test_y" });
    });
});

describe("verifyFailure", () => {
    it("allows lint only on the branch's lines", async () => {
        const v = await verifyFailure(f({ kind: "own_lint", locations: ["/w/app/app/views.py:12:5", "app/views.py:30:1"] }), ctx());
        expect(v.allowed).toBe(true);
        expect(v.keep).toEqual(["/w/app/app/views.py:12:5"]);
        const no = await verifyFailure(f({ kind: "own_lint", locations: ["app/views.py:30:1"] }), ctx());
        expect(no.allowed).toBe(false);
    });
    it("allows a migration only when the branch added it", async () => {
        expect((await verifyFailure(f({ kind: "own_migration", locations: ["app/migrations/0042_units.py"] }), ctx())).allowed).toBe(true);
        expect((await verifyFailure(f({ kind: "own_migration", locations: ["app/migrations/0041_old.py"] }), ctx())).allowed).toBe(false);
    });
    it("tells the branch's own test from an untouched one", async () => {
        const own = await verifyFailure(f({ kind: "own_test", tests: ["tests/test_items.py::test_mine"] }), ctx({ baseCheck: async () => "failure" }));
        expect(own.allowed).toBe(true);
        // In a changed file, but the test itself is untouched: it must pass on base.
        const untouched = await verifyFailure(f({ kind: "own_test", tests: ["tests/test_items.py::test_untouched"] }), ctx({ baseCheck: async () => "failure" }));
        expect(untouched.allowed).toBe(false);
    });
    it("allows an affected test that passes on base, and denies one that fails there too", async () => {
        const budget = f({ kind: "affected_test", tests: ["tests/test_budget.py::test_budget"] });
        expect((await verifyFailure(budget, ctx())).allowed).toBe(true);
        expect((await verifyFailure(budget, ctx({ baseCheck: async () => "none", localBase: async () => "pass" }))).allowed).toBe(true);
        const v = await verifyFailure(budget, ctx({ baseCheck: async () => "failure", localBase: async () => "fail" }));
        expect(v.allowed).toBe(false);
        expect(v.why).toMatch(/fail on base/);
        expect((await verifyFailure(budget, ctx({ baseCheck: async () => "none" }))).allowed).toBe(false);
    });
    it("never allows a denied or other failure", async () => {
        expect((await verifyFailure(f({ kind: "other" }), ctx())).allowed).toBe(false);
        expect((await verifyFailure(f({ kind: "own_lint", verdict: "deny", locations: ["app/views.py:12"] }), ctx())).allowed).toBe(false);
    });
});
