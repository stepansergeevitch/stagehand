import { describe, expect, it } from "vitest";
import { assertDbHosts, parseDbTargets } from "./db-hosts.js";
import type { EnvRow } from "./db.js";
import { namesTemplate, parseDbList, taskDbActive, taskDbName, taskDbOf } from "./task-db.js";

const cfg = (over: Record<string, unknown> = {}) => ({ enabled: true, template: "app", create: "c", drop: "d", connect: "x", list: "", ...over });

describe("task databases", () => {
    it("reads the env's config and knows when it is complete", () => {
        expect(taskDbOf({ task_db: null })).toBeNull();
        expect(taskDbOf({ task_db: "not json" })).toBeNull();
        const c = taskDbOf({ task_db: JSON.stringify(cfg()) });
        expect(c?.sharedNames).toEqual([]);
        expect(taskDbActive(c)).toBe(true);
        expect(taskDbActive(taskDbOf({ task_db: JSON.stringify(cfg({ enabled: false })) }))).toBe(false);
        expect(taskDbActive(taskDbOf({ task_db: JSON.stringify(cfg({ connect: "  " })) }))).toBe(false);
    });
    it("names a task's database from the pattern, safe and at most 63 characters", () => {
        expect(taskDbName({ template: "app", namePattern: "" }, "INV-149")).toBe("app_inv_149");
        expect(taskDbName({ template: "app", namePattern: "t_{{slug}}" }, "ENG 12/x")).toBe("t_eng_12_x");
        const long = taskDbName({ template: "a".repeat(40), namePattern: "" }, "B".repeat(40));
        expect(long.length).toBeLessThanOrEqual(63);
        expect(long).not.toBe(taskDbName({ template: "a".repeat(40), namePattern: "" }, `${"B".repeat(39)}C`));
    });
    it("parses the list command's output with or without sizes", () => {
        expect(parseDbList("app 25000\napp_inv_1|12\n\napp_inv_2\n")).toEqual([
            { name: "app", sizeMb: 25000 },
            { name: "app_inv_1", sizeMb: 12 },
            { name: "app_inv_2", sizeMb: null },
        ]);
    });
    it("finds QA steps that address the template by name, not ones that merely mention it", () => {
        expect(namesTemplate(`psql -h localhost -U app -d app -c "select 1"`, "app")).toBe(true);
        expect(namesTemplate(`psql postgresql://u@localhost:5432/app -c x`, "app")).toBe(true);
        expect(namesTemplate(`psql --dbname=app`, "app")).toBe(true);
        expect(namesTemplate(`psql -U app -d "$STAGEHAND_TASK_DB"`, "app")).toBe(false);
        expect(namesTemplate(`psql -d app_test_x`, "app")).toBe(false);
        expect(namesTemplate(`open the app and click Save`, "app")).toBe(false);
    });
});

describe("DB guard with task databases", () => {
    const env = (cmd: string): EnvRow => ({ id: `e${Math.random()}`, path: "/tmp", env_vars: null, db_hosts_command: cmd, allowed_db_hosts: null }) as unknown as EnvRow;
    it("reads host/name pairs", () => {
        expect(parseDbTargets("default=localhost:5432/app_inv_1 migrations=localhost/migrations x=[::1]:5432/y other=localhost")).toEqual([
            { host: "localhost", name: "app_inv_1" },
            { host: "localhost", name: "migrations" },
            { host: "::1", name: "y" },
            { host: "localhost", name: null },
        ]);
    });
    it("passes a worktree on its own database and the shared ones", async () => {
        await expect(assertDbHosts(env("echo default=localhost/app_inv_1 m=localhost/migrations"), "/tmp", ["app_inv_1", "migrations"])).resolves.toBeUndefined();
    });
    it("blocks a worktree pointing at the template or another task's database", async () => {
        await expect(assertDbHosts(env("echo default=localhost/app"), "/tmp", ["app_inv_1"])).rejects.toThrow(/would use database app, not its own \(app_inv_1\)/);
    });
    it("blocks when the check prints no database names", async () => {
        await expect(assertDbHosts(env("echo default=localhost"), "/tmp", ["app_inv_1"])).rejects.toThrow(/prints no database names/);
    });
    it("checks hosts only for a task not on its own database", async () => {
        await expect(assertDbHosts(env("echo default=localhost"), "/tmp")).resolves.toBeUndefined();
    });
});
