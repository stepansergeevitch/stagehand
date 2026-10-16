import { useEffect, useState } from "react";
import { api, STAGE_LABEL, type Stage, type TaskTiming, type TimingBucket, type TimingReport } from "./api";
import { hours } from "./Analytics";
import { storage } from "./storage";
import { Button, Card, Chip, Tab, TabList } from "@vortex/ds";

// Time the way Analytics shows cost: how long the agents ran per stage, side operation, task and day, and how long
// each task sat working, waiting for the human, waiting for GitHub or rate-limited (from the task event log).

const PERIODS: Array<{ days: number; label: string }> = [
    { days: 1, label: "24 h" },
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: 0, label: "all time" },
];

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

const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="tile">
        <div className="tile-label">{label}</div>
        <div className="tile-value">{value}</div>
        {sub && <div className="tile-sub">{sub}</div>}
    </div>
);

const Breakdown = ({ title, rows, total, labelOf, subOf, limit, unit = "runs" }: { title: string; rows: TimingBucket[]; total: number; labelOf?: (b: TimingBucket) => string; subOf?: (b: TimingBucket) => string | undefined; limit?: number; unit?: string }) => {
    const [all, setAll] = useState(false);
    const shown = limit && !all ? rows.slice(0, limit) : rows;
    return (
        <Card className="usage-table">
            <h2>{title}</h2>
            {rows.length === 0 && <div className="quiet">nothing in this period</div>}
            {rows.length > 0 && (
                <table>
                    <thead><tr><th></th><th>Total</th><th>Share</th><th>{unit}</th><th>Avg</th><th>Median</th><th>P90</th><th>Max</th></tr></thead>
                    <tbody>
                        {shown.map((b) => {
                            const sub = subOf ? subOf(b) : b.sub;
                            return (
                                <tr key={b.key}>
                                    <td className="usage-label"><b>{labelOf ? labelOf(b) : b.label}</b>{sub && <small>{sub}</small>}</td>
                                    <td className="mono">{hours(b.totalMs)}</td>
                                    <td><span className="share"><i style={{ width: `${total > 0 ? Math.round((b.totalMs / total) * 100) : 0}%` }} /><span>{total > 0 ? Math.round((b.totalMs / total) * 100) : 0}%</span></span></td>
                                    <td className="mono">{b.runs}</td>
                                    <td className="mono">{hours(b.avgMs)}</td>
                                    <td className="mono">{hours(b.medianMs)}</td>
                                    <td className="mono">{hours(b.p90Ms)}</td>
                                    <td className="mono">{hours(b.maxMs)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {limit && rows.length > limit && <div className="actions"><Button onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</Button></div>}
        </Card>
    );
};

const stageLabel = (s: string): string => STAGE_LABEL[s as Stage] ?? s;

const TaskRows = ({ rows }: { rows: TaskTiming[] }) => {
    const [all, setAll] = useState(false);
    const [openId, setOpenId] = useState<string | null>(null);
    const shown = all ? rows : rows.slice(0, 12);
    const maxLead = Math.max(1, ...rows.map((t) => t.leadMs));
    return (
        <Card className="usage-table">
            <h2>By task</h2>
            <p className="field-hint">Lead time is creation → done (or now). The split into working / waiting comes from the task's state changes and is tracked from the moment this version started recording them; older time shows as untracked. Click a row for its stages.</p>
            {rows.length === 0 && <div className="quiet">nothing in this period</div>}
            {rows.length > 0 && (
                <table>
                    <thead><tr><th></th><th>Lead time</th><th></th><th>Working</th><th>Waiting for you</th><th>Waiting for GitHub</th><th>Rate-limited</th><th>Agent runs</th><th>Runs</th><th>State</th></tr></thead>
                    <tbody>
                        {shown.map((t) => {
                            const tracked = t.workingMs + t.waitingHumanMs + t.waitingGithubMs + t.rateLimitedMs;
                            const pct = (ms: number): string => (tracked > 0 ? ` (${Math.round((ms / tracked) * 100)}%)` : "");
                            const open = openId === t.key;
                            return (
                                <>
                                    <tr key={t.key} className="timing-task" onClick={() => setOpenId(open ? null : t.key)}>
                                        <td className="usage-label"><b>{t.label}</b>{t.sub && <small>{t.sub}</small>}</td>
                                        <td className="mono">{t.createdAt ? hours(t.leadMs) : "—"}</td>
                                        <td><span className="share"><i style={{ width: `${Math.round((t.leadMs / maxLead) * 100)}%` }} /><span /></span></td>
                                        <td className="mono">{t.tracked ? `${hours(t.workingMs)}${pct(t.workingMs)}` : "—"}</td>
                                        <td className="mono">{t.tracked ? `${hours(t.waitingHumanMs)}${pct(t.waitingHumanMs)}` : "—"}</td>
                                        <td className="mono">{t.tracked ? `${hours(t.waitingGithubMs)}${pct(t.waitingGithubMs)}` : "—"}</td>
                                        <td className="mono">{t.tracked ? hours(t.rateLimitedMs) : "—"}</td>
                                        <td className="mono">{hours(t.agentMs)}</td>
                                        <td className="mono">{t.runs}</td>
                                        <td>{t.status ? <Chip className={`${t.done ? "ok" : ""}`}>{t.done ? "done" : `${stageLabel(t.stage ?? "")} · ${t.status}`}</Chip> : <Chip>deleted</Chip>}</td>
                                    </tr>
                                    {open && (
                                        <tr key={`${t.key}-stages`} className="timing-stages">
                                            <td colSpan={10}>
                                                {Object.keys(t.stagesMs).length === 0 && <span className="quiet">no tracked state changes in this period</span>}
                                                {Object.entries(t.stagesMs)
                                                    .sort((a, b) => b[1] - a[1])
                                                    .map(([stage, ms]) => <Chip key={stage} title={`time spent at ${stageLabel(stage)}`}>{stageLabel(stage)} · {hours(ms)}</Chip>)}
                                            </td>
                                        </tr>
                                    )}
                                </>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {rows.length > 12 && <div className="actions"><Button onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</Button></div>}
        </Card>
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
    const share = (ms: number): string => (tracked > 0 ? `${Math.round((ms / tracked) * 100)}% of tracked time` : "not tracked yet");
    return (
        <div className="env-page analytics">
            <h1>Timing</h1>
            <p className="field-hint">How long things take: the wall time of every agent run by stage, operation and day, and per task the calendar time from creation to done, split into working, waiting for you, waiting for GitHub and rate-limited (from the task's state changes).</p>
            <TabList variant="pill">
                {PERIODS.map((p) => <Tab key={p.days} active={days === p.days} onClick={() => onDays(p.days)}>{p.label}</Tab>)}
            </TabList>
            {!report && <div className="empty">loading…</div>}
            {report && t && (
                <>
                    <div className="tiles">
                        <Tile label="Agent run time" value={hours(t.agentMs)} sub={`${t.runs} run${t.runs === 1 ? "" : "s"} · side operations ${hours(t.operationsMs)}`} />
                        <Tile label="Lead time (done tasks)" value={t.doneTasks ? hours(t.medianLeadMs) : "—"} sub={t.doneTasks ? `median · avg ${hours(t.avgLeadMs)} · ${t.doneTasks} done of ${t.tasks}` : `${t.tasks} task${t.tasks === 1 ? "" : "s"}, none done in this period`} />
                        <Tile label="Waiting for you" value={hours(t.waitingHumanMs)} sub={share(t.waitingHumanMs)} />
                        <Tile label="Working" value={hours(t.workingMs)} sub={`${share(t.workingMs)} · GitHub ${hours(t.waitingGithubMs)} · rate-limited ${hours(t.rateLimitedMs)}`} />
                    </div>
                    <Breakdown title="By stage (run wall time)" rows={report.byStage} total={t.agentMs} labelOf={(b) => stageLabel(b.label)} />
                    <Breakdown title="By operation (side runs, as reported by claude)" rows={report.byOperation} total={t.operationsMs} labelOf={(b) => OPERATION_LABEL[b.label] ?? b.label} unit="calls" />
                    <TaskRows rows={report.byTask} />
                    <Breakdown title="Time at each stage, by what it waited for" rows={report.byStageState} total={tracked} labelOf={(b) => stageLabel(b.label)} subOf={(b) => (b.sub ? STATE_LABEL[b.sub] ?? b.sub : undefined)} limit={12} unit="spells" />
                    <Breakdown title="By day (run wall time)" rows={report.byDay} total={t.agentMs} limit={14} />
                </>
            )}
        </div>
    );
};
