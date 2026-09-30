import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Resource, type ResourceKind, type ResourcePolicies, type ResourceSnapshot } from "./api";
import { hours } from "./Analytics";

// Everything Stagehand has started on this host — dev servers, agent runs, terminals, browsers, worktrees — with what
// each costs (RSS, CPU, disk), who owns it, what the policy will do with it and when. Three tabs: the Dashboard (the
// tiles and the tables, stop and pin per row), the Policies, and the Recent actions of the reaper.

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
    return <b>{o.name ?? o.id?.slice(0, 8) ?? "?"}</b>;
};
// The owning task's stage and status, in a column of their own.
const OwnerStatus = ({ r }: { r: Resource }) => {
    const parts = [r.owner.stage, r.owner.status].filter((x): x is string => !!x).map((x) => x.replace(/_/g, " "));
    return parts.length ? <span className="res-sub">{parts.join(" · ")}</span> : <span className="quiet">—</span>;
};

type SortKey = "rss" | "cpu" | "age" | "idle" | "disk";
type Sort = { key: SortKey; desc: boolean };
const sortValue = (r: { rssMb: number; cpuPct: number; ageMs: number; idleMs: number | null; diskMb: number | null }, k: SortKey): number =>
    k === "rss" ? r.rssMb : k === "cpu" ? r.cpuPct : k === "age" ? r.ageMs : k === "idle" ? (r.idleMs ?? -1) : (r.diskMb ?? -1);
const sortBy = <T extends { rssMb: number; cpuPct: number; ageMs: number; idleMs: number | null; diskMb: number | null }>(rows: T[], sort: Sort | null): T[] =>
    sort ? [...rows].sort((a, b) => (sortValue(a, sort.key) - sortValue(b, sort.key)) * (sort.desc ? -1 : 1)) : rows;
// A column header that sorts its table: first click descending (biggest first), second ascending, third off.
const SortTh = ({ k, label, sort, onSort, hint }: { k: SortKey; label: string; sort: Sort | null; onSort: (s: Sort | null) => void; hint?: string }) => (
    <th className="sortable" title={hint} onClick={() => onSort(sort?.key !== k ? { key: k, desc: true } : sort.desc ? { key: k, desc: false } : null)}>
        {label}{hint && <span className="hint-mark"> ⓘ</span>} {sort?.key === k ? (sort.desc ? "▼" : "▲") : ""}
    </th>
);
const WORKTREE_IDLE_HINT = "Time since the task last changed — a stage, a status, a message or any other update. How long this worktree has sat unused; the task's code stays on disk the whole time.";

const ResourceRow = ({ r, busy, act, worktree = false, nested = false }: { r: Resource; busy: string | null; act: (label: string, fn: () => Promise<unknown>) => Promise<void>; worktree?: boolean; nested?: boolean }) => (
    <tr className={`${r.policy.verdict === "stop" && !r.pinned ? "res-due" : ""}${nested ? " res-nested" : ""}`}>
        {nested ? <><td /><td /></> : <><td><Owner r={r} /></td><td><OwnerStatus r={r} /></td></>}
        {!worktree && <td className="usage-label"><b>{r.label}</b>{r.top && <small title={r.top}>{r.top.length > 60 ? `${r.top.slice(0, 60)}…` : r.top}</small>}</td>}
        <td className="mono res-where">
            {r.tmux && <span title="tmux session">{r.tmux}</span>}
            {r.pid != null && <span title="pid"> pid {r.pid}</span>}
            {r.port != null && !r.label.includes(`:${r.port}`) && <span title="port"> :{r.port}</span>}
            {r.path && !r.tmux && r.kind !== "service" && <span title={r.path}> {r.path.replace(/^\/Users\/[^/]+/, "~").split("/").slice(-2).join("/")}</span>}
        </td>
        {worktree ? (
            <td className="mono">{r.diskMb == null ? <span className="quiet">measuring…</span> : gb(r.diskMb)}</td>
        ) : (
            <>
                <td className="mono">{r.procs ? gb(r.rssMb) : <span className="quiet">—</span>}</td>
                <td className="mono">{r.procs ? `${r.cpuPct}%` : <span className="quiet">—</span>}</td>
                <td className="mono">{ago(r.ageMs)}</td>
            </>
        )}
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
);

// Dev servers grouped under their task: one row per task with the sums (RSS, CPU) and the extremes (oldest start,
// most recent activity), expandable into one row per BE / FE / component.
const DevServers = ({ rows, tasks, max, busy, act }: { rows: Resource[]; tasks: number; max: number; busy: string | null; act: (label: string, fn: () => Promise<unknown>) => Promise<void> }) => {
    const [sort, setSort] = useState<Sort | null>({ key: "rss", desc: true });
    const [open, setOpen] = useState<Set<string>>(new Set());
    const groups = useMemo(() => {
        const m = new Map<string, Resource[]>();
        for (const r of rows) {
            const k = r.owner.type === "task" && r.owner.id ? r.owner.id : `other:${r.id}`;
            m.set(k, [...(m.get(k) ?? []), r]);
        }
        return [...m.entries()].map(([key, rs]) => ({
            key,
            rows: sortBy(rs, sort),
            owner: rs[0]!,
            rssMb: rs.reduce((n, r) => n + r.rssMb, 0),
            cpuPct: Math.round(rs.reduce((n, r) => n + r.cpuPct, 0) * 10) / 10,
            ageMs: Math.max(...rs.map((r) => r.ageMs)),
            idleMs: rs.some((r) => r.idleMs != null) ? Math.min(...rs.map((r) => r.idleMs ?? Number.MAX_SAFE_INTEGER)) : null,
            diskMb: null,
            due: rs.some((r) => r.policy.verdict === "stop" && !r.pinned),
        }));
    }, [rows, sort]);
    const sorted = sortBy(groups, sort);
    return (
        <section className="card usage-table res-group">
            <h2>Dev Servers <span className="chip">{tasks} / {max} tasks</span> <span className="chip">{rows.length} server{rows.length === 1 ? "" : "s"}</span></h2>
            <table>
                <thead>
                    <tr>
                        <th>Owner</th>
                        <th>Owner status</th>
                        <th>What</th>
                        <th>Where</th>
                        <SortTh k="rss" label="RSS" sort={sort} onSort={setSort} />
                        <SortTh k="cpu" label="CPU" sort={sort} onSort={setSort} />
                        <SortTh k="age" label="Age" sort={sort} onSort={setSort} />
                        <SortTh k="idle" label="Idle" sort={sort} onSort={setSort} />
                        <th>Policy</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((g) => {
                        const expanded = open.has(g.key);
                        return [
                            <tr key={g.key} className={`res-task${g.due ? " res-due" : ""}`} onClick={() => setOpen((s) => { const n = new Set(s); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n; })}>
                                <td><b>{expanded ? "▾" : "▸"}</b> <Owner r={g.owner} /></td>
                                <td><OwnerStatus r={g.owner} /></td>
                                <td className="usage-label"><b>{g.rows.map((r) => r.label.split(" ")[0]).join(" + ")}</b></td>
                                <td className="mono res-where">{g.rows.length} server{g.rows.length === 1 ? "" : "s"}</td>
                                <td className="mono">{gb(g.rssMb)}</td>
                                <td className="mono">{g.cpuPct}%</td>
                                <td className="mono">{ago(g.ageMs)}</td>
                                <td className="mono">{ago(g.idleMs)}</td>
                                <td>{g.due ? <span className="chip warn">some stop soon</span> : <Verdict r={g.rows[0]!} />}</td>
                                <td />
                            </tr>,
                            ...(expanded ? g.rows.map((r) => <ResourceRow key={r.id} r={r} busy={busy} act={act} nested />) : []),
                        ];
                    })}
                </tbody>
            </table>
        </section>
    );
};

// Every other kind of resource (agent runs, browsers, terminals, sessions, orphans): one table each, sortable.
const Group = ({ kind, rows, busy, act }: { kind: ResourceKind; rows: Resource[]; busy: string | null; act: (label: string, fn: () => Promise<unknown>) => Promise<void> }) => {
    const [sort, setSort] = useState<Sort | null>(null);
    return (
        <section className={`card usage-table res-group${kind === "orphan" ? " res-orphans" : ""}`}>
            <h2>
                {KIND_LABEL[kind]}
                {kind !== "orphan" && rows.length > 1 ? "s" : ""} <span className="chip">{rows.length}</span>
                {kind === "orphan" && <span className="field-hint"> — running on the host, but no task, service row or session explains them</span>}
            </h2>
            <table>
                <thead>
                    <tr>
                        <th>Owner</th>
                        <th>Owner status</th>
                        <th>What</th>
                        <th>Where</th>
                        <SortTh k="rss" label="RSS" sort={sort} onSort={setSort} />
                        <SortTh k="cpu" label="CPU" sort={sort} onSort={setSort} />
                        <SortTh k="age" label="Age" sort={sort} onSort={setSort} />
                        <SortTh k="idle" label="Idle" sort={sort} onSort={setSort} />
                        <th>Policy</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>{sortBy(rows, sort).map((r) => <ResourceRow key={r.id} r={r} busy={busy} act={act} />)}</tbody>
            </table>
        </section>
    );
};

const Worktrees = ({ rows, busy, act }: { rows: Resource[]; busy: string | null; act: (label: string, fn: () => Promise<unknown>) => Promise<void> }) => {
    const [sort, setSort] = useState<Sort | null>({ key: "disk", desc: true });
    const [expanded, setExpanded] = useState(false);
    const total = rows.reduce((n, r) => n + (r.diskMb ?? 0), 0);
    return (
        <section className="card usage-table res-group">
            <h2 className="res-toggle" onClick={() => setExpanded((x) => !x)}>{expanded ? "▾" : "▸"} Worktrees <span className="chip">{rows.length}</span> <span className="chip">{gb(total)} on disk</span></h2>
            {expanded && <table>
                <thead>
                    <tr>
                        <th>Owner</th>
                        <th>Owner status</th>
                        <th>Where</th>
                        <SortTh k="disk" label="Disk" sort={sort} onSort={setSort} />
                        <SortTh k="idle" label="Idle" sort={sort} onSort={setSort} hint={WORKTREE_IDLE_HINT} />
                        <th>Policy</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>{sortBy(rows, sort).map((r) => <ResourceRow key={r.id} r={r} busy={busy} act={act} worktree />)}</tbody>
            </table>}
        </section>
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
                    <label>Task session rotates above (MB of transcript; 0 = never) — a resumed run pays for the whole conversation every time <input type="number" min={0} value={p.maxSessionMb} onChange={num("maxSessionMb")} /></label>
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
    const [tab, setTab] = useState<"dashboard" | "policies" | "actions">("dashboard");
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
    const services = snap.resources.filter((r) => r.kind === "service");
    const worktrees = snap.resources.filter((r) => r.kind === "worktree");
    const groups = KIND_ORDER.filter((k) => k !== "service" && k !== "worktree").map((k) => ({ kind: k, rows: snap.resources.filter((r) => r.kind === k) })).filter((g) => g.rows.length);
    const worktreeDisk = worktrees.reduce((s, r) => s + (r.diskMb ?? 0), 0);
    const d = snap.disk ?? null;
    const diskTone = d ? (d.freeMb < d.totalMb * 0.05 ? "bad" : d.freeMb < d.totalMb * 0.15 ? "warn" : "ok") : undefined;
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
            <div className="subtabs">
                <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>Dashboard</button>
                <button className={tab === "policies" ? "active" : ""} onClick={() => setTab("policies")}>Policies</button>
                <button className={tab === "actions" ? "active" : ""} onClick={() => setTab("actions")}>Recent actions <span className="chip">{snap.events.length}</span></button>
            </div>
            {tab === "dashboard" && (
                <>
                    {h.pressure !== "ok" && <div className={`blocked-box ${h.pressure === "critical" ? "" : "warn"}`}>Memory pressure: {h.pressureReason}. {h.pressure === "critical" ? "Grace periods are zero — parked dev servers and idle terminals stop now." : "Grace periods still apply."}</div>}
                    <div className="tiles">
                        <Tile label="Host RAM" value={`${gb(h.usedMb)} used`} sub={`${gb(h.availableMb)} available of ${gb(h.totalMb)} · ${gb(h.compressedMb)} compressed`} tone={tone} />
                        <Tile label="Swap" value={gb(h.swapUsedMb)} sub={`of ${gb(h.swapTotalMb)}`} tone={h.swapUsedMb > snap.policies.maxSwapMb ? "bad" : h.swapUsedMb > snap.policies.maxSwapMb / 2 ? "warn" : "ok"} />
                        <Tile label="Stagehand processes" value={gb(snap.stagehand.rssMb)} sub={`${snap.stagehand.procs} processes · ${snap.stagehand.runs} agent run${snap.stagehand.runs === 1 ? "" : "s"} · ${snap.stagehand.browsers} browser${snap.stagehand.browsers === 1 ? "" : "s"}`} />
                        <Tile
                            label="Host storage"
                            value={d ? `${gb(d.freeMb)} free` : "—"}
                            sub={d ? `of ${gb(d.totalMb)} (${Math.round((1 - d.freeMb / d.totalMb) * 100)} % used) · worktrees ${gb(worktreeDisk)}` : "not reported by this server"}
                            {...(diskTone ? { tone: diskTone } : {})}
                        />
                    </div>
                    {orphans.length > 0 && groups.filter((g) => g.kind === "orphan").map((g) => <Group key={g.kind} kind={g.kind} rows={g.rows} busy={busy} act={act} />)}
                    {services.length > 0 && <DevServers rows={services} tasks={snap.stagehand.devServerTasks} max={snap.policies.maxDevServerTasks} busy={busy} act={act} />}
                    {groups.filter((g) => g.kind !== "orphan").map((g) => <Group key={g.kind} kind={g.kind} rows={g.rows} busy={busy} act={act} />)}
                    {worktrees.length > 0 && <Worktrees rows={worktrees} busy={busy} act={act} />}
                    {snap.resources.length === 0 && <div className="quiet">Nothing running that Stagehand started.</div>}
                </>
            )}
            {tab === "policies" && <Policies value={snap.policies} onSaved={() => void load(true)} onError={onError} />}
            {tab === "actions" && (
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
            )}
        </div>
    );
};
