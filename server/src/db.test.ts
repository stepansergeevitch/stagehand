import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";

// A database made by an older Stagehand: runs and usage still declare account_id as a foreign key to accounts (and
// runs lacks the columns later migrations add). Rows are inserted with foreign keys off, as the old rows exist today.
const oldDatabase = (dir: string): void => {
    const raw = new Database(join(dir, "stagehand.sqlite"));
    raw.pragma("foreign_keys = OFF");
    raw.exec(`CREATE TABLE runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), stage TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), pid INTEGER, started_at TEXT, finished_at TEXT, resume_at TEXT, error TEXT,
        result_json TEXT, cost_usd REAL, num_turns INTEGER, last_event TEXT, attempt INTEGER NOT NULL DEFAULT 1)`);
    raw.exec(`CREATE INDEX runs_task ON runs(task_id, started_at)`);
    raw.exec(`CREATE TABLE usage (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, account_id TEXT REFERENCES accounts(id), env_id TEXT, task_id TEXT, run_id TEXT, kind TEXT NOT NULL,
        stage TEXT, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER, turns INTEGER)`);
    raw.exec(`INSERT INTO runs (id, task_id, stage, kind, status, account_id, started_at, finished_at, cost_usd, attempt) VALUES ('r1', 't1', 'implement', 'stage', 'done', 'a1', '2026-09-01T00:00:00Z', '2026-09-01T00:10:00Z', 1.25, 2)`);
    raw.exec(`INSERT INTO usage (id, at, account_id, task_id, run_id, kind, cost_usd) VALUES ('u1', '2026-09-01T00:10:00Z', 'a1', 't1', 'r1', 'stage', 1.25)`);
    raw.close();
};

const fks = (db: Database.Database, table: string): string[] => (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>).map((f) => f.table);

describe("openDb", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it("rebuilds runs and usage without the foreign key to accounts, keeping their rows and indexes", () => {
        const dir = mkdtempSync(join(tmpdir(), "stagehand-db-"));
        dirs.push(dir);
        oldDatabase(dir);
        const db = openDb(dir);
        expect(fks(db, "runs")).toEqual(["tasks"]);
        expect(fks(db, "usage")).toEqual([]);
        expect(db.prepare(`SELECT id, task_id, account_id, cost_usd, attempt, model FROM runs`).all()).toEqual([{ id: "r1", task_id: "t1", account_id: "a1", cost_usd: 1.25, attempt: 2, model: null }]);
        expect(db.prepare(`SELECT id, account_id, run_id, ticket_id FROM usage`).all()).toEqual([{ id: "u1", account_id: "a1", run_id: "r1", ticket_id: null }]);
        const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('runs_task', 'usage_at', 'usage_run')`).all() as Array<{ name: string }>).map((i) => i.name).sort();
        expect(indexes).toEqual(["runs_task", "usage_at", "usage_run"]);
        // The second open finds nothing to rebuild.
        db.close();
        const again = openDb(dir);
        expect(again.prepare(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 1 });
        again.close();
    });

    it("lets an account with run and usage history be deleted", () => {
        const dir = mkdtempSync(join(tmpdir(), "stagehand-db-"));
        dirs.push(dir);
        const db = openDb(dir);
        db.prepare(`INSERT INTO accounts (id, name, auth_dir, created_at) VALUES ('a1', 'old', '/tmp/old', '2026-09-01T00:00:00Z')`).run();
        db.prepare(`INSERT INTO envs (id, name, path, base_branch, created_at) VALUES ('e1', 'env', '/tmp/env', 'main', '2026-09-01T00:00:00Z')`).run();
        db.prepare(`INSERT INTO tasks (id, env_id, ticket_id, session_id, stage, status, created_at, updated_at) VALUES ('t1', 'e1', 'X-1', 's1', 'done', 'idle', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
        db.prepare(`INSERT INTO runs (id, task_id, stage, kind, status, account_id) VALUES ('r1', 't1', 'implement', 'stage', 'done', 'a1')`).run();
        db.prepare(`INSERT INTO usage (id, at, account_id, run_id, kind) VALUES ('u1', '2026-09-01T00:10:00Z', 'a1', 'r1', 'stage')`).run();
        expect(() => db.prepare(`DELETE FROM accounts WHERE id = 'a1'`).run()).not.toThrow();
        expect(db.prepare(`SELECT account_id FROM runs`).all()).toEqual([{ account_id: "a1" }]);
        expect(db.prepare(`SELECT account_id FROM usage`).all()).toEqual([{ account_id: "a1" }]);
        db.close();
    });
});
