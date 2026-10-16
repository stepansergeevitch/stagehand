import { useEffect, useMemo, useState } from "react";
import { api, STAGE_LABEL, type Stage, type TaskTiming, type TimingBucket, type TimingReport } from "./api";
import { hours } from "./format";
import { storage } from "./storage";
import { Button, Chip, EmptyState, Hint, Skeleton } from "@vortex/ds";
import { DataTable, type DataColumn } from "./components/DataTable";
import { PageHeader } from "./components/PageHeader";
import { Panel } from "./components/Panel";
import { StatRow, StatTile } from "./components/StatTile";
import { BarChart, PeriodTabs, ShareBar, SplitBar } from "./InsightParts";

// Time the way Usage shows cost: how long the agents ran per stage, side operation, task and day, and how long
// each task sat working, waiting for the human, waiting for GitHub or rate-limited (from the task event log).

const OPERATION_LABEL: Record<string, string> = {
    chat: "Chat (Ask)",
    instruct: "Chat (Do)",
    rebase: "Rebase with the agent",
    "fix-service": "Fix a BE/FE start",
    "git-edit": "Remove a commit",
    prompter: "Prompter turns",
    probe: "Chrome / model probes",
    "ticket-fetch": "Ticket fetches",
    "qa-login": "QA login helper",
    jev: "Jev decisions",
};
const STATE_LABEL: Record<string, string> = { working: "working", waiting_human: "waiting for you", waiting_github: "waiting for GitHub", rate_limited: "rate-limited", other: "idle" };

const stageLabel = (s: string): string => STAGE_LABEL[s as Stage] ?? s;

const Breakdown = ({ title, hint, name, rows, total, labelOf, subOf, limit, unit = "Runs", subLabel = "Detail", storageKey }: { title: string; hint?: string; name: string; rows: TimingBucket[]; total: number; labelOf?: (b: TimingBucket) => string; subOf?: (b: TimingBucket) => string | undefined; limit?: number; unit?: string; subLabel?: string; storageKey: string }) => {
    const [all, setAll] = useState(false);
    const shown = limit && !all ? rows.slice(0, limit) : rows;
    const hasSub = rows.some((b) => (subOf ? subOf(b) : b.sub));
    const columns: DataColumn<TimingBucket>[] = useMemo(() => {
        const num = (key: string, header: string, value: (b: TimingBucket) => number, render: (b: TimingBucket) => string, extra: Partial<DataColumn<TimingBucket>> = {}): DataColumn<TimingBucket> =>
            ({ key, label: header, kind: "num", filter: false, value, render, ...extra });
        return [
            { key: "name", label: name, kind: "label", filter: false, value: (b) => (labelOf ? labelOf(b) : b.label) },
            ...(hasSub ? [{ key: "sub", label: subLabel, value: (b: TimingBucket) => (subOf ? subOf(b) : b.sub) ?? "" }] : []),
            num("total", "Total", (b) => b.totalMs, (b) => hours(b.totalMs)),
            { key: "share", label: "Share", filter: false, value: (b) => b.totalMs, render: (b) => <ShareBar part={b.totalMs} total={total} /> },
            num("runs", unit, (b) => b.runs, (b) => String(b.runs)),
            num("avg", "Average", (b) => b.avgMs, (b) => hours(b.avgMs)),
            num("median", "Median", (b) => b.medianMs, (b) => hours(b.medianMs)),
            num("p90", "90th percentile", (b) => b.p90Ms, (b) => hours(b.p90Ms), { hint: "Nine in ten were quicker than this." }),
            num("max", "Longest", (b) => b.maxMs, (b) => hours(b.maxMs), { defaultHidden: true }),
        ];
    }, [name, unit, subLabel, hasSub, total, labelOf, subOf]);
    return (
        <DataTable
            embedded
            title={<>{title}{hint && <Hint text={hint} />}</>}
            actions={limit && rows.length > limit ? <Button size="sm" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</Button> : undefined}
            columns={columns}
            rows={shown}
            rowKey={(b) => b.key}
            selectable={false}
            empty="Nothing in this period."
            defaultSort={name === "Day" ? { key: "name", desc: true } : { key: "total", desc: true }}
            storageKey={storageKey}
        />
    );
};

// Per task: lead time, where it went, and one hidden column per stage with the time spent there (the column picker
// shows them), so nothing needs an expanding row.
const TaskRows = ({ rows }: { rows: TaskTiming[] }) => {
    const [all, setAll] = useState(false);
    const shown = all ? rows : rows.slice(0, 12);
    const stages = useMemo(() => [...new Set(rows.flatMap((t) => Object.keys(t.stagesMs)))], [rows]);
    const ms = (t: TaskTiming, v: number): number | null => (t.tracked ? v : null);
    const longest = (t: TaskTiming): string => {
        const top = Object.entries(t.stagesMs).sort((a, b) => b[1] - a[1])[0];
        return top ? `${stageLabel(top[0])} · ${hours(top[1])}` : "—";
    };
    const columns: DataColumn<TaskTiming>[] = useMemo(() => {
        const dur = (key: string, label: string, value: (t: TaskTiming) => number | null, extra: Partial<DataColumn<TaskTiming>> = {}): DataColumn<TaskTiming> =>
            ({ key, label, kind: "num", filter: false, value, render: (t) => { const v = value(t); return v == null ? "—" : hours(v); }, ...extra });
        return [
            { key: "task", label: "Task", kind: "label", filter: false, value: (t) => t.label },
            { key: "title", label: "Title", filter: false, value: (t) => t.sub ?? "" },
            { key: "state", label: "State", value: (t) => (!t.status ? "Deleted" : t.done ? "Done" : t.status), render: (t) => (!t.status ? <Chip>Deleted</Chip> : t.done ? <Chip tone="ok">Done</Chip> : <span>{t.status}</span>) },
            { key: "stage", label: "Stage", value: (t) => (t.stage ? stageLabel(t.stage) : "") },
            dur("lead", "Lead time", (t) => (t.createdAt ? t.leadMs : null), { hint: "From creation to done, or to now while the task is open." }),
            dur("working", "Working", (t) => ms(t, t.workingMs), { hint: "The split into working and waiting comes from the task's state changes. Time before this version recorded them shows as a dash." }),
            dur("human", "Waiting for you", (t) => ms(t, t.waitingHumanMs)),
            dur("github", "Waiting for GitHub", (t) => ms(t, t.waitingGithubMs)),
            dur("limited", "Rate-limited", (t) => ms(t, t.rateLimitedMs)),
            dur("agent", "Agent time", (t) => t.agentMs),
            { key: "runs", label: "Runs", kind: "num", filter: false, value: (t) => t.runs },
            { key: "longest", label: "Longest stage", filter: false, defaultHidden: true, value: (t) => Object.values(t.stagesMs).reduce((m, v) => Math.max(m, v), 0), render: longest },
            ...stages.map((s) => dur(`stage-${s}`, stageLabel(s), (t) => t.stagesMs[s] ?? null, { defaultHidden: true })),
        ];
    }, [stages]);
    return (
        <DataTable
            embedded
            title={<>By task<Hint text="Lead time is creation to done, or to now. The columns after Stage split it by what the task was waiting for; the column picker adds the time spent at each stage." /></>}
            actions={rows.length > 12 ? <Button size="sm" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</Button> : undefined}
            columns={columns}
            rows={shown}
            rowKey={(t) => t.key}
            selectable={false}
            empty="Nothing in this period."
            defaultSort={{ key: "lead", desc: true }}
            storageKey="timing-task"
        />
    );
};

// The period is routed (#/timing?days=<n>); without one, the period used last.
export const Timing = ({ days: routedDays, onDays, onError }: { days?: number; onDays: (days: number) => void; onError: (m: string) => void }) => {
    const days = routedDays ?? Number(storage.get("vortex.timingDays") ?? "7");
    const [report, setReport] = useState<TimingReport | null>(null);
    useEffect(() => {
        storage.set("vortex.timingDays", String(days));
        setReport(null);
        void api.timing(days).then(setReport).catch((e: Error) => onError(e.message));
    }, [days, onError]);
    const t = report?.totals;
    const tracked = t ? t.workingMs + t.waitingHumanMs + t.waitingGithubMs + t.rateLimitedMs : 0;
    const share = (v: number): string => (tracked > 0 ? `${Math.round((v / tracked) * 100)}% of tracked time` : "not tracked yet");
    const perDay = useMemo(
        () => (report ? [...report.byDay].sort((a, b) => a.label.localeCompare(b.label)).slice(-90).map((b) => ({ key: b.key, label: b.label, value: b.totalMs })) : []),
        [report],
    );
    return (
        <>
            <PageHeader
                title={<>Timing<Hint text="How long things take: the wall time of every agent run by stage, operation and day, and per task the calendar time from creation to done, split into working, waiting for you, waiting for GitHub and rate-limited." /></>}
                actions={<PeriodTabs days={days} onDays={onDays} />}
            />
            {!report && (
                <>
                    <StatRow>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={84} />)}</StatRow>
                    <Skeleton height={200} />
                </>
            )}
            {report && t && (
                <>
                    <StatRow>
                        <StatTile label="Agent run time" value={hours(t.agentMs)} sub={`${t.runs} run${t.runs === 1 ? "" : "s"} · side operations ${hours(t.operationsMs)}`} />
                        <StatTile label="Lead time of done tasks" value={t.doneTasks ? hours(t.medianLeadMs) : "—"} sub={t.doneTasks ? `median · average ${hours(t.avgLeadMs)} · ${t.doneTasks} done of ${t.tasks}` : `${t.tasks} task${t.tasks === 1 ? "" : "s"}, none done in this period`} />
                        <StatTile label="Waiting for you" value={hours(t.waitingHumanMs)} sub={share(t.waitingHumanMs)} />
                        <StatTile label="Working" value={hours(t.workingMs)} sub={share(t.workingMs)} />
                    </StatRow>
                    {t.runs === 0 && t.tasks === 0 ? (
                        <Panel><EmptyState icon="clock" title="No runs in this period">Pick a longer period to see earlier timings.</EmptyState></Panel>
                    ) : (
                        <>
                            <Panel title="Where task time went" hint="Calendar time of every task in this period, by what the task was doing or waiting for.">
                                <SplitBar
                                    title="Where task time went"
                                    parts={[
                                        { key: "working", label: "Working", value: t.workingMs, text: hours(t.workingMs), slot: 1 },
                                        { key: "human", label: "Waiting for you", value: t.waitingHumanMs, text: hours(t.waitingHumanMs), slot: 2 },
                                        { key: "github", label: "Waiting for GitHub", value: t.waitingGithubMs, text: hours(t.waitingGithubMs), slot: 3 },
                                        { key: "limited", label: "Rate-limited", value: t.rateLimitedMs, text: hours(t.rateLimitedMs), slot: 4 },
                                    ]}
                                />
                            </Panel>
                            {perDay.length > 0 && (
                                <Panel title="Agent run time by day">
                                    <BarChart data={perDay} format={hours} title="Agent run time by day" yTitle="Agent run time per day" xTitle="Day" />
                                </Panel>
                            )}
                            <Breakdown title="By stage" hint="Wall time of every agent run." name="Stage" rows={report.byStage} total={t.agentMs} labelOf={(b) => stageLabel(b.label)} storageKey="timing-stage" />
                            <Breakdown title="By operation" hint="Side runs, as reported by claude." name="Operation" rows={report.byOperation} total={t.operationsMs} labelOf={(b) => OPERATION_LABEL[b.label] ?? b.label} unit="Calls" storageKey="timing-operation" />
                            <TaskRows rows={report.byTask} />
                            <Breakdown title="Time at each stage, by what it waited for" name="Stage" rows={report.byStageState} total={tracked} labelOf={(b) => stageLabel(b.label)} subOf={(b) => (b.sub ? STATE_LABEL[b.sub] ?? b.sub : undefined)} limit={12} unit="Spells" subLabel="Waiting for" storageKey="timing-stage-state" />
                            <Breakdown title="By day" hint="Wall time of agent runs; the table view of the chart above." name="Day" rows={report.byDay} total={t.agentMs} limit={14} storageKey="timing-day" />
                        </>
                    )}
                </>
            )}
        </>
    );
};
