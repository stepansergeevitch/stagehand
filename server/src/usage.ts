import { existsSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { now, type DB, type RunRow, type UsageRow, type WindowCalibrationRow } from "./db.js";
import { RateLimitInfo, ResultEvent, tokensOf } from "./claude/runner.js";

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

// ---------- subscription windows: what a dollar of estimated cost means in "% of the 5-hour / 7-day window" ----------

const MAX_SAMPLES = 20;
// Utilisation comes in whole percents; a sample needs a move well above that noise. Runs accumulate until it is reached.
const MIN_DELTA: Record<string, number> = { five_hour: 0.02, seven_day: 0.03 };

// Every run reports each window's utilisation at its start and end. Per (account, window) an anchor remembers where the
// last measurement started and what has been spent since; once the window moved ≥ MIN_DELTA from the anchor (same reset
// instant) the spend / move ratio becomes a sample of "dollars per full window" and the anchor moves to the current point.
// A reset instant change (the window rolled over) discards the accumulator. Rolling average over the last MAX_SAMPLES.
export const calibrateWindows = (db: DB, accountId: string, first: RateLimitInfo | null, last: RateLimitInfo | null, cost: number | undefined): void => {
    if (!first?.unifiedWindows || !last?.unifiedWindows || !cost || cost <= 0) return;
    const get = db.prepare(`SELECT * FROM window_calibration WHERE account_id = ? AND window = ?`);
    const upsertAnchor = db.prepare(
        `INSERT INTO window_calibration (account_id, window, usd_per_window, samples, anchor_u, anchor_resets, anchor_cost, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, ?)
         ON CONFLICT(account_id, window) DO UPDATE SET anchor_u = excluded.anchor_u, anchor_resets = excluded.anchor_resets, anchor_cost = excluded.anchor_cost, updated_at = excluded.updated_at`,
    );
    const sample = db.prepare(
        `UPDATE window_calibration SET usd_per_window = (usd_per_window * samples + ?) / (samples + 1), samples = MIN(samples + 1, ${MAX_SAMPLES}), anchor_u = ?, anchor_resets = ?, anchor_cost = 0, updated_at = ? WHERE account_id = ? AND window = ?`,
    );
    for (const [name, w1] of Object.entries(last.unifiedWindows)) {
        const w0 = first.unifiedWindows[name];
        if (!w0) continue;
        const row = get.get(accountId, name) as WindowCalibrationRow | undefined;
        // Start (or restart after a rollover) from where this run began; this run's own cost counts from there.
        const anchored = row && row.anchor_u !== null && row.anchor_resets === w1.resetsAt && w0.resetsAt === w1.resetsAt;
        const anchorU = anchored ? row.anchor_u! : w0.resetsAt === w1.resetsAt ? w0.utilization : null;
        if (anchorU === null) {
            upsertAnchor.run(accountId, name, w1.utilization, w1.resetsAt, 0, now());
            continue;
        }
        const spent = (anchored ? row.anchor_cost : 0) + cost;
        const delta = w1.utilization - anchorU;
        if (delta >= (MIN_DELTA[name] ?? 0.02)) {
            if (!row) upsertAnchor.run(accountId, name, anchorU, w1.resetsAt, 0, now());
            sample.run(spent / delta, w1.utilization, w1.resetsAt, now(), accountId, name);
        } else upsertAnchor.run(accountId, name, anchorU, w1.resetsAt, spent, now());
    }
};

// Learns from runs that predate calibration: every event log holds the rate-limit snapshots and the result event.
export const backfillCalibration = (db: DB, dataDir: string): number => {
    const have = db.prepare(`SELECT COUNT(*) AS n FROM window_calibration`).get() as { n: number };
    if (have.n > 0) return 0;
    const runsDir = join(dataDir, "runs");
    if (!existsSync(runsDir)) return 0;
    const runs = db.prepare(`SELECT id, account_id FROM runs WHERE status != 'running' ORDER BY started_at`).all() as Array<{ id: string; account_id: string }>;
    let n = 0;
    for (const run of runs) {
        const p = join(runsDir, `${run.id}.ndjson`);
        if (!existsSync(p)) continue;
        let first: RateLimitInfo | null = null;
        let last: RateLimitInfo | null = null;
        let cost: number | undefined;
        for (const line of readFileSync(p, "utf8").split("\n")) {
            if (line.includes('"rate_limit_event"')) {
                try {
                    const parsed = RateLimitInfo.safeParse((JSON.parse(line) as { rate_limit_info?: unknown }).rate_limit_info);
                    if (parsed.success) {
                        last = parsed.data;
                        first ??= parsed.data;
                    }
                } catch {
                    /* skip */
                }
            } else if (line.includes('"type":"result"')) {
                try {
                    const parsed = ResultEvent.safeParse(JSON.parse(line));
                    if (parsed.success) cost = parsed.data.total_cost_usd;
                } catch {
                    /* skip */
                }
            }
        }
        if (first && last && cost) {
            calibrateWindows(db, run.account_id, first, last, cost);
            n++;
        }
    }
    return n;
};

export interface WindowShare {
    accountId: string;
    accountName: string;
    window: string;
    usdPerWindow: number;
    samples: number;
}

// Calibration for every subscription account that has one (enterprise accounts have no windows to share).
export const windowShares = (db: DB): WindowShare[] => {
    const rows = db.prepare(`SELECT c.*, a.name AS account_name, a.plan FROM window_calibration c JOIN accounts a ON a.id = c.account_id WHERE c.samples > 0`).all() as Array<WindowCalibrationRow & { account_name: string; plan: string | null }>;
    return rows.filter((r) => r.plan !== "enterprise").map((r) => ({ accountId: r.account_id, accountName: r.account_name, window: r.window, usdPerWindow: r.usd_per_window, samples: r.samples }));
};

// Cost → fraction of the named window for that account (null when nothing is known yet).
export const shareOf = (shares: WindowShare[], accountId: string | null, window: string, cost: number): number | null => {
    const s = accountId ? shares.find((x) => x.accountId === accountId && x.window === window) : undefined;
    return s && s.usdPerWindow > 0 ? cost / s.usdPerWindow : null;
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
    // Subscription accounts: this bucket's cost as a fraction of the account's 5-hour / 7-day window (calibrated from runs).
    fiveHour?: number | null;
    sevenDay?: number | null;
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
    shares: WindowShare[];
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
    accountId: string | null;
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
    // Per subscription account this task ran on: its cost there as a fraction of that account's windows.
    byAccount: Array<{ accountId: string; accountName: string; cost: number; fiveHour: number | null; sevenDay: number | null }>;
    shares: WindowShare[];
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
            row = { key, accountId: r.account_id, at: run?.started_at ?? r.at, stage: r.stage, kind: r.kind, status: run?.status ?? null, attempt: run?.attempt ?? null, models: [], turns: r.turns, durationMs: r.duration_ms, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
    const shares = windowShares(db);
    const accounts = new Map((db.prepare(`SELECT id, name FROM accounts`).all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    const byAccount = bucketRows(rows, (r) => r.account_id ?? "-", (r) => ({ label: r.account_id ? accounts.get(r.account_id) ?? "deleted account" : "unknown account" }))
        .filter((b) => b.key !== "-")
        .map((b) => ({ accountId: b.key, accountName: b.label, cost: b.cost, fiveHour: shareOf(shares, b.key, "five_hour", b.cost), sevenDay: shareOf(shares, b.key, "seven_day", b.cost) }));
    return { rows: list, totals, byStage: bucketRows(rows, (r) => r.stage ?? r.kind, (r) => ({ label: r.stage ?? r.kind })), byAccount, shares };
};

export const usageReport = (db: DB, since: Date | null): UsageReport => {
    const rows = (since ? db.prepare(`SELECT * FROM usage WHERE at >= ? ORDER BY at`).all(since.toISOString()) : db.prepare(`SELECT * FROM usage ORDER BY at`).all()) as UsageRow[];
    const envs = new Map((db.prepare(`SELECT id, name FROM envs`).all() as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
    const accounts = new Map((db.prepare(`SELECT id, name FROM accounts`).all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    const tasks = new Map((db.prepare(`SELECT id, ticket_id, title, env_id FROM tasks`).all() as Array<{ id: string; ticket_id: string; title: string | null; env_id: string }>).map((t) => [t.id, t]));
    const shares = windowShares(db);
    const all = bucketRows(rows, () => "all", () => ({ label: "all" }))[0];
    const totals = all ? (({ key, label, ...rest }) => { void key; void label; return rest; })(all) : { runs: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, durationMs: 0 };
    return {
        since: since?.toISOString() ?? null,
        totals,
        byEnv: bucketRows(rows, (r) => r.env_id ?? "-", (r) => ({ label: r.env_id ? envs.get(r.env_id) ?? "deleted env" : "no environment" })),
        byAccount: bucketRows(rows, (r) => r.account_id ?? "-", (r) => ({ label: r.account_id ? accounts.get(r.account_id) ?? "deleted account" : "unknown account" })).map((b) => ({
            ...b,
            fiveHour: shareOf(shares, b.key, "five_hour", b.cost),
            sevenDay: shareOf(shares, b.key, "seven_day", b.cost),
        })),
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
        shares,
    };
};
