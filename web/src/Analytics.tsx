import { useEffect, useMemo, useState } from "react";
import { api, pct, STAGE_LABEL, type Stage, type UsageBucket, type UsageReport } from "./api";
import { storage } from "./storage";
import { Button, EmptyState, Hint, Skeleton } from "@vortex/ds";
import { DataTable, type DataColumn } from "./components/DataTable";
import { PageHeader } from "./components/PageHeader";
import { Panel } from "./components/Panel";
import { StatRow, StatTile } from "./components/StatTile";
import { BarChart, PeriodTabs, ShareBar } from "./InsightParts";
import { hours, money, tokens } from "./format";

// Usage: token and cost as reported by claude's result events, sliced by environment, account, task, stage, model and day.


const NOT_CALIBRATED = "Enterprise accounts have no windows, and a new account shows nothing until a run has moved its limit.";

const Breakdown = ({ title, hint, name, rows, total, labelOf, limit, windowHint, storageKey }: { title: string; hint?: string; name: string; rows: UsageBucket[]; total: number; labelOf?: (b: UsageBucket) => string; limit?: number; windowHint?: string; storageKey: string }) => {
    const [all, setAll] = useState(false);
    const shown = limit && !all ? rows.slice(0, limit) : rows;
    const hasSub = rows.some((b) => b.sub);
    const columns: DataColumn<UsageBucket>[] = useMemo(() => {
        const label = (b: UsageBucket): string => (labelOf ? labelOf(b) : b.label);
        const num = (key: string, header: string, value: (b: UsageBucket) => number, render: (b: UsageBucket) => string, extra: Partial<DataColumn<UsageBucket>> = {}): DataColumn<UsageBucket> =>
            ({ key, label: header, kind: "num", filter: false, value, render, ...extra });
        const window = (key: string, header: string, pick: (b: UsageBucket) => number | null | undefined, hintText: string): DataColumn<UsageBucket> =>
            ({ key, label: header, kind: "num", filter: false, hint: hintText, value: (b) => pick(b) ?? null, render: (b) => (pick(b) == null ? "—" : pct((pick(b) ?? 0) * 100)) });
        return [
            { key: "name", label: name, kind: "label", filter: false, value: label },
            ...(hasSub ? [{ key: "sub", label: "Detail", filter: false, value: (b: UsageBucket) => b.sub ?? "" }] : []),
            num("cost", "Cost", (b) => b.cost, (b) => money(b.cost)),
            { key: "share", label: "Share", filter: false, value: (b) => b.cost, render: (b) => <ShareBar part={b.cost} total={total} /> },
            ...(windowHint
                ? [
                    window("five", "5-hour window", (b) => b.fiveHour, `This cost as a share of the account's 5-hour subscription window. ${windowHint}`),
                    window("seven", "7-day window", (b) => b.sevenDay, `This cost as a share of the account's 7-day subscription window. ${windowHint}`),
                ]
                : []),
            num("runs", "Runs", (b) => b.runs, (b) => String(b.runs)),
            num("output", "Output", (b) => b.output, (b) => tokens(b.output)),
            num("cacheRead", "Cache read", (b) => b.cacheRead, (b) => tokens(b.cacheRead)),
            num("cacheWrite", "Cache write", (b) => b.cacheWrite, (b) => tokens(b.cacheWrite), { defaultHidden: true }),
            num("input", "Input", (b) => b.input, (b) => tokens(b.input), { defaultHidden: true }),
            num("time", "Time", (b) => b.durationMs, (b) => hours(b.durationMs)),
        ];
    }, [name, hasSub, total, labelOf, windowHint]);
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
            defaultSort={name === "Day" ? { key: "name", desc: true } : { key: "cost", desc: true }}
            storageKey={storageKey}
        />
    );
};

// The period is routed (#/analytics?days=<n>); without one, the period used last.
export const Analytics = ({ days: routedDays, onDays, onError }: { days?: number; onDays: (days: number) => void; onError: (m: string) => void }) => {
    const days = routedDays ?? Number(storage.get("vortex.usageDays") ?? "7");
    const [report, setReport] = useState<UsageReport | null>(null);
    useEffect(() => {
        storage.set("vortex.usageDays", String(days));
        setReport(null);
        void api.usage(days).then(setReport).catch((e: Error) => onError(e.message));
    }, [days, onError]);
    const t = report?.totals;
    const perDay = useMemo(
        () => (report ? [...report.byDay].sort((a, b) => a.label.localeCompare(b.label)).slice(-90).map((b) => ({ key: b.key, label: b.label, value: b.cost })) : []),
        [report],
    );
    // What one full window is worth, learned from how far each run moved the account's limit.
    const windowHint = report?.shares.length
        ? `One full window is about ${report.shares.map((s) => `${money(s.usdPerWindow)} (${s.accountName}, ${s.window === "five_hour" ? "5 h" : s.window === "seven_day" ? "7 d" : s.window}, ${s.samples} sample${s.samples === 1 ? "" : "s"})`).join(" · ")}. It refines with every run.`
        : NOT_CALIBRATED;
    return (
        <>
            <PageHeader
                title={<>Usage<Hint text="What the agents consumed, as reported by claude at the end of every run: stage runs, ticket fetches, QA logins. Cost is claude's estimate at API list prices. On a subscription it is a proxy for how much of the rate-limit windows each thing used, not a bill." /></>}
                actions={<PeriodTabs days={days} onDays={onDays} />}
            />
            {!report && (
                <>
                    <StatRow>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={84} />)}</StatRow>
                    <Skeleton height={260} />
                </>
            )}
            {report && t && (
                <>
                    <StatRow>
                        <StatTile label="Cost" value={money(t.cost)} sub={`${t.runs} run${t.runs === 1 ? "" : "s"}`} />
                        <StatTile label="Output tokens" value={tokens(t.output)} sub={`${t.turns} turns`} />
                        <StatTile label="Cache read" value={tokens(t.cacheRead)} sub={`${tokens(t.cacheWrite)} written`} />
                        <StatTile label="Agent time" value={hours(t.durationMs)} sub={`${tokens(t.input)} input tokens`} />
                    </StatRow>
                    {t.runs === 0 ? (
                        <Panel><EmptyState icon="chart" title="No runs in this period">Pick a longer period to see earlier usage.</EmptyState></Panel>
                    ) : (
                        <>
                            {perDay.length > 0 && (
                                <Panel title="Cost by day">
                                    <BarChart data={perDay} format={money} title="Cost by day" yTitle="Cost per day (USD)" xTitle="Day" />
                                </Panel>
                            )}
                            <Breakdown title="By environment" name="Environment" rows={report.byEnv} total={t.cost} storageKey="usage-env" />
                            <Breakdown title="By AI account" name="Account" rows={report.byAccount} total={t.cost} windowHint={windowHint} storageKey="usage-account" />
                            <Breakdown title="By task" name="Task" rows={report.byTask} total={t.cost} limit={10} storageKey="usage-task" />
                            <Breakdown title="By stage" name="Stage" rows={report.byStage} total={t.cost} labelOf={(b) => STAGE_LABEL[b.label as Stage] ?? b.label} storageKey="usage-stage" />
                            <Breakdown title="By model" name="Model" rows={report.byModel} total={t.cost} storageKey="usage-model" />
                            <Breakdown title="By day" hint="The table view of the chart above." name="Day" rows={report.byDay} total={t.cost} limit={14} storageKey="usage-day" />
                        </>
                    )}
                </>
            )}
        </>
    );
};
