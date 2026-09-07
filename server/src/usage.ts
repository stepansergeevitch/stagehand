import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { now, type DB, type RunRow, type UsageRow } from "./db.js";
import { ResultEvent, tokensOf } from "./claude/runner.js";

export interface UsageContext {
    accountId: string | null;
    envId: string | null;
    taskId: string | null;
    runId: string | null;
    kind: string;
    stage: string | null;
    at?: string;
}

// Stores what one claude invocation consumed, one row per model it touched.
export const recordUsage = (db: DB, ctx: UsageContext, result: ResultEvent): void => {
    const rows = tokensOf(result);
    if (rows.length === 0) return;
    const insert = db.prepare(
        `INSERT INTO usage (id, at, account_id, env_id, task_id, run_id, kind, stage, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, turns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
        insert.run(randomUUID(), ctx.at ?? now(), ctx.accountId, ctx.envId, ctx.taskId, ctx.runId, ctx.kind, ctx.stage, r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.cost, result.duration_ms ?? null, result.num_turns ?? null);
    }
};

// Runs from before usage tracking existed still have their event logs; read the result event out of each once.
export const backfillUsage = (db: DB, dataDir: string): number => {
    const runsDir = join(dataDir, "runs");
    if (!existsSync(runsDir)) return 0;
    const logged = new Set(readdirSync(runsDir).filter((f) => f.endsWith(".ndjson")).map((f) => f.slice(0, -7)));
    const runs = db
        .prepare(`SELECT r.*, t.env_id FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.status != 'running' AND r.id NOT IN (SELECT run_id FROM usage WHERE run_id IS NOT NULL)`)
        .all() as Array<RunRow & { env_id: string }>;
    let n = 0;
    for (const run of runs) {
        if (!logged.has(run.id)) continue;
        const lines = readFileSync(join(runsDir, `${run.id}.ndjson`), "utf8").split("\n").filter((l) => l.includes('"type":"result"'));
        for (const line of lines.reverse()) {
            let parsed: ReturnType<typeof ResultEvent.safeParse>;
            try {
                parsed = ResultEvent.safeParse(JSON.parse(line));
            } catch {
                continue;
            }
            if (!parsed.success) continue;
            recordUsage(db, { accountId: run.account_id, envId: run.env_id, taskId: run.task_id, runId: run.id, kind: "stage", stage: run.stage, at: run.finished_at ?? run.started_at ?? now() }, parsed.data);
            n++;
            break;
        }
    }
    return n;
};

export interface UsageBucket {
    key: string;
    label: string;
    sub?: string;
    runs: number;
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    turns: number;
    durationMs: number;
}

export interface UsageReport {
    since: string | null;
    totals: Omit<UsageBucket, "key" | "label">;
    byEnv: UsageBucket[];
    byAccount: UsageBucket[];
    byTask: UsageBucket[];
    byStage: UsageBucket[];
    byModel: UsageBucket[];
    byDay: UsageBucket[];
}

const bucketRows = (rows: UsageRow[], keyOf: (r: UsageRow) => string, labelOf: (r: UsageRow) => { label: string; sub?: string }): UsageBucket[] => {
    const m = new Map<string, UsageBucket & { runIds: Set<string> }>();
    for (const r of rows) {
        const key = keyOf(r);
        let b = m.get(key);
        if (!b) {
            const { label, sub } = labelOf(r);
            b = { key, label, ...(sub !== undefined ? { sub } : {}), runs: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, durationMs: 0, runIds: new Set() };
            m.set(key, b);
        }
        b.cost += r.cost_usd;
        b.input += r.input_tokens;
        b.output += r.output_tokens;
        b.cacheRead += r.cache_read_tokens;
        b.cacheWrite += r.cache_write_tokens;
        const runKey = r.run_id ?? r.id;
        if (!b.runIds.has(runKey)) {
            b.runIds.add(runKey);
            b.runs++;
            b.turns += r.turns ?? 0;
            b.durationMs += r.duration_ms ?? 0;
        }
    }
    return [...m.values()]
        .map(({ runIds, ...b }) => {
            void runIds;
            return b;
        })
        .sort((a, b) => b.cost - a.cost);
};

export interface TaskUsageRow {
    key: string;
    at: string;
    stage: string | null;
    kind: string;
    status: string | null;
    attempt: number | null;
    models: string[];
    turns: number | null;
    durationMs: number | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}
export interface TaskUsage {
    rows: TaskUsageRow[];
    totals: { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; turns: number; durationMs: number; runs: number };
    byStage: UsageBucket[];
}

// Everything one task consumed, one row per claude invocation (stage runs by run id, helpers by their usage row), oldest first.
export const taskUsage = (db: DB, taskId: string): TaskUsage => {
    const rows = db.prepare(`SELECT * FROM usage WHERE task_id = ? ORDER BY at`).all(taskId) as UsageRow[];
    const runs = new Map((db.prepare(`SELECT id, stage, status, attempt, started_at FROM runs WHERE task_id = ?`).all(taskId) as Array<{ id: string; stage: string; status: string; attempt: number; started_at: string | null }>).map((r) => [r.id, r]));
    const m = new Map<string, TaskUsageRow>();
    for (const r of rows) {
        const key = r.run_id ?? r.id;
        let row = m.get(key);
        if (!row) {
            const run = r.run_id ? runs.get(r.run_id) : undefined;
            row = { key, at: run?.started_at ?? r.at, stage: r.stage, kind: r.kind, status: run?.status ?? null, attempt: run?.attempt ?? null, models: [], turns: r.turns, durationMs: r.duration_ms, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
            m.set(key, row);
        }
        if (r.model && !row.models.includes(r.model)) row.models.push(r.model);
        row.input += r.input_tokens;
        row.output += r.output_tokens;
        row.cacheRead += r.cache_read_tokens;
        row.cacheWrite += r.cache_write_tokens;
        row.cost += r.cost_usd;
    }
    const list = [...m.values()].sort((a, b) => a.at.localeCompare(b.at));
    const totals = list.reduce(
        (t, r) => ({ cost: t.cost + r.cost, input: t.input + r.input, output: t.output + r.output, cacheRead: t.cacheRead + r.cacheRead, cacheWrite: t.cacheWrite + r.cacheWrite, turns: t.turns + (r.turns ?? 0), durationMs: t.durationMs + (r.durationMs ?? 0), runs: t.runs + 1 }),
        { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, durationMs: 0, runs: 0 },
    );
    return { rows: list, totals, byStage: bucketRows(rows, (r) => r.stage ?? r.kind, (r) => ({ label: r.stage ?? r.kind })) };
};

export const usageReport = (db: DB, since: Date | null): UsageReport => {
    const rows = (since ? db.prepare(`SELECT * FROM usage WHERE at >= ? ORDER BY at`).all(since.toISOString()) : db.prepare(`SELECT * FROM usage ORDER BY at`).all()) as UsageRow[];
    const envs = new Map((db.prepare(`SELECT id, name FROM envs`).all() as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
    const accounts = new Map((db.prepare(`SELECT id, name FROM accounts`).all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    const tasks = new Map((db.prepare(`SELECT id, ticket_id, title, env_id FROM tasks`).all() as Array<{ id: string; ticket_id: string; title: string | null; env_id: string }>).map((t) => [t.id, t]));
    const all = bucketRows(rows, () => "all", () => ({ label: "all" }))[0];
    const totals = all ? (({ key, label, ...rest }) => { void key; void label; return rest; })(all) : { runs: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, durationMs: 0 };
    return {
        since: since?.toISOString() ?? null,
        totals,
        byEnv: bucketRows(rows, (r) => r.env_id ?? "-", (r) => ({ label: r.env_id ? envs.get(r.env_id) ?? "deleted env" : "no environment" })),
        byAccount: bucketRows(rows, (r) => r.account_id ?? "-", (r) => ({ label: r.account_id ? accounts.get(r.account_id) ?? "deleted account" : "unknown account" })),
        byTask: bucketRows(
            rows,
            (r) => r.task_id ?? "-",
            (r) => {
                const t = r.task_id ? tasks.get(r.task_id) : undefined;
                return t ? { label: t.ticket_id, sub: `${envs.get(t.env_id) ?? ""}${t.title ? ` · ${t.title}` : ""}` } : { label: r.task_id ? "deleted task" : "no task" };
            },
        ),
        byStage: bucketRows(rows, (r) => r.stage ?? r.kind, (r) => ({ label: r.stage ?? r.kind })),
        byModel: bucketRows(rows, (r) => r.model ?? "-", (r) => ({ label: r.model ?? "unknown model" })),
        byDay: bucketRows(rows, (r) => r.at.slice(0, 10), (r) => ({ label: r.at.slice(0, 10) })).sort((a, b) => b.key.localeCompare(a.key)),
    };
};
