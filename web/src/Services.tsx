import { useCallback, useEffect, useState } from "react";
import { api, type Env, type Service } from "./api";

// `busy`: a stage/agent run owns the task right now — Fix with agent needs the task's session, so it waits.
export const ServicesPanel = ({ taskId, env, busy: taskBusy = false, onError, onFixStarted }: { taskId: string; env: Env | undefined; busy?: boolean; onError: (m: string) => void; onFixStarted?: () => void }) => {
    const [rows, setRows] = useState<Service[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [log, setLog] = useState<{ kind: "be" | "fe"; text: string } | null>(null);
    const [fixing, setFixing] = useState<Set<string>>(new Set());

    const refresh = useCallback(() => api.services(taskId).then(setRows).catch(() => undefined), [taskId]);
    useEffect(() => {
        void refresh();
        const t = setInterval(() => void refresh(), 5000);
        return () => clearInterval(t);
    }, [refresh]);

    useEffect(() => {
        if (!log) return;
        const t = setInterval(() => void api.serviceLog(taskId, log.kind).then((text) => setLog({ kind: log.kind, text })), 3000);
        return () => clearInterval(t);
    }, [log?.kind, taskId]);

    // The fix hand-off is over once the task is no longer busy (the run restores the status when it finishes).
    useEffect(() => {
        if (!taskBusy) setFixing(new Set());
    }, [taskBusy]);

    const act = async (label: string, fn: () => Promise<unknown>) => {
        setBusy(label);
        try {
            await fn();
            await refresh();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };

    const be = rows.find((r) => r.kind === "be");
    const fe = rows.find((r) => r.kind === "fe");
    const configured = { be: !!env?.be_command, fe: !!env?.fe_command };
    if (!configured.be && !configured.fe) return <div className="empty">This env has no BE/FE commands configured — edit the env to add them.</div>;

    const stateChip = (svc: Service) =>
        svc.state === "running" ? <span className="chip ok">running</span> : svc.state === "failed" ? <span className="chip bad">failed</span> : <span className="chip warn">starting…</span>;

    const row = (kind: "be" | "fe", svc: Service | undefined) => (
        <div className={`svc ${svc?.state === "failed" ? "failed" : ""}`} key={kind}>
            <span className="svc-kind">{kind.toUpperCase()}</span>
            {svc ? (
                <>
                    {stateChip(svc)}
                    <a href={svc.url} target="_blank" rel="noreferrer">{svc.url}</a>
                    {svc.state === "failed" && (
                        <>
                            {fixing.has(kind) || (taskBusy && fixing.size > 0) ? (
                                <span className="chip wait" title="The result and the automatic restart land in Chat">agent fixing…</span>
                            ) : (
                                <button
                                    className="primary"
                                    disabled={busy !== null || taskBusy}
                                    title={taskBusy ? "a run is in progress — wait for it to finish" : "The task's agent reads the log, repairs the cause in the worktree, then Stagehand restarts the service; the outcome lands in Chat"}
                                    onClick={() => act("fix", async () => { await api.fixService(taskId, kind); setFixing((s) => new Set(s).add(kind)); onFixStarted?.(); })}
                                >
                                    {busy === "fix" ? "Starting…" : "Fix with agent"}
                                </button>
                            )}
                            <button disabled={busy !== null || taskBusy} title="Stop and start it again with the same command" onClick={() => act("retry", async () => { await api.stopService(taskId, kind); await api.startService(taskId, kind); })}>
                                {busy === "retry" ? "restarting…" : "Retry"}
                            </button>
                        </>
                    )}
                    <button disabled={busy !== null} onClick={() => act(kind, () => api.stopService(taskId, kind))}>{svc.state === "failed" ? "Dismiss" : "Stop"}</button>
                    <button disabled={busy !== null} onClick={() => act("log", () => api.serviceLog(taskId, kind).then((text) => setLog({ kind, text })))}>Log</button>
                    {svc.state === "failed" && svc.error && <span className="svc-error">{svc.error}</span>}
                </>
            ) : (
                <>
                    <span className="chip">stopped</span>
                    <button
                        className="primary"
                        disabled={busy !== null || !configured[kind] || (kind === "fe" && configured.be && (!be || be.state === "failed"))}
                        title={kind === "fe" && configured.be && !be ? "start the BE first" : kind === "fe" && be?.state === "failed" ? "the BE failed — fix or retry it first" : ""}
                        onClick={() => act(kind, () => api.startService(taskId, kind))}
                    >
                        {busy === kind ? "starting…" : `Run ${kind.toUpperCase()}`}
                    </button>
                </>
            )}
        </div>
    );

    return (
        <>
            {configured.be && row("be", be)}
            {configured.fe && row("fe", fe)}
            {(fe?.running || (be?.running && !configured.fe)) && (
                <div className="open-app">
                    <a className="button-link" href={(env?.app_url ?? "{{feUrl}}").replace("{{feUrl}}", fe?.url ?? "").replace("{{beUrl}}", be?.url ?? "")} target="_blank" rel="noreferrer">Open app ↗</a>
                    <span className="mono" style={{ color: "var(--ink-3)" }}>{[fe ? `FE ${fe.port}` : null, be ? `BE ${be.port}` : null].filter(Boolean).join(" → ")}</span>
                </div>
            )}
            {log && (
                <div className="feed" style={{ maxHeight: 320, marginTop: 8 }}>
                    <div className="k">{log.kind.toUpperCase()} log (tail, refreshes every 3 s) <button onClick={() => setLog(null)} style={{ float: "right", padding: "0 6px" }}>×</button></div>
                    {log.text.split("\n").map((l, i) => <div key={i}>{l}</div>)}
                </div>
            )}
        </>
    );
};
