import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { env, userDataDir, withLegacyEnv } from "./home.js";

describe("legacy names", () => {
    afterEach(() => {
        delete process.env["VORTEX_X_TEST"];
        delete process.env["STAGEHAND_X_TEST"];
    });

    it("reads VORTEX_* first, then STAGEHAND_*", () => {
        expect(env("VORTEX_X_TEST")).toBeUndefined();
        process.env["STAGEHAND_X_TEST"] = "old";
        expect(env("VORTEX_X_TEST")).toBe("old");
        process.env["VORTEX_X_TEST"] = "new";
        expect(env("VORTEX_X_TEST")).toBe("new");
    });

    it("hands commands both names", () => {
        expect(withLegacyEnv({ VORTEX_TASK_DB: "a", PORT: "1" })).toEqual({ VORTEX_TASK_DB: "a", STAGEHAND_TASK_DB: "a", PORT: "1" });
    });

    it("uses ~/.stagehand in place only when ~/.vortex is absent", () => {
        const home = mkdtempSync(join(tmpdir(), "vortex-home-"));
        expect(userDataDir(home)).toBe(join(home, ".vortex"));
        mkdirSync(join(home, ".stagehand"));
        expect(userDataDir(home)).toBe(join(home, ".stagehand"));
        mkdirSync(join(home, ".vortex"));
        expect(userDataDir(home)).toBe(join(home, ".vortex"));
    });
});
