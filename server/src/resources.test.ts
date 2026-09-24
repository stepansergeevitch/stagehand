import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { DB, EnvRow, TaskRow } from "./db.js";
import { DEFAULT_POLICIES, Resources, type Resource, type ResourceHooks } from "./resources.js";

// judge() reads nothing from the db or the hooks; a bare instance is enough.
const hooks: ResourceHooks = { clones: () => [], stopService: async () => undefined, stopDependency: async () => undefined, stopBrowser: async () => undefined, releaseClone: async () => undefined, notice: () => undefined };
const res = new Resources({} as DB, { resources: DEFAULT_POLICIES } as unknown as Config, hooks);

const task = (over: Partial<TaskRow>): TaskRow => ({ id: "t1", ticket_id: "INV-1", stage: "user_review", status: "waiting_user", env_id: "e1", updated_at: new Date(Date.now() - 45 * 60_000).toISOString(), created_at: "2026-09-24T00:00:00Z", worktree_path: null, ...over }) as TaskRow;
const base = (over: Partial<Resource>): Resource => ({
    id: "service:s1", kind: "service", label: "FE :13001", owner: { type: "task", id: "t1", name: "INV-1", stage: "user_review", status: "waiting_user" }, tmux: "sh-inv-1-fe", pid: 1, port: 13001, path: null,
    rssMb: 4000, cpuPct: 0, procs: 3, top: "next-server", startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), ageMs: 2 * 3_600_000, idleMs: 45 * 60_000, diskMb: null, pinned: false, policy: { verdict: "keep", reason: "", dueAt: null },
    ...over,
});
const ok = { pressure: "ok" as const };
const critical = { pressure: "critical" as const };
const tasks = (t: TaskRow) => new Map([[t.id, t]]);
const envs = new Map<string, EnvRow>();

describe("resource policy", () => {
    it("a parked task's dev server stops after the idle grace; a running one is kept", () => {
        const parked = task({});
        const v = res.judge(base({}), tasks(parked), envs, ok, DEFAULT_POLICIES);
        expect(v.verdict).toBe("stop");
        expect(v.reason).toContain("parked");
        // updated 45 min ago, grace 30 min → already due
        expect(Date.parse(v.dueAt!)).toBeLessThanOrEqual(Date.now());
        const running = task({ status: "running", stage: "manual_qa" });
        expect(res.judge(base({}), tasks(running), envs, ok, DEFAULT_POLICIES)).toEqual({ verdict: "keep", reason: "task runs a browser stage", dueAt: null });
    });

    it("past QA (PR stages, done) the grace is the short one; pressure removes it", () => {
        const pr = task({ stage: "pr_waiting", status: "idle", updated_at: new Date(Date.now() - 2 * 60_000).toISOString() });
        const v = res.judge(base({}), tasks(pr), envs, ok, DEFAULT_POLICIES);
        expect(v.verdict).toBe("stop");
        expect(Date.parse(v.dueAt!)).toBeGreaterThan(Date.now()); // 5 min grace, 2 min in
        const under = res.judge(base({}), tasks(pr), envs, critical, DEFAULT_POLICIES);
        expect(Date.parse(under.dueAt!)).toBeLessThanOrEqual(Date.now());
        expect(under.reason).toContain("memory pressure");
    });

    it("a fresh start settles even under pressure; after the settle period the parked rule applies", () => {
        const parked = task({ updated_at: new Date().toISOString() });
        const fresh = base({ startedAt: new Date(Date.now() - 3 * 60_000).toISOString(), ageMs: 3 * 60_000, idleMs: 0 });
        const v = res.judge(fresh, tasks(parked), envs, critical, DEFAULT_POLICIES);
        expect(v.verdict).toBe("keep");
        expect(v.reason).toContain("settling in");
        const older = base({ startedAt: new Date(Date.now() - 25 * 60_000).toISOString(), ageMs: 25 * 60_000, idleMs: 25 * 60_000 });
        expect(res.judge(older, tasks(parked), envs, critical, DEFAULT_POLICIES).verdict).toBe("stop");
        expect(res.judge(base({ pinned: true, ageMs: 3 * 3_600_000 }), tasks(parked), envs, critical, DEFAULT_POLICIES).reason).toContain("started by you");
    });

    it("pinned wins, disabled policies keep everything, a deleted task's service stops at once", () => {
        expect(res.judge(base({ pinned: true }), tasks(task({})), envs, critical, DEFAULT_POLICIES).verdict).toBe("keep");
        expect(res.judge(base({}), tasks(task({})), envs, ok, { ...DEFAULT_POLICIES, enabled: false }).reason).toBe("automatic cleanup is off");
        const v = res.judge(base({}), new Map(), envs, ok, DEFAULT_POLICIES);
        expect(v.verdict).toBe("stop");
        expect(v.reason).toContain("no longer exists");
    });

    it("runs and worktrees are never stopped; orphans wait the orphan grace; terminals by idle", () => {
        expect(res.judge(base({ kind: "run", label: "claude · code review" }), tasks(task({})), envs, critical, DEFAULT_POLICIES).verdict).toBe("keep");
        expect(res.judge(base({ kind: "worktree" }), tasks(task({})), envs, critical, DEFAULT_POLICIES).verdict).toBe("keep");
        const young = res.judge(base({ kind: "orphan", owner: { type: "none", id: null, name: null }, ageMs: 60_000 }), new Map(), envs, ok, DEFAULT_POLICIES);
        expect(young.verdict).toBe("stop");
        expect(Date.parse(young.dueAt!)).toBeGreaterThan(Date.now());
        const term = res.judge(base({ kind: "terminal", idleMs: 7 * 3_600_000 }), tasks(task({})), envs, ok, DEFAULT_POLICIES);
        expect(term.verdict).toBe("stop");
        expect(Date.parse(term.dueAt!)).toBeLessThanOrEqual(Date.now());
        const fresh = res.judge(base({ kind: "terminal", idleMs: 10 * 60_000 }), tasks(task({})), envs, ok, DEFAULT_POLICIES);
        expect(Date.parse(fresh.dueAt!)).toBeGreaterThan(Date.now());
    });

    it("a QA browser without a run stops after 2 min; with its run in progress it is kept", () => {
        const t = task({ status: "running", stage: "qa_baseline" });
        expect(res.judge(base({ kind: "browser", owner: { type: "task", id: "t1", name: "INV-1", status: "running" } }), tasks(t), envs, ok, DEFAULT_POLICIES).verdict).toBe("keep");
        const v = res.judge(base({ kind: "browser", owner: { type: "task", id: "t1", name: "INV-1", status: "no run · waiting_user" }, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }), tasks(task({})), envs, ok, DEFAULT_POLICIES);
        expect(v.verdict).toBe("stop");
        expect(Date.parse(v.dueAt!)).toBeLessThanOrEqual(Date.now());
    });
});
