import { useCallback, useEffect, useState } from "react";
import { api, type Env, type Service } from "./api";

export const ServicesPanel = ({ taskId, env, onError }: { taskId: string; env: Env | undefined; onError: (m: string) => void }) => {
    const [rows, setRows] = useState<Service[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [log, setLog] = useState<{ kind: "be" | "fe"; text: string } | null>(null);

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

    const row = (kind: "be" | "fe", svc: Service | undefined) => (
        <div className="svc" key={kind}>
            <span className="svc-kind">{kind.toUpperCase()}</span>
            {svc ? (
                <>
                    <span className={`chip ${svc.running ? "ok" : "warn"}`}>{svc.running ? "running" : "starting…"}</span>
                    <a href={svc.url} target="_blank" rel="noreferrer">{svc.url}</a>
                    <button disabled={busy !== null} onClick={() => act(kind, () => api.stopService(taskId, kind))}>Stop</button>
                    <button disabled={busy !== null} onClick={() => act("log", () => api.serviceLog(taskId, kind).then((text) => setLog({ kind, text })))}>Log</button>
                </>
            ) : (
                <>
                    <span className="chip">stopped</span>
                    <button className="primary" disabled={busy !== null || !configured[kind] || (kind === "fe" && configured.be && !be)} title={kind === "fe" && configured.be && !be ? "start the BE first" : ""} onClick={() => act(kind, () => api.startService(taskId, kind))}>
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
