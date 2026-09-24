import { useCallback, useEffect, useState } from "react";
import { api, type Resource, type ResourceKind, type ResourcePolicies, type ResourceSnapshot } from "./api";
import { hours } from "./Analytics";

// Everything Stagehand has started on this host — dev servers, agent runs, terminals, browsers, worktrees — with what
// each costs (RSS, CPU, disk), who owns it, what the policy will do with it and when. Stop and pin per row; the
// policies themselves are edited at the bottom.

const gb = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const ago = (ms: number | null): string => (ms == null ? "—" : ms < 60_000 ? "now" : hours(ms));
const KIND_LABEL: Record<ResourceKind, string> = {
    service: "dev server",
    dependency: "dependency",
    run: "agent run",
    terminal: "terminal",
    session: "session",
    login: "login helper",
    browser: "QA browser",
    clone: "Chrome copy",
    worktree: "worktree",
    orphan: "orphan",
};
const KIND_ORDER: ResourceKind[] = ["orphan", "service", "dependency", "run", "browser", "clone", "terminal", "session", "login", "worktree"];

const Tile = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad" }) => (
    <div className={`tile${tone ? ` tile-${tone}` : ""}`}>
        <div className="tile-label">{label}</div>
        <div className="tile-value">{value}</div>
        {sub && <div className="tile-sub">{sub}</div>}
    </div>
);

const Verdict = ({ r }: { r: Resource }) => {
    if (r.pinned) return <span className="chip accent" title={r.policy.reason}>pinned</span>;
    if (r.policy.verdict === "keep") return <span className="chip ok" title={r.policy.reason}>keep · {r.policy.reason}</span>;
    const due = r.policy.dueAt ? Date.parse(r.policy.dueAt) - Date.now() : 0;
    return (
        <span className={`chip ${due <= 0 ? "bad" : "warn"}`} title={r.policy.reason}>
            {due <= 0 ? "stopping" : `stops in ${hours(due)}`} · {r.policy.reason}
        </span>
    );
};

const Owner = ({ r }: { r: Resource }) => {
    const o = r.owner;
    if (o.type === "none") return <span className="quiet">nobody</span>;
    return (
        <span>
            <b>{o.name ?? o.id?.slice(0, 8) ?? "?"}</b>
            {o.stage && <span className="res-sub"> {o.stage.replace(/_/g, " ")}</span>}
            {o.status && <span className="res-sub"> · {o.status.replace(/_/g, " ")}</span>}
        </span>
    );
};

const Policies = ({ value, onSaved, onError }: { value: ResourcePolicies; onSaved: () => void; onError: (m: string) => void }) => {
    const [p, setP] = useState(value);
    const [saving, setSaving] = useState(false);
    useEffect(() => setP(value), [value]);
    const num = (k: keyof ResourcePolicies) => (e: React.ChangeEvent<HTMLInputElement>) => setP((x) => ({ ...x, [k]: Number(e.target.value) }));
    const save = async () => {
        setSaving(true);
        try {
            await api.patchSettings({ resources: p });
            onSaved();
        } catch (e) {
            onError((e as Error).message);
        } finally {
            setSaving(false);
        }
    };
    return (
        <section className="card env-section">
            <h2>Policies</h2>
            <p className="field-hint">What the reaper does on its own, every 20 s. A pinned resource is never touched; a BE/FE you start yourself is pinned until you stop it. Under memory pressure (swap or available RAM past the thresholds) every grace period becomes zero and idle terminals go after 30 min.</p>
            <div className="env-fields">
                <label className="inline"><input type="checkbox" checked={p.enabled} onChange={(e) => setP((x) => ({ ...x, enabled: e.target.checked }))} /> Automatic cleanup on (off = the page only shows and lets you stop by hand)</label>
                <div className="two">
                    <label>Parked task keeps its BE/FE for (min) <input type="number" min={0} value={p.idleServiceMinutes} onChange={num("idleServiceMinutes")} /></label>
                    <label>Task past QA (PR stages, done, stopped) keeps them for (min) <input type="number" min={0} value={p.doneServiceMinutes} onChange={num("doneServiceMinutes")} /></label>
                    <label>A fresh start settles for (min) — never stopped before that, whatever the pressure <input type="number" min={0} value={p.settleMinutes} onChange={num("settleMinutes")} /></label>
                    <label>Tasks that may hold dev servers at once <input type="number" min={1} value={p.maxDevServerTasks} onChange={num("maxDevServerTasks")} /></label>
                    <label>Task terminal idle limit (h) <input type="number" min={0} value={p.terminalIdleHours} onChange={num("terminalIdleHours")} /></label>
                    <label>Session idle limit (h) <input type="number" min={0} value={p.sessionIdleHours} onChange={num("sessionIdleHours")} /></label>
                    <label>Login helper lifetime (min) <input type="number" min={0} value={p.loginMinutes} onChange={num("loginMinutes")} /></label>
                    <label>Orphan grace (min) <input type="number" min={0} value={p.orphanMinutes} onChange={num("orphanMinutes")} /></label>
                    <label>Memory pressure below available (MB) <input type="number" min={0} value={p.minAvailableMb} onChange={num("minAvailableMb")} /></label>
                    <label>Memory pressure above swap (MB) <input type="number" min={0} value={p.maxSwapMb} onChange={num("maxSwapMb")} /></label>
                </div>
            </div>
            <div className="actions"><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button></div>
        </section>
    );
};

export const ResourcesPage = ({ onError }: { onError: (m: string) => void }) => {
    const [snap, setSnap] = useState<ResourceSnapshot | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const load = useCallback((refresh = false) => api.resources(refresh).then(setSnap).catch((e: Error) => onError(e.message)), [onError]);
    useEffect(() => {
        void load();
        const t = setInterval(() => void load(), 10_000);
        return () => clearInterval(t);
    }, [load]);
    const act = async (label: string, fn: () => Promise<unknown>) => {
        setBusy(label);
        try {
            await fn();
            await load(true);
        } catch (e) {
            onError((e as Error).message);
        } finally {
            setBusy(null);
        }
    };
    if (!snap) return <div className="empty">Reading the host…</div>;
    const h = snap.host;
    const tone = h.pressure === "critical" ? "bad" : h.pressure === "warn" ? "warn" : "ok";
    const orphans = snap.resources.filter((r) => r.kind === "orphan");
    const due = snap.resources.filter((r) => r.policy.verdict === "stop" && r.kind !== "orphan");
    const groups = KIND_ORDER.map((k) => ({ kind: k, rows: snap.resources.filter((r) => r.kind === k) })).filter((g) => g.rows.length);
    const disk = snap.resources.reduce((s, r) => s + (r.diskMb ?? 0), 0);
    return (
        <div className="resources-page">
            <div className="page-head">
                <h1>Resources</h1>
                <span className="quiet">observed {ago(Date.now() - Date.parse(snap.at))} ago</span>
                <div className="spacer" />
                <button disabled={!!busy} onClick={() => void act("refresh", () => load(true))}>Refresh</button>
                <button className="danger" disabled={!!busy || (!orphans.length && !due.length)} title="Stops every orphan and every resource whose policy already says stop" onClick={() => void act("sweep", () => api.sweepResources())}>
                    Clean up {orphans.length + due.length ? `(${orphans.length + due.length})` : ""}
                </button>
            </div>
            {h.pressure !== "ok" && <div className={`blocked-box ${h.pressure === "critical" ? "" : "warn"}`}>Memory pressure: {h.pressureReason}. {h.pressure === "critical" ? "Grace periods are zero — parked dev servers and idle terminals stop now." : "Grace periods still apply."}</div>}
            <div className="tiles">
                <Tile label="Host RAM" value={`${gb(h.usedMb)} used`} sub={`${gb(h.availableMb)} available of ${gb(h.totalMb)} · ${gb(h.compressedMb)} compressed`} tone={tone} />
                <Tile label="Swap" value={gb(h.swapUsedMb)} sub={`of ${gb(h.swapTotalMb)}`} tone={h.swapUsedMb > snap.policies.maxSwapMb ? "bad" : h.swapUsedMb > snap.policies.maxSwapMb / 2 ? "warn" : "ok"} />
                <Tile label="Stagehand processes" value={gb(snap.stagehand.rssMb)} sub={`${snap.stagehand.procs} processes · ${snap.stagehand.runs} agent run${snap.stagehand.runs === 1 ? "" : "s"} · ${snap.stagehand.browsers} browser${snap.stagehand.browsers === 1 ? "" : "s"}`} />
                <Tile label="Dev servers" value={`${snap.stagehand.devServerTasks} / ${snap.policies.maxDevServerTasks} tasks`} sub={`${snap.resources.filter((r) => r.kind === "worktree").length} worktrees · ${gb(disk)} on disk`} tone={snap.stagehand.devServerTasks > snap.policies.maxDevServerTasks ? "warn" : undefined} />
            </div>
            {groups.map((g) => (
                <section className={`card usage-table res-group${g.kind === "orphan" ? " res-orphans" : ""}`} key={g.kind}>
                    <h2>
                        {KIND_LABEL[g.kind]}
                        {g.kind !== "orphan" && g.rows.length > 1 ? "s" : ""} <span className="chip">{g.rows.length}</span>
                        {g.kind === "orphan" && <span className="field-hint"> — running on the host, but no task, service row or session explains them</span>}
                    </h2>
                    <table>
                        <thead>
                            <tr>
                                <th>What</th>
                                <th>Owner</th>
                                <th>Where</th>
                                <th>RSS</th>
                                <th>CPU</th>
                                <th>{g.kind === "worktree" ? "Disk" : "Age"}</th>
                                <th>Idle</th>
                                <th>Policy</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {g.rows.map((r) => (
                                <tr key={r.id} className={r.policy.verdict === "stop" && !r.pinned ? "res-due" : ""}>
                                    <td className="usage-label"><b>{r.label}</b>{r.top && <small title={r.top}>{r.top.length > 60 ? `${r.top.slice(0, 60)}…` : r.top}</small>}</td>
                                    <td><Owner r={r} /></td>
                                    <td className="mono res-where">
                                        {r.tmux && <span title="tmux session">{r.tmux}</span>}
                                        {r.pid != null && <span title="pid"> pid {r.pid}</span>}
                                        {r.port != null && !r.label.includes(`:${r.port}`) && <span title="port"> :{r.port}</span>}
                                        {r.path && !r.tmux && r.kind !== "service" && <span title={r.path}> {r.path.replace(/^\/Users\/[^/]+/, "~").split("/").slice(-2).join("/")}</span>}
                                    </td>
                                    <td className="mono">{r.procs ? gb(r.rssMb) : <span className="quiet">—</span>}</td>
                                    <td className="mono">{r.procs ? `${r.cpuPct}%` : <span className="quiet">—</span>}</td>
                                    <td className="mono">{g.kind === "worktree" ? (r.diskMb == null ? <span className="quiet">measuring…</span> : gb(r.diskMb)) : ago(r.ageMs)}</td>
                                    <td className="mono">{ago(r.idleMs)}</td>
                                    <td><Verdict r={r} /></td>
                                    <td className="res-actions">
                                        {r.kind !== "run" && r.kind !== "worktree" && (
                                            <>
                                                <button className="tiny" disabled={!!busy} title={r.pinned ? "Let the policy apply again" : "Never stopped by the policy"} onClick={() => void act(r.id, () => api.pinResource(r.id, !r.pinned))}>{r.pinned ? "unpin" : "pin"}</button>
                                                <button className="tiny danger" disabled={!!busy} onClick={() => void act(r.id, () => api.stopResource(r.id))}>stop</button>
                                            </>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            ))}
            {snap.resources.length === 0 && <div className="quiet">Nothing running that Stagehand started.</div>}
            <Policies value={snap.policies} onSaved={() => void load(true)} onError={onError} />
            <section className="card usage-table">
                <h2>Recent actions <span className="chip">{snap.events.length}</span></h2>
                {snap.events.length === 0 && <div className="quiet">nothing stopped yet</div>}
                {snap.events.length > 0 && (
                    <table>
                        <thead><tr><th>When</th><th>What</th><th>Task</th><th>Action</th><th>Why</th><th>RSS</th></tr></thead>
                        <tbody>
                            {snap.events.map((e) => (
                                <tr key={e.id}>
                                    <td className="mono">{ago(Date.now() - Date.parse(e.at))} ago</td>
                                    <td><b>{e.label}</b> <span className="chip">{KIND_LABEL[e.kind as ResourceKind] ?? e.kind}</span></td>
                                    <td className="mono">{e.task_id ? e.task_id.slice(0, 8) : "—"}</td>
                                    <td>{e.action}</td>
                                    <td className="res-why">{e.reason}</td>
                                    <td className="mono">{e.rss_mb != null ? gb(e.rss_mb) : "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
};
