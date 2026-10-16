import { describe, expect, it } from "vitest";
import { BEGIN_MARK, END_MARK, djangoBatchEnv, parseBatchOutput, parseDjangoShellCall, planSeedUnits } from "./seed-batch.js";

describe("parseDjangoShellCall", () => {
    it("splits a manage.py shell -c command into prefix and unescaped code", () => {
        const cmd = 'cd backend && AWS_PROFILE=dualentry poetry run python dualentry/manage.py shell -c "from core.models.item import Item\\nprint(\\"ok\\"); x = \\"$HOME\\""';
        expect(parseDjangoShellCall(cmd)).toEqual({ prefix: "cd backend && AWS_PROFILE=dualentry poetry run python dualentry/manage.py shell", code: 'from core.models.item import Item\\nprint("ok"); x = "$HOME"' });
    });
    it("rejects psql, curl and single-quoted code", () => {
        expect(parseDjangoShellCall("psql -c \"select 1\"")).toBeNull();
        expect(parseDjangoShellCall("curl -s http://x")).toBeNull();
        expect(parseDjangoShellCall("cd backend && poetry run python manage.py shell -c 'print(1)'")).toBeNull();
    });
});

describe("planSeedUnits", () => {
    it("batches consecutive Django steps with one prefix and keeps other steps in order", () => {
        const d = (label: string, code: string) => ({ label, cmd: `cd backend && poetry run python manage.py shell -c "${code}"` });
        const units = planSeedUnits([d("S1 teardown 1", "t1"), d("S1 seed 1", "s1"), { label: "S2 teardown 1", cmd: "psql -c \"DELETE FROM x\"" }, d("S2 seed 1", "s2")]);
        expect(units.map((u) => u.kind)).toEqual(["django", "plain", "django"]);
        expect(units[0]!.kind === "django" && units[0]!.items.map((i) => i.label)).toEqual(["S1 teardown 1", "S1 seed 1"]);
    });
});

describe("parseBatchOutput", () => {
    it("returns one result per label, in order, with output and error", () => {
        const stdout = [`${BEGIN_MARK}S1 seed 1@@`, "SEEDED 42", `${END_MARK}S1 seed 1 OK@@`, `${BEGIN_MARK}S2 seed 1@@`, "Traceback …", "ImportError: cannot import name 'Foo'", `${END_MARK}S2 seed 1 FAILED ImportError: cannot import name 'Foo'@@`].join("\n");
        const r = parseBatchOutput(stdout, ["S1 seed 1", "S2 seed 1", "S3 seed 1"]);
        expect(r[0]).toEqual({ label: "S1 seed 1", ok: true, output: "SEEDED 42", error: "" });
        expect(r[1]!.ok).toBe(false);
        expect(r[1]!.error).toBe("ImportError: cannot import name 'Foo'");
        expect(r[2]!.ok).toBe(false);
        expect(r[2]!.error).toMatch(/ended before this step ran/);
    });
    it("encodes the items for the runner's environment", () => {
        const env = djangoBatchEnv([{ label: "S1 seed 1", code: "print(1)" }], "dryrun");
        expect(JSON.parse(Buffer.from(env.VORTEX_SEEDS_B64!, "base64").toString("utf8"))).toEqual([{ label: "S1 seed 1", code: "print(1)" }]);
        expect(env.VORTEX_SEED_MODE).toBe("dryrun");
        expect(env.VORTEX_SEED_RUNNER).toContain("transaction.atomic()");
    });
});
