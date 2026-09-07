import { useEffect, useState } from "react";
import { api, STAGE_LABEL, type Stage, type UsageBucket, type UsageReport } from "./api";

// Token and cost usage as reported by claude's result events, sliced by environment, account, task, stage, model and day.

const PERIODS: Array<{ days: number; label: string }> = [
    { days: 1, label: "24 h" },
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: 0, label: "all time" },
];

export const money = (n: number): string => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
export const tokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const hours = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="tile">
        <div className="tile-label">{label}</div>
        <div className="tile-value">{value}</div>
        {sub && <div className="tile-sub">{sub}</div>}
    </div>
);

const Breakdown = ({ title, rows, total, labelOf, limit }: { title: string; rows: UsageBucket[]; total: number; labelOf?: (b: UsageBucket) => string; limit?: number }) => {
    const [all, setAll] = useState(false);
    const shown = limit && !all ? rows.slice(0, limit) : rows;
    return (
        <section className="card usage-table">
            <h2>{title}</h2>
            {rows.length === 0 && <div className="quiet">nothing in this period</div>}
            {rows.length > 0 && (
                <table>
                    <thead><tr><th></th><th>Cost</th><th>Share</th><th>Runs</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Input</th><th>Time</th></tr></thead>
                    <tbody>
                        {shown.map((b) => (
                            <tr key={b.key}>
                                <td className="usage-label"><b>{labelOf ? labelOf(b) : b.label}</b>{b.sub && <small>{b.sub}</small>}</td>
                                <td className="mono">{money(b.cost)}</td>
                                <td><span className="share"><i style={{ width: `${total > 0 ? Math.round((b.cost / total) * 100) : 0}%` }} /><span>{total > 0 ? Math.round((b.cost / total) * 100) : 0}%</span></span></td>
                                <td className="mono">{b.runs}</td>
                                <td className="mono">{tokens(b.output)}</td>
                                <td className="mono">{tokens(b.cacheRead)}</td>
                                <td className="mono">{tokens(b.cacheWrite)}</td>
                                <td className="mono">{tokens(b.input)}</td>
                                <td className="mono">{hours(b.durationMs)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {limit && rows.length > limit && <div className="actions"><button onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button></div>}
        </section>
    );
};

export const Analytics = ({ onError }: { onError: (m: string) => void }) => {
    const [days, setDays] = useState(() => Number(localStorage.getItem("stagehand.usageDays") ?? "7"));
    const [report, setReport] = useState<UsageReport | null>(null);
    useEffect(() => {
        localStorage.setItem("stagehand.usageDays", String(days));
        setReport(null);
        void api.usage(days).then(setReport).catch((e: Error) => onError(e.message));
    }, [days, onError]);
    const t = report?.totals;
    return (
        <div className="env-page analytics">
            <h1>Analytics</h1>
            <p className="field-hint">What the agents consumed, as reported by claude at the end of every run (stage runs, ticket fetches, QA logins). Cost is claude's own estimate at API list prices — on a subscription it is a proxy for how much of the rate-limit windows each thing used, not a bill.</p>
            <div className="subtabs">
                {PERIODS.map((p) => <button key={p.days} className={days === p.days ? "active" : ""} onClick={() => setDays(p.days)}>{p.label}</button>)}
            </div>
            {!report && <div className="empty">loading…</div>}
            {report && t && (
                <>
                    <div className="tiles">
                        <Tile label="Cost" value={money(t.cost)} sub={`${t.runs} run${t.runs === 1 ? "" : "s"}`} />
                        <Tile label="Output tokens" value={tokens(t.output)} sub={`${t.turns} turns`} />
                        <Tile label="Cache read" value={tokens(t.cacheRead)} sub={`write ${tokens(t.cacheWrite)}`} />
                        <Tile label="Agent time" value={hours(t.durationMs)} sub={`input ${tokens(t.input)}`} />
                    </div>
                    <Breakdown title="By environment" rows={report.byEnv} total={t.cost} />
                    <Breakdown title="By AI account" rows={report.byAccount} total={t.cost} />
                    <Breakdown title="By task" rows={report.byTask} total={t.cost} limit={10} />
                    <Breakdown title="By stage" rows={report.byStage} total={t.cost} labelOf={(b) => STAGE_LABEL[b.label as Stage] ?? b.label} />
                    <Breakdown title="By model" rows={report.byModel} total={t.cost} />
                    <Breakdown title="By day" rows={report.byDay} total={t.cost} limit={14} />
                </>
            )}
        </div>
    );
};
