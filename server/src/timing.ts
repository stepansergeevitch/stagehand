import type { DB, RunRow, TaskEventRow, UsageRow } from "./db.js";

// Time, the way Analytics does cost: how long the agents ran per stage / operation / task / day, and how long each
// task spent working, waiting for the human, waiting for GitHub or rate-limited (from task_events, recorded since
// the events table exists — older tasks show run time and lead time only).

export interface TimingBucket {
    key: string;
    label: string;
    sub?: string;
    runs: number;
    totalMs: number;
    avgMs: number;
    medianMs: number;
    p90Ms: number;
    maxMs: number;
}

export interface TaskTiming {
    key: string;
    label: string;
    sub?: string;
    done: boolean;
    status: string | null;
    stage: string | null;
    createdAt: string | null;
    // Creation → done (or now): the calendar time the task took.
    leadMs: number;
    // Wall time of the task's agent runs (stage runs).
    agentMs: number;
    runs: number;
    // From task_events, inside the period: how long the task sat in each kind of state.
    workingMs: number;
    waitingHumanMs: number;
    waitingGithubMs: number;
    rateLimitedMs: number;
    // Per stage (events), for the task's own breakdown.
    stagesMs: Record<string, number>;
    tracked: boolean;
}

export interface TimingReport {
    since: string | null;
    totals: {
        runs: number;
        agentMs: number;
        operationsMs: number;
        tasks: number;
        doneTasks: number;
        avgLeadMs: number;
        medianLeadMs: number;
        workingMs: number;
        waitingHumanMs: number;
        waitingGithubMs: number;
        rateLimitedMs: number;
    };
    byStage: TimingBucket[];
    byOperation: TimingBucket[];
    byStageState: TimingBucket[];
    byTask: TaskTiming[];
    byDay: TimingBucket[];
}

const POLL_STAGES = new Set(["pr_waiting", "pr_green", "pr_approved"]);
type StateKind = "working" | "waiting_human" | "waiting_github" | "rate_limited" | "done" | "other";

// What a (stage, status) pair means for the human: the agents work, the human is needed, GitHub is awaited, or a window resets.
export const stateKind = (stage: string, status: string): StateKind => {
    if (status === "done") return "done";
    if (status === "running" || status === "queued") return "working";
    if (status === "waiting_user" || status === "blocked" || status === "failed" || status === "stopped") return "waiting_human";
    if (status === "rate_limited") return "rate_limited";
    if (status === "idle") return POLL_STAGES.has(stage) ? "waiting_github" : "other";
    return "other";
};

const quantile = (sorted: number[], q: number): number => {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

const bucket = (key: string, label: string, sub: string | undefined, samples: number[]): TimingBucket => {
    const sorted = [...samples].sort((a, b) => a - b);
    const total = sorted.reduce((a, b) => a + b, 0);
    return { key, label, ...(sub !== undefined ? { sub } : {}), runs: sorted.length, totalMs: total, avgMs: sorted.length ? total / sorted.length : 0, medianMs: quantile(sorted, 0.5), p90Ms: quantile(sorted, 0.9), maxMs: sorted[sorted.length - 1] ?? 0 };
};

const bucketBy = <T>(items: T[], keyOf: (x: T) => string, labelOf: (x: T) => { label: string; sub?: string }, msOf: (x: T) => number): TimingBucket[] => {
    const m = new Map<string, { label: string; sub?: string; samples: number[] }>();
    for (const it of items) {
        const key = keyOf(it);
        let b = m.get(key);
        if (!b) {
            const { label, sub } = labelOf(it);
            b = { label, ...(sub !== undefined ? { sub } : {}), samples: [] };
            m.set(key, b);
        }
        b.samples.push(msOf(it));
    }
    return [...m.entries()].map(([key, b]) => bucket(key, b.label, b.sub, b.samples)).sort((a, b) => b.totalMs - a.totalMs);
};

// Time each task spent per state kind and per stage, from its events, clipped to [since, until].
const intervals = (events: TaskEventRow[], sinceMs: number, untilMs: number, doneAtMs: number | null): { byKind: Record<StateKind, number>; byStage: Record<string, number>; byStageState: Array<{ stage: string; kind: StateKind; ms: number }> } => {
    const byKind: Record<StateKind, number> = { working: 0, waiting_human: 0, waiting_github: 0, rate_limited: 0, done: 0, other: 0 };
    const byStage: Record<string, number> = {};
    const byStageState: Array<{ stage: string; kind: StateKind; ms: number }> = [];
    const end = doneAtMs ?? untilMs;
    for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        const start = Math.max(new Date(e.at).getTime(), sinceMs);
        const next = i + 1 < events.length ? new Date(events[i + 1]!.at).getTime() : end;
        const stop = Math.min(next, end, untilMs);
        if (stop <= start) continue;
        const kind = stateKind(e.stage, e.status);
        if (kind === "done") continue;
        const ms = stop - start;
        byKind[kind] += ms;
        byStage[e.stage] = (byStage[e.stage] ?? 0) + ms;
        byStageState.push({ stage: e.stage, kind, ms });
    }
    return { byKind, byStage, byStageState };
};

export const timingReport = (db: DB, since: Date | null): TimingReport => {
    const sinceIso = since?.toISOString() ?? null;
    const sinceMs = since?.getTime() ?? 0;
    const nowMs = Date.now();
    const runs = (sinceIso ? db.prepare(`SELECT * FROM runs WHERE started_at >= ? AND finished_at IS NOT NULL ORDER BY started_at`).all(sinceIso) : db.prepare(`SELECT * FROM runs WHERE finished_at IS NOT NULL ORDER BY started_at`).all()) as RunRow[];
    const runMs = (r: RunRow): number => Math.max(0, new Date(r.finished_at!).getTime() - new Date(r.started_at ?? r.finished_at!).getTime());
    const ops = (sinceIso ? db.prepare(`SELECT * FROM usage WHERE at >= ? AND kind != 'stage' AND duration_ms IS NOT NULL ORDER BY at`).all(sinceIso) : db.prepare(`SELECT * FROM usage WHERE kind != 'stage' AND duration_ms IS NOT NULL ORDER BY at`).all()) as UsageRow[];
    // One sample per invocation (a run's usage has one row per model).
    const seenOps = new Set<string>();
    const opRows = ops.filter((u) => {
        const k = u.run_id ?? u.id;
        if (seenOps.has(k)) return false;
        seenOps.add(k);
        return true;
    });
    const tasks = db.prepare(`SELECT id, ticket_id, title, env_id, stage, status, created_at, updated_at FROM tasks`).all() as Array<{ id: string; ticket_id: string; title: string | null; env_id: string; stage: string; status: string; created_at: string; updated_at: string }>;
    const envs = new Map((db.prepare(`SELECT id, name FROM envs`).all() as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
    const events = db.prepare(`SELECT * FROM task_events ORDER BY task_id, at`).all() as TaskEventRow[];
    const eventsByTask = new Map<string, TaskEventRow[]>();
    for (const e of events) eventsByTask.set(e.task_id, [...(eventsByTask.get(e.task_id) ?? []), e]);
    const runsByTask = new Map<string, RunRow[]>();
    for (const r of runs) runsByTask.set(r.task_id, [...(runsByTask.get(r.task_id) ?? []), r]);

    // Tasks that touched the period: a run, an event, or (no period) any task.
    const active = new Set<string>([...runsByTask.keys(), ...events.filter((e) => new Date(e.at).getTime() >= sinceMs).map((e) => e.task_id)]);
    const byTask: TaskTiming[] = [];
    const stageStateSamples: Array<{ stage: string; kind: StateKind; ms: number }> = [];
    for (const t of tasks) {
        if (since && !active.has(t.id) && new Date(t.created_at).getTime() < sinceMs) continue;
        const ev = eventsByTask.get(t.id) ?? [];
        const doneEv = ev.find((e) => e.status === "done");
        const doneAtMs = t.status === "done" ? new Date(doneEv?.at ?? t.updated_at).getTime() : null;
        const iv = intervals(ev, sinceMs, nowMs, doneAtMs);
        const own = runsByTask.get(t.id) ?? [];
        stageStateSamples.push(...iv.byStageState);
        byTask.push({
            key: t.id,
            label: t.ticket_id,
            sub: `${envs.get(t.env_id) ?? ""}${t.title ? ` · ${t.title}` : ""}`,
            done: t.status === "done",
            status: t.status,
            stage: t.stage,
            createdAt: t.created_at,
            leadMs: Math.max(0, (doneAtMs ?? nowMs) - new Date(t.created_at).getTime()),
            agentMs: own.reduce((a, r) => a + runMs(r), 0),
            runs: own.length,
            workingMs: iv.byKind.working,
            waitingHumanMs: iv.byKind.waiting_human,
            waitingGithubMs: iv.byKind.waiting_github,
            rateLimitedMs: iv.byKind.rate_limited,
            stagesMs: iv.byStage,
            tracked: ev.length > 0,
        });
    }
    // Deleted tasks still have runs and events: they show by ticket id.
    const known = new Set(tasks.map((t) => t.id));
    for (const [taskId, own] of runsByTask) {
        if (known.has(taskId)) continue;
        const ev = eventsByTask.get(taskId) ?? [];
        const iv = intervals(ev, sinceMs, nowMs, ev.find((e) => e.status === "done") ? new Date(ev.find((e) => e.status === "done")!.at).getTime() : null);
        byTask.push({ key: taskId, label: ev[0]?.ticket_id ?? "deleted task", sub: "deleted", done: false, status: null, stage: null, createdAt: null, leadMs: 0, agentMs: own.reduce((a, r) => a + runMs(r), 0), runs: own.length, workingMs: iv.byKind.working, waitingHumanMs: iv.byKind.waiting_human, waitingGithubMs: iv.byKind.waiting_github, rateLimitedMs: iv.byKind.rate_limited, stagesMs: iv.byStage, tracked: ev.length > 0 });
    }
    byTask.sort((a, b) => b.leadMs - a.leadMs);
    const doneTasks = byTask.filter((t) => t.done);
    const leads = doneTasks.map((t) => t.leadMs).sort((a, b) => a - b);
    const sum = (f: (t: TaskTiming) => number): number => byTask.reduce((a, t) => a + f(t), 0);
    const agentMs = runs.reduce((a, r) => a + runMs(r), 0);
    return {
        since: sinceIso,
        totals: {
            runs: runs.length,
            agentMs,
            operationsMs: opRows.reduce((a, u) => a + (u.duration_ms ?? 0), 0),
            tasks: byTask.length,
            doneTasks: doneTasks.length,
            avgLeadMs: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : 0,
            medianLeadMs: quantile(leads, 0.5),
            workingMs: sum((t) => t.workingMs),
            waitingHumanMs: sum((t) => t.waitingHumanMs),
            waitingGithubMs: sum((t) => t.waitingGithubMs),
            rateLimitedMs: sum((t) => t.rateLimitedMs),
        },
        byStage: bucketBy(runs, (r) => r.stage, (r) => ({ label: r.stage }), runMs),
        byOperation: bucketBy(opRows, (u) => u.kind, (u) => ({ label: u.kind }), (u) => u.duration_ms ?? 0),
        byTask,
        byStageState: bucketBy(stageStateSamples, (s) => `${s.stage}:${s.kind}`, (s) => ({ label: s.stage, sub: s.kind }), (s) => s.ms),
        byDay: bucketBy(runs, (r) => (r.started_at ?? r.finished_at!).slice(0, 10), (r) => ({ label: (r.started_at ?? r.finished_at!).slice(0, 10) }), runMs).sort((a, b) => b.key.localeCompare(a.key)),
    };
};
