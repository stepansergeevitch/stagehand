import { useEffect, useState } from "react";
import { api, pct, STAGE_LABEL, windowPct, type Stage, type TaskUsage } from "./api";
import { hours, money, tokens } from "./Analytics";

// Cost tab of a task: what every claude invocation for this task consumed, in order, plus totals and a per-stage split.
const when = (iso: string): string => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const stageLabel = (s: string | null, kind: string): string => (s ? (STAGE_LABEL[s as Stage] ?? s) : kind === "qa-login" ? "QA login helper" : kind === "ticket-fetch" ? "Ticket fetch" : kind);

export const TaskCost = ({ taskId, refreshKey }: { taskId: string; refreshKey: string }) => {
    const [data, setData] = useState<TaskUsage | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        void api.taskUsage(taskId).then(setData).catch((e: Error) => setError(e.message));
    }, [taskId, refreshKey]);
    if (error) return <div className="blocked-box">{error}</div>;
    if (!data) return <div className="empty">loading…</div>;
    const t = data.totals;
    return (
        <section className="card usage-table">
            <h2>Cost</h2>
            <p className="field-hint">Claude's own estimate at API list prices, per invocation, from the result event of each run. On a subscription it is a proxy for how much of the rate-limit windows this task used.</p>
            <div className="tiles">
                <div className="tile"><div className="tile-label">Total</div><div className="tile-value">{money(t.cost)}</div><div className="tile-sub">{t.runs} invocation{t.runs === 1 ? "" : "s"}</div></div>
                <div className="tile"><div className="tile-label">Output tokens</div><div className="tile-value">{tokens(t.output)}</div><div className="tile-sub">{t.turns} turns</div></div>
                <div className="tile"><div className="tile-label">Cache read</div><div className="tile-value">{tokens(t.cacheRead)}</div><div className="tile-sub">write {tokens(t.cacheWrite)}</div></div>
                <div className="tile"><div className="tile-label">Agent time</div><div className="tile-value">{hours(t.durationMs)}</div><div className="tile-sub">input {tokens(t.input)}</div></div>
                {data.byAccount.filter((a) => a.fiveHour != null || a.sevenDay != null).map((a) => (
                    <div className="tile" key={a.accountId} title="This task's cost on the account as a share of its subscription windows, calibrated from how far runs moved the limit">
                        <div className="tile-label">{a.accountName} · window share</div>
                        <div className="tile-value">{pct(a.fiveHour == null ? null : a.fiveHour * 100)} <small>of 5 h</small></div>
                        <div className="tile-sub">{pct(a.sevenDay == null ? null : a.sevenDay * 100)} of 7 d · {money(a.cost)}</div>
                    </div>
                ))}
            </div>
            {data.rows.length === 0 && <div className="quiet">nothing recorded yet</div>}
            {data.rows.length > 0 && (
                <>
                    <h3>Per run</h3>
                    <table>
                        <thead><tr><th>Started</th><th>Stage</th><th>Status</th><th>Model</th><th>Turns</th><th>Time</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Input</th><th>Cost</th><th>Share</th>{data.shares.length > 0 && <th title="of the account's 5-hour window">5h win.</th>}</tr></thead>
                        <tbody>
                            {data.rows.map((r) => (
                                <tr key={r.key}>
                                    <td className="mono">{when(r.at)}</td>
                                    <td className="usage-label"><b>{stageLabel(r.stage, r.kind)}</b>{r.attempt && r.attempt > 1 ? <small>attempt {r.attempt}</small> : null}</td>
                                    <td>{r.status ? <span className={`chip ${r.status === "done" ? "ok" : r.status === "failed" ? "bad" : r.status === "running" ? "accent" : ""}`}>{r.status}</span> : <span className="chip">helper</span>}</td>
                                    <td className="mono">{r.models.map((m) => m.replace(/^claude-/, "")).join(", ") || "—"}</td>
                                    <td className="mono">{r.turns ?? "—"}</td>
                                    <td className="mono">{r.durationMs != null ? hours(r.durationMs) : "—"}</td>
                                    <td className="mono">{tokens(r.output)}</td>
                                    <td className="mono">{tokens(r.cacheRead)}</td>
                                    <td className="mono">{tokens(r.cacheWrite)}</td>
                                    <td className="mono">{tokens(r.input)}</td>
                                    <td className="mono">{money(r.cost)}</td>
                                    <td><span className="share"><i style={{ width: `${t.cost > 0 ? Math.round((r.cost / t.cost) * 100) : 0}%` }} /><span>{t.cost > 0 ? Math.round((r.cost / t.cost) * 100) : 0}%</span></span></td>
                                    {data.shares.length > 0 && <td className="mono">{pct(windowPct(data.shares, r.accountId, "five_hour", r.cost))}</td>}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <h3>Per stage</h3>
                    <table>
                        <thead><tr><th>Stage</th><th>Runs</th><th>Turns</th><th>Time</th><th>Output</th><th>Cache read</th><th>Cost</th><th>Share</th></tr></thead>
                        <tbody>
                            {data.byStage.map((b) => (
                                <tr key={b.key}>
                                    <td className="usage-label"><b>{stageLabel(b.label, b.label)}</b></td>
                                    <td className="mono">{b.runs}</td>
                                    <td className="mono">{b.turns}</td>
                                    <td className="mono">{hours(b.durationMs)}</td>
                                    <td className="mono">{tokens(b.output)}</td>
                                    <td className="mono">{tokens(b.cacheRead)}</td>
                                    <td className="mono">{money(b.cost)}</td>
                                    <td><span className="share"><i style={{ width: `${t.cost > 0 ? Math.round((b.cost / t.cost) * 100) : 0}%` }} /><span>{t.cost > 0 ? Math.round((b.cost / t.cost) * 100) : 0}%</span></span></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}
        </section>
    );
};
