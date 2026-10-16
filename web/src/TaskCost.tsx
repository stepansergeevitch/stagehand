import { useEffect, useState } from "react";
import { api, pct, STAGE_LABEL, windowPct, type Stage, type TaskUsage } from "./api";
import { hours, money, tokens } from "./Analytics";
import { Button, Chip, EmptyState, Notice, Skeleton } from "@vortex/ds";
import { DataTable, type DataColumn } from "./components/DataTable";
import { Panel } from "./components/Panel";
import { StatRow, StatTile } from "./components/StatTile";
import "./tasks/workspace.css";

// Cost part of a task's Details: what every claude invocation for this task consumed, in order, plus totals and a per-stage split.
const when = (iso: string): string => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const stageLabel = (s: string | null, kind: string): string => (s ? (STAGE_LABEL[s as Stage] ?? s) : kind === "qa-login" ? "QA login helper" : kind === "ticket-fetch" ? "Ticket fetch" : kind);

type Row = TaskUsage["rows"][number];
type StageRow = TaskUsage["byStage"][number];

export const TaskCost = ({ taskId, refreshKey }: { taskId: string; refreshKey: string }) => {
    const [data, setData] = useState<TaskUsage | null>(null);
    const [session, setSession] = useState<{ sessionId: string; transcriptMb: number | null; maxMb: number } | null>(null);
    const [rotating, setRotating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        void api.taskUsage(taskId).then(setData).catch((e: Error) => setError(e.message));
        void api.taskSession(taskId).then(setSession).catch(() => setSession(null));
    }, [taskId, refreshKey]);
    const rotate = async () => {
        if (!confirm("Start a fresh task session? The agent loses the conversation so far (design.md, impl.json, review.json and the chat stay), and the next resumed run stops paying for the whole transcript.")) return;
        setRotating(true);
        try {
            await api.rotateSession(taskId);
            setSession(await api.taskSession(taskId));
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setRotating(false);
        }
    };
    if (error) return <Notice tone="bad">{error}</Notice>;
    if (!data) return <Skeleton height={96} />;
    const t = data.totals;
    const share = (cost: number): number => (t.cost > 0 ? Math.round((cost / t.cost) * 100) : 0);
    const shareCell = (cost: number) => (
        <span className="cost-share"><i style={{ width: `${Math.max(2, share(cost) * 0.6)}px` }} />{share(cost)}%</span>
    );
    const transcriptTone = session && session.transcriptMb != null && session.maxMb > 0 ? (session.transcriptMb > session.maxMb ? "bad" : session.transcriptMb > session.maxMb / 2 ? "warn" : "neutral") : "neutral";
    const runColumns: Array<DataColumn<Row>> = [
        { key: "at", label: "Started", value: (r) => r.at, render: (r) => when(r.at) },
        { key: "stage", label: "Stage", value: (r) => stageLabel(r.stage, r.kind), filter: "auto", render: (r) => <>{stageLabel(r.stage, r.kind)}{r.attempt && r.attempt > 1 ? <span className="field-hint"> attempt {r.attempt}</span> : null}</> },
        { key: "status", label: "Status", value: (r) => r.status ?? "helper", filter: "auto", render: (r) => (r.status ? <Chip tone={r.status === "done" ? "ok" : r.status === "failed" ? "bad" : r.status === "running" ? "info" : "neutral"}>{r.status}</Chip> : <Chip>helper</Chip>) },
        { key: "model", label: "Model", value: (r) => r.models.map((m) => m.replace(/^claude-/, "")).join(", ") || "—", filter: "auto", defaultHidden: true },
        { key: "turns", label: "Turns", kind: "num", value: (r) => r.turns ?? 0 },
        { key: "time", label: "Time", kind: "num", value: (r) => r.durationMs ?? 0, render: (r) => (r.durationMs != null ? hours(r.durationMs) : "—") },
        { key: "output", label: "Output", kind: "num", value: (r) => r.output, render: (r) => tokens(r.output) },
        { key: "cacheRead", label: "Cache read", kind: "num", value: (r) => r.cacheRead, render: (r) => tokens(r.cacheRead), defaultHidden: true },
        { key: "cacheWrite", label: "Cache write", kind: "num", value: (r) => r.cacheWrite, render: (r) => tokens(r.cacheWrite), defaultHidden: true },
        { key: "input", label: "Input", kind: "num", value: (r) => r.input, render: (r) => tokens(r.input), defaultHidden: true },
        { key: "cost", label: "Cost", kind: "num", value: (r) => r.cost, render: (r) => money(r.cost) },
        { key: "share", label: "Share", value: (r) => r.cost, render: (r) => shareCell(r.cost), hint: "Share of this task's total cost" },
        ...(data.shares.length > 0 ? [{ key: "win", label: "5 h window", kind: "num" as const, value: (r: Row) => windowPct(data.shares, r.accountId, "five_hour", r.cost) ?? 0, render: (r: Row) => pct(windowPct(data.shares, r.accountId, "five_hour", r.cost)), hint: "Share of the account's 5-hour window" }] : []),
    ];
    const stageColumns: Array<DataColumn<StageRow>> = [
        { key: "stage", label: "Stage", value: (b) => stageLabel(b.label, b.label) },
        { key: "runs", label: "Runs", kind: "num", value: (b) => b.runs },
        { key: "turns", label: "Turns", kind: "num", value: (b) => b.turns },
        { key: "time", label: "Time", kind: "num", value: (b) => b.durationMs, render: (b) => hours(b.durationMs) },
        { key: "output", label: "Output", kind: "num", value: (b) => b.output, render: (b) => tokens(b.output) },
        { key: "cacheRead", label: "Cache read", kind: "num", value: (b) => b.cacheRead, render: (b) => tokens(b.cacheRead), defaultHidden: true },
        { key: "cost", label: "Cost", kind: "num", value: (b) => b.cost, render: (b) => money(b.cost) },
        { key: "share", label: "Share", value: (b) => b.cost, render: (b) => shareCell(b.cost) },
    ];
    return (
        <>
            <Panel title="Cost" hint="Claude's own estimate at API list prices, per invocation, from the result event of each run. On a subscription it is a proxy for how much of the rate-limit windows this task used.">
                <StatRow>
                    <StatTile label="Total" value={money(t.cost)} sub={`${t.runs} invocation${t.runs === 1 ? "" : "s"}`} />
                    <StatTile label="Output tokens" value={tokens(t.output)} sub={`${t.turns} turns`} />
                    <StatTile label="Cache read" value={tokens(t.cacheRead)} sub={`write ${tokens(t.cacheWrite)}`} />
                    <StatTile label="Agent time" value={hours(t.durationMs)} sub={`input ${tokens(t.input)}`} />
                    {session && (
                        <StatTile
                            label="Task session"
                            tone={transcriptTone}
                            value={session.transcriptMb == null ? "—" : `${session.transcriptMb} MB`}
                            sub={<>limit {session.maxMb} MB <Button size="sm" disabled={rotating} title="The task session's transcript on disk. Every chat, Do, fix, Implementation and PR Fix run resumes it and pays for all of it; above the limit the next run starts a fresh session by itself." onClick={() => void rotate()}>{rotating ? "…" : "New session"}</Button></>}
                        />
                    )}
                    {data.byAccount.filter((a) => a.fiveHour != null || a.sevenDay != null).map((a) => (
                        <StatTile
                            key={a.accountId}
                            label={`${a.accountName} window share`}
                            value={<>{pct(a.fiveHour == null ? null : a.fiveHour * 100)} <small>of 5 h</small></>}
                            sub={`${pct(a.sevenDay == null ? null : a.sevenDay * 100)} of 7 d, ${money(a.cost)}`}
                        />
                    ))}
                </StatRow>
            </Panel>
            {data.rows.length === 0 ? (
                <EmptyState icon="chart" title="Nothing recorded yet" />
            ) : (
                <>
                    <DataTable embedded title="Per run" columns={runColumns} rows={data.rows} rowKey={(r) => r.key} selectable={false} storageKey="task-cost-runs" defaultSort={{ key: "at", desc: true }} />
                    <DataTable embedded title="Per stage" columns={stageColumns} rows={data.byStage} rowKey={(b) => b.key} selectable={false} storageKey="task-cost-stages" />
                </>
            )}
        </>
    );
};
