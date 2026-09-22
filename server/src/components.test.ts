import { describe, expect, it } from "vitest";
import { componentsOf } from "./db.js";

describe("componentsOf", () => {
    it("parses the env's optional components and fills the defaults", () => {
        const env = { components: JSON.stringify([{ key: "worker", command: "celery worker" }, { key: "beat", label: "Scheduler", command: "celery beat", autoStart: true }]) };
        expect(componentsOf(env)).toEqual([
            { key: "worker", label: "worker", command: "celery worker", autoStart: false },
            { key: "beat", label: "Scheduler", command: "celery beat", autoStart: true },
        ]);
    });
    it("drops the core kinds, malformed keys, entries without a command, and unparsable JSON", () => {
        const env = { components: JSON.stringify([{ key: "be", command: "x" }, { key: "Bad Key", command: "x" }, { key: "nocmd" }, { key: "ok", command: "run" }]) };
        expect(componentsOf(env).map((c) => c.key)).toEqual(["ok"]);
        expect(componentsOf({ components: "{not json" })).toEqual([]);
        expect(componentsOf({ components: null })).toEqual([]);
    });
});
