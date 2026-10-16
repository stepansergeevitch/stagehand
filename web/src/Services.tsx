import { useCallback, useEffect, useState } from "react";
import { api, componentsOf, type Env, type EnvComponent, type Service } from "./api";
import { BranchPicker } from "./BranchPicker";
import { Button, Chip, EmptyState, Notice } from "@vortex/ds";
import "./tasks/workspace.css";

// Which branch of the dependency env this task's dependency runs from: the shared instance, or the BE of that env's
// task on a branch (a change that needs the dependency's own unmerged change). Applied at the next start of the app.
const DependencyBranch = ({ depEnvId, value, disabled, onSave }: { taskId: string; depEnvId: string; value: string | null; disabled: boolean; onSave: (b: string | null) => void }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    if (editing)
        return (
            <>
                <BranchPicker envId={depEnvId} value={draft} onChange={setDraft} placeholder="shared instance" autoFocus />
                <Button size="sm" onClick={() => { onSave(draft.trim() || null); setEditing(false); }}>Save</Button>
                <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </>
        );
    return (
        <>
            <code className="small" title="The dependency env's branch this task's dependency runs from — a task of that env must work on it; empty = the shared instance">⎇ {value ?? "shared"}</code>
            <Button size="sm" disabled={disabled} title="Run this task's dependency from another branch of the dependency env (the BE of its task on that branch); the task's app restarts on it at its next start" onClick={() => { setDraft(value ?? ""); setEditing(true); }}>Change</Button>
        </>
    );
};

const appUrlOf = (env: Env | undefined, be?: Service, fe?: Service) => (env?.app_url ?? "{{feUrl}}").replace("{{feUrl}}", fe?.url ?? "").replace("{{beUrl}}", be?.url ?? "");

// The 95% case of the app: Run it, Open it, see whether it is up. `compact` is the task header's form (a status dot and
// one button); the full form sits at the top of the App panel. Ports, logs, commands and the rest are in the panel's Details.
export const AppQuick = ({ taskId, env, onError, compact = false }: { taskId: string; env: Env | undefined; onError: (m: string) => void; compact?: boolean }) => {
    const [rows, setRows] = useState<Service[]>([]);
    const [busy, setBusy] = useState(false);
    const refresh = useCallback(() => api.services(taskId).then(setRows).catch(() => undefined), [taskId]);
    useEffect(() => {
        void refresh();
        const t = setInterval(() => void refresh(), 5000);
        return () => clearInterval(t);
    }, [refresh]);
    const be = rows.find((r) => r.kind === "be");
    const fe = rows.find((r) => r.kind === "fe");
    const configured = { be: !!env?.be_command, fe: !!env?.fe_command };
    if (!configured.be && !configured.fe) return null;
    const mine = [configured.be ? be : undefined, configured.fe ? fe : undefined].filter((x): x is Service => !!x);
    const failed = mine.some((r) => r.state === "failed");
    const up = (configured.be ? be?.state === "running" : true) && (configured.fe ? fe?.state === "running" : true);
    const starting = !failed && !up && mine.length > 0;
    const state: "ok" | "bad" | "warn" | "off" = failed ? "bad" : up ? "ok" : starting ? "warn" : "off";
    const label = failed ? "failed" : up ? "running" : starting ? "starting…" : "stopped";
    const run = async () => {
        setBusy(true);
        try {
            if (configured.be && be?.state !== "running") await api.startService(taskId, "be");
            if (configured.fe && fe?.state !== "running") await api.startService(taskId, "fe");
            await refresh();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setBusy(false);
        }
    };
    const openable = (fe?.running || (be?.running && !configured.fe)) && up;
    return (
        <div className={`app-quick${compact ? " compact" : ""}`} role="group" aria-label={`App: ${label}`}>
            <span className={`app-dot ${state}`} title={`App ${label}`} aria-hidden="true" />
            {!compact && <span className="app-quick-label">{label}</span>}
            {openable ? (
                <a className="btn btn-primary btn-sm" href={appUrlOf(env, be, fe)} target="_blank" rel="noreferrer">{compact ? "Open app" : "Open the app"}</a>
            ) : (
                <Button size="sm" variant="primary" disabled={busy || starting} onClick={() => void run()} title="Start this task's backend and frontend in its worktree">{busy || starting ? "Starting…" : failed ? "Retry app" : "Run app"}</Button>
            )}
        </div>
    );
};

// `busy`: a stage/agent run owns the task right now — Fix with agent needs the task's session, so it waits.
export const ServicesPanel = ({ taskId, env, dependencyBranch, busy: taskBusy = false, onError, onFixStarted }: { taskId: string; env: Env | undefined; dependencyBranch?: string | null; busy?: boolean; onError: (m: string) => void; onFixStarted?: () => void }) => {
    const [rows, setRows] = useState<Service[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [log, setLog] = useState<{ kind: string; text: string } | null>(null);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [fixing, setFixing] = useState<Set<string>>(new Set());

    // The last start of each service that failed (until one succeeds): kept here so it never vanishes with the button's spinner.
    const [failures, setFailures] = useState<Array<{ kind: string; at: string; error: string }>>([]);
    const refresh = useCallback(() => Promise.all([api.services(taskId).then(setRows), api.serviceFailures(taskId).then(setFailures)]).catch(() => undefined), [taskId]);
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
    // An env whose app URL does not use the FE (Northspyre Core: the backend serves the page, webpack on the FE port
    // only writes the bundle to disk and answers with a directory listing) — the FE URL is not a link to click.
    const feNotTheApp = !!env?.app_url && !env.app_url.includes("{{feUrl}}");
    const comps = componentsOf(env);
    // The env's shared dependency (Deal → Core): listed by the server even while stopped, one instance for every task.
    const dep = rows.find((r) => r.kind === "dependency");
    if (!configured.be && !configured.fe && comps.length === 0 && !dep) return <EmptyState icon="server" title="No BE or FE commands configured">Add them on the environment's page to start the app from here.</EmptyState>;

    // Run / Stop / Log like a component, plus its URL; Stop ends it for every task of the env (the shared instance).
    const depRow = (svc: Service) => (
        <div className={`svc ${svc.state === "failed" ? "failed" : ""}`} key="dependency">
            <span className="svc-kind" title={svc.shared === false ? "This task's dependency: the BE of the dependency env's task on the picked branch" : "Shared dependency of this env — one instance for every task; the BE calls it"}>{svc.label ?? "dependency"}</span>
            {env?.depends_on_env_id && <DependencyBranch taskId={taskId} depEnvId={env.depends_on_env_id} value={dependencyBranch ?? null} disabled={busy !== null || taskBusy} onSave={(b) => act("branch", () => api.patchTask(taskId, { dependencyBranch: b }))} />}
            {svc.state === "stopped" ? (
                <>
                    <Chip>stopped</Chip>
                    <Button variant="primary" disabled={busy !== null} title={svc.command} onClick={() => act("dependency", () => api.startService(taskId, "dependency"))}>{busy === "dependency" ? "starting…" : "Run"}</Button>
                </>
            ) : (
                <>
                    {svc.state === "running" ? <Chip tone="ok">running</Chip> : svc.state === "failed" ? <Chip tone="bad">failed</Chip> : <Chip tone="warn">starting…</Chip>}
                    {svc.url && <a href={svc.url} target="_blank" rel="noreferrer">{svc.url}</a>}
                    {svc.state === "failed" && (
                        <Button disabled={busy !== null} title="Stop and start it again with the same command" onClick={() => act("retry", async () => { await api.stopService(taskId, "dependency"); await api.startService(taskId, "dependency"); })}>
                            {busy === "retry" ? "restarting…" : "Retry"}
                        </Button>
                    )}
                    <Button disabled={busy !== null} title={svc.shared === false ? "Stops the dependency branch task's BE" : "Stops it for every task of this env"} onClick={() => act("dependency", () => api.stopService(taskId, "dependency"))}>{svc.state === "failed" ? "Dismiss" : "Stop"}</Button>
                    <Button disabled={busy !== null} onClick={() => act("log", () => api.serviceLog(taskId, "dependency").then((text) => setLog({ kind: "dependency", text })))}>Log</Button>
                    {svc.state === "failed" && svc.error && <span className="svc-error">{svc.error}</span>}
                </>
            )}
        </div>
    );

    // An optional component (a worker, a scheduler): Run / Stop / Log, no port, no agent fix.
    const compRow = (c: EnvComponent) => {
        const svc = rows.find((r) => r.kind === c.key);
        return (
            <div className={`svc ${svc?.state === "failed" ? "failed" : ""}`} key={c.key}>
                <span className="svc-kind" title={`optional component "${c.key}"${c.autoStart ? " — auto-started with the app" : ""}`}>{c.label}</span>
                {svc ? (
                    <>
                        {svc.state === "running" ? <Chip tone="ok">running</Chip> : svc.state === "failed" ? <Chip tone="bad">failed</Chip> : <Chip tone="warn">starting…</Chip>}
                        <Button disabled={busy !== null} onClick={() => act(c.key, () => api.stopService(taskId, c.key))}>{svc.state === "failed" ? "Dismiss" : "Stop"}</Button>
                        <Button disabled={busy !== null} onClick={() => act("log", () => api.serviceLog(taskId, c.key).then((text) => setLog({ kind: c.key, text })))}>Log</Button>
                        {svc.state === "failed" && svc.error && <span className="svc-error">{svc.error}</span>}
                    </>
                ) : (
                    <>
                        <Chip>stopped</Chip>
                        <Button variant="primary" disabled={busy !== null} title={c.command} onClick={() => act(c.key, () => api.startService(taskId, c.key))}>{busy === c.key ? "starting…" : "Run"}</Button>
                    </>
                )}
            </div>
        );
    };

    const stateChip = (svc: Service) =>
        svc.state === "running" ? <Chip tone="ok">running</Chip> : svc.state === "failed" ? <Chip tone="bad">failed</Chip> : <Chip tone="warn">starting…</Chip>;

    const row = (kind: "be" | "fe", svc: Service | undefined) => (
        <div className={`svc ${svc?.state === "failed" ? "failed" : ""}`} key={kind}>
            <span className="svc-kind">{kind.toUpperCase()}</span>
            {svc ? (
                <>
                    {stateChip(svc)}
                    {kind === "fe" && feNotTheApp ? (
                        <span className="mono" title="This env's app is served by the BE (its app URL is {{beUrl}}); this port only builds the bundle">{svc.url} <span className="field-hint">(bundle only, use Open app)</span></span>
                    ) : (
                        <a href={svc.url} target="_blank" rel="noreferrer">{svc.url}</a>
                    )}
                    {svc.state === "failed" && (
                        <>
                            {fixing.has(kind) || (taskBusy && fixing.size > 0) ? (
                                <Chip tone="wait" title="The result and the automatic restart land in Chat">agent fixing…</Chip>
                            ) : (
                                <Button variant="primary"
 
 disabled={busy !== null || taskBusy}
 title={taskBusy ? "a run is in progress — wait for it to finish" : "The task's agent reads the log, repairs the cause in the worktree, then Vortex restarts the service; the outcome lands in Chat"}
 onClick={() => act("fix", async () => { await api.fixService(taskId, kind); setFixing((s) => new Set(s).add(kind)); onFixStarted?.(); })}
>
                                    {busy === "fix" ? "Starting…" : "Fix with agent"}
                                </Button>
                            )}
                            <Button disabled={busy !== null || taskBusy} title="Stop and start it again with the same command" onClick={() => act("retry", async () => { await api.stopService(taskId, kind); await api.startService(taskId, kind); })}>
                                {busy === "retry" ? "restarting…" : "Retry"}
                            </Button>
                        </>
                    )}
                    <Button disabled={busy !== null} onClick={() => act(kind, () => api.stopService(taskId, kind))}>{svc.state === "failed" ? "Dismiss" : "Stop"}</Button>
                    <Button disabled={busy !== null} onClick={() => act("log", () => api.serviceLog(taskId, kind).then((text) => setLog({ kind, text })))}>Log</Button>
                    {svc.state === "failed" && svc.error && <span className="svc-error">{svc.error}</span>}
                </>
            ) : (
                <>
                    <Chip>stopped</Chip>
                    <Button variant="primary"
 
 disabled={busy !== null || !configured[kind] || (kind === "fe" && configured.be && (!be || be.state === "failed"))}
 title={kind === "fe" && configured.be && !be ? "start the BE first" : kind === "fe" && be?.state === "failed" ? "the BE failed — fix or retry it first" : ""}
 onClick={() => act(kind, () => api.startService(taskId, kind))}
>
                        {busy === kind ? "starting…" : `Run ${kind.toUpperCase()}`}
                    </Button>
                </>
            )}
        </div>
    );

    const anyFailed = failures.length > 0 || rows.some((r) => r.state === "failed");
    return (
        <>
            {failures.map((f) => (
                <Notice key={f.kind} tone="warn" className="svc-failure">
                    <b>The {f.kind.toUpperCase()} did not start</b> ({new Date(f.at).toLocaleTimeString()}): {f.error}
                </Notice>
            ))}
            <AppQuick taskId={taskId} env={env} onError={onError} />
            <details className="app-details" open={detailsOpen || anyFailed} onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}>
                <summary>Details</summary>
                {dep && depRow(dep)}
                {configured.be && row("be", be)}
                {configured.fe && row("fe", fe)}
                {comps.map(compRow)}
                {(fe?.running || (be?.running && !configured.fe)) && (
                    <div className="open-app">
                        <span className="mono field-hint">{[fe ? `FE ${fe.port}` : null, be ? `BE ${be.port}` : null].filter(Boolean).join(" → ")}</span>
                    </div>
                )}
                {log && (
                    <div className="feed svc-log">
                        <div className="k">{log.kind.toUpperCase()} log (tail, refreshes every 3 s) <Button size="sm" variant="ghost" onClick={() => setLog(null)}>Close</Button></div>
                        {log.text.split("\n").map((l, i) => <div key={i}>{l}</div>)}
                    </div>
                )}
            </details>
        </>
    );
};
