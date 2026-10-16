import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Resource, type ResourceEvent, type ResourceKind, type ResourcePolicies, type ResourceSnapshot } from "./api";
import { hours } from "./Analytics";
import { Badge, Button, Chip, EmptyState, Icon, Input, Notice, Skeleton, Tabs, type Tone } from "@vortex/ds";
import { DataTable, type DataColumn } from "./components/DataTable";
import { CheckField, EntityForm, Field, useDraft } from "./components/EntityView";
import { PageHeader } from "./components/PageHeader";
import { Section } from "./components/Panel";
import { StatRow, StatTile } from "./components/StatTile";
import "./resources.css";

// Everything Vortex has started on this host — dev servers, agent runs, terminals, browsers, worktrees — with what
// each costs (RSS, CPU, disk), who owns it, what the policy will do with it and when. Three tabs: the running
// resources (tiles and one table, stop and pin per row), the Policies, and the Recent actions of the reaper.

const gb = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const ago = (ms: number | null): string => (ms == null ? "—" : ms < 60_000 ? "now" : hours(ms));
const since = (ms: number): string => (ms < 60_000 ? "just now" : `${hours(ms)} ago`);
const KIND_LABEL: Record<ResourceKind, string> = {
    service: "Dev server",
    dependency: "Dependency",
    run: "Agent run",
    terminal: "Terminal",
    session: "Session",
    login: "Login helper",
    browser: "QA browser",
    clone: "Chrome copy",
    worktree: "Worktree",
    database: "Database",
    orphan: "Orphan",
};
const WORKTREE_IDLE_HINT = "Time since the task last changed: a stage, a status, a message or any other update. For a worktree this is how long it has sat unused; the task's code stays on disk the whole time.";

type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

// Verdict categories are the filter values; the chip adds the countdown.
const verdictOf = (r: Resource): "Pinned" | "Keep" | "Stops soon" | "Stopping" => {
    if (r.pinned) return "Pinned";
    if (r.policy.verdict === "keep") return "Keep";
    return (r.policy.dueAt ? Date.parse(r.policy.dueAt) - Date.now() : 0) <= 0 ? "Stopping" : "Stops soon";
};
const Verdict = ({ r }: { r: Resource }) => {
    const v = verdictOf(r);
    if (v === "Pinned") return <Chip tone="accent" title={r.policy.reason}>Pinned</Chip>;
    if (v === "Keep") return <Chip title={r.policy.reason}>Keep</Chip>;
    const due = Date.parse(r.policy.dueAt ?? "") - Date.now();
    return <Chip tone={v === "Stopping" ? "bad" : "warn"} title={r.policy.reason}>{v === "Stopping" ? "Stopping now" : `Stops in ${hours(due)}`}</Chip>;
};

// database:<envId>:<name>
const dbTarget = (r: Resource): { envId: string; name: string } => {
    const [, envId = "", ...rest] = r.id.split(":");
    return { envId, name: rest.join(":") };
};
// What can be pinned or stopped by hand: not a run (it ends with its stage), not a worktree or a database.
const stoppable = (r: Resource): boolean => r.kind !== "run" && r.kind !== "worktree" && r.kind !== "database";

const Where = ({ r }: { r: Resource }) => (
    <span className="res-where">
        {r.tmux && <span title="tmux session">{r.tmux}</span>}
        {r.pid != null && <span title="pid"> pid {r.pid}</span>}
        {r.port != null && !r.label.includes(`:${r.port}`) && <span title="port"> :{r.port}</span>}
        {r.path && !r.tmux && r.kind !== "service" && <span title={r.path}> {r.path.replace(/^\/Users\/[^/]+/, "~").split("/").slice(-2).join("/")}</span>}
    </span>
);

const RowActions = ({ r, busy, act }: { r: Resource; busy: string | null; act: Act }) => (
    <span className="res-actions">
        {stoppable(r) && (
            <>
                <Button size="sm" disabled={!!busy} title={r.pinned ? "Let the policy apply again" : "Never stopped by the policy"} onClick={() => void act(r.id, () => api.pinResource(r.id, !r.pinned))}>{r.pinned ? "Unpin" : "Pin"}</Button>
                <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void act(r.id, () => api.stopResource(r.id))}>Stop</Button>
            </>
        )}
        {r.kind === "database" && r.owner.status === "template" && (
            <Button size="sm" disabled={!!busy} title="Migrate the template to the environment's base branch" onClick={() => void act(r.id, () => api.refreshTemplate(dbTarget(r).envId))}>{busy === r.id ? "Refreshing…" : "Refresh"}</Button>
        )}
        {r.kind === "database" && r.owner.status === "orphan" && (
            <Button size="sm" variant="danger" disabled={!!busy} title="No task owns this database" onClick={() => { if (confirm(`Drop database ${dbTarget(r).name}?`)) void act(r.id, () => api.dropEnvDb(dbTarget(r).envId, dbTarget(r).name)); }}>{busy === r.id ? "Dropping…" : "Drop"}</Button>
        )}
    </span>
);

const ownerLabel = (r: Resource): string => (r.owner.type === "none" ? "" : r.owner.name ?? r.owner.id?.slice(0, 8) ?? "?");
const ownerStatus = (r: Resource): string => [r.owner.stage, r.owner.status].filter((x): x is string => !!x).map((x) => x.replace(/_/g, " ")).join(" · ");

const Running = ({ rows, busy, act }: { rows: Resource[]; busy: string | null; act: Act }) => {
    const columns = useMemo<DataColumn<Resource>[]>(() => [
        { key: "kind", label: "Kind", value: (r) => KIND_LABEL[r.kind] },
        { key: "owner", label: "Owner", value: ownerLabel, render: (r) => (r.owner.type === "none" ? <span className="res-quiet">Nobody</span> : <b>{ownerLabel(r)}</b>), filter: false },
        { key: "ownerStatus", label: "Owner status", value: ownerStatus, render: (r) => ownerStatus(r) || <span className="res-quiet">—</span>, defaultHidden: true },
        { key: "what", label: "What", kind: "label", value: (r) => r.label, render: (r) => <b title={r.top ?? undefined}>{r.label}</b>, filter: false },
        { key: "where", label: "Where", value: (r) => [r.tmux, r.pid != null ? `pid ${r.pid}` : "", r.port != null ? `:${r.port}` : "", r.path ?? ""].filter(Boolean).join(" "), render: (r) => <Where r={r} />, filter: false, defaultHidden: true },
        { key: "memory", label: "Memory", kind: "num", value: (r) => (r.procs ? r.rssMb : null), render: (r) => (r.procs ? gb(r.rssMb) : "—") },
        { key: "cpu", label: "CPU", kind: "num", value: (r) => (r.procs ? r.cpuPct : null), render: (r) => (r.procs ? `${r.cpuPct}%` : "—") },
        { key: "disk", label: "Disk", kind: "num", value: (r) => r.diskMb, render: (r) => (r.diskMb != null ? gb(r.diskMb) : r.kind === "worktree" || r.kind === "database" ? <span className="res-quiet">measuring…</span> : "—") },
        { key: "age", label: "Age", kind: "num", value: (r) => r.ageMs, render: (r) => ago(r.ageMs), defaultHidden: true },
        { key: "idle", label: "Idle", kind: "num", value: (r) => r.idleMs, render: (r) => ago(r.idleMs), hint: WORKTREE_IDLE_HINT },
        { key: "policy", label: "Policy", value: verdictOf, render: (r) => <Verdict r={r} /> },
        { key: "reason", label: "Reason", value: (r) => r.policy.reason, filter: false, defaultHidden: true },
        { key: "actions", label: "", render: (r) => <RowActions r={r} busy={busy} act={act} /> },
    ], [busy, act]);
    return (
        <DataTable
            embedded
            title="Running on this host"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            defaultSort={{ key: "memory", desc: true }}
            storageKey="resources"
            bulkActions={(selected, clear) => {
                const hand = selected.filter(stoppable);
                return (
                    <>
                        <Button size="sm" disabled={!!busy || hand.length === 0} onClick={() => void act("pin", async () => { for (const r of hand) await api.pinResource(r.id, true); }).then(clear)}>Pin</Button>
                        <Button size="sm" variant="danger" disabled={!!busy || hand.length === 0} onClick={() => { if (confirm(`Stop ${hand.length} resource${hand.length === 1 ? "" : "s"}?`)) void act("stop", async () => { for (const r of hand) await api.stopResource(r.id); }).then(clear); }}>Stop {hand.length}</Button>
                    </>
                );
            }}
            empty={<EmptyState icon="cpu" title="Nothing running">Vortex has not started anything on this host.</EmptyState>}
        />
    );
};

const Events = ({ events }: { events: ResourceEvent[] }) => {
    const columns = useMemo<DataColumn<ResourceEvent>[]>(() => [
        { key: "at", label: "When", value: (e) => Date.parse(e.at), render: (e) => since(Date.now() - Date.parse(e.at)) },
        { key: "what", label: "What", kind: "label", value: (e) => e.label, filter: false },
        { key: "kind", label: "Kind", value: (e) => KIND_LABEL[e.kind as ResourceKind] ?? e.kind },
        { key: "task", label: "Task", value: (e) => (e.task_id ? e.task_id.slice(0, 8) : ""), render: (e) => (e.task_id ? <code>{e.task_id.slice(0, 8)}</code> : "—"), filter: false },
        { key: "action", label: "Action", value: (e) => e.action },
        { key: "why", label: "Why", value: (e) => e.reason, filter: false },
        { key: "rss", label: "Memory", kind: "num", value: (e) => e.rss_mb, render: (e) => (e.rss_mb != null ? gb(e.rss_mb) : "—") },
    ], []);
    return (
        <DataTable
            embedded
            title="Recent actions"
            columns={columns}
            rows={events}
            rowKey={(e) => String(e.id)}
            selectable={false}
            defaultSort={{ key: "at", desc: true }}
            storageKey="resource-events"
            empty={<EmptyState icon="checkCircle" title="Nothing stopped yet">The cleanup has not touched anything.</EmptyState>}
        />
    );
};

const NumField = ({ label, hint, value, onChange, min = 0 }: { label: string; hint?: string; value: number; onChange: (n: number) => void; min?: number }) => (
    <Field label={label} {...(hint ? { hint } : {})}>
        <Input type="number" min={min} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
);

const Policies = ({ value, onSaved, onError }: { value: ResourcePolicies; onSaved: () => void; onError: (m: string) => void }) => {
    const d = useDraft(() => value, [value]);
    const [saving, setSaving] = useState(false);
    const p = d.value;
    const num = (k: keyof ResourcePolicies) => (n: number) => d.patch({ [k]: n } as Partial<ResourcePolicies>);
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
        <div className="ev-body">
            <EntityForm dirty={d.dirty} saving={saving} onSave={save} onDiscard={d.reset}>
                <Section title="Cleanup" hint="What the reaper does on its own, every 20 seconds. A pinned resource is never touched; a dev server you start yourself is pinned until you stop it.">
                    <div className="res-fields">
                        <CheckField label="Automatic cleanup" hint="Off means the page only shows resources and lets you stop them by hand." checked={p.enabled} onChange={(on) => d.patch({ enabled: on })} />
                        <NumField label="Parked task keeps its dev servers for (min)" value={p.idleServiceMinutes} onChange={num("idleServiceMinutes")} />
                        <NumField label="Task past QA keeps them for (min)" hint="Tasks in the PR stages, done or stopped." value={p.doneServiceMinutes} onChange={num("doneServiceMinutes")} />
                        <NumField label="A fresh start settles for (min)" hint="Never stopped before that, whatever the memory pressure." value={p.settleMinutes} onChange={num("settleMinutes")} />
                    </div>
                </Section>
                <Section title="Limits">
                    <div className="res-fields">
                        <NumField label="Tasks that may hold dev servers at once" min={1} value={p.maxDevServerTasks} onChange={num("maxDevServerTasks")} />
                        <NumField label="Task session rotates above (MB)" hint="Size of the conversation transcript; 0 means never. A resumed run pays for the whole conversation every time." value={p.maxSessionMb} onChange={num("maxSessionMb")} />
                    </div>
                </Section>
                <Section title="Idle limits">
                    <div className="res-fields">
                        <NumField label="Task terminal (h)" value={p.terminalIdleHours} onChange={num("terminalIdleHours")} />
                        <NumField label="Session (h)" value={p.sessionIdleHours} onChange={num("sessionIdleHours")} />
                        <NumField label="Login helper lifetime (min)" value={p.loginMinutes} onChange={num("loginMinutes")} />
                        <NumField label="Orphan grace (min)" value={p.orphanMinutes} onChange={num("orphanMinutes")} />
                    </div>
                </Section>
                <Section title="Memory pressure" hint="Under pressure every grace period becomes zero and idle terminals go after 30 minutes.">
                    <div className="res-fields">
                        <NumField label="Available memory below (MB)" value={p.minAvailableMb} onChange={num("minAvailableMb")} />
                        <NumField label="Swap above (MB)" value={p.maxSwapMb} onChange={num("maxSwapMb")} />
                    </div>
                </Section>
            </EntityForm>
        </div>
    );
};

type ResourcesTab = "dashboard" | "policies" | "actions";
const header = (tabs?: ReactNode, meta?: ReactNode, actions?: ReactNode) => (
    <PageHeader title="Resources" {...(meta ? { meta } : {})} {...(actions ? { actions } : {})}>{tabs}</PageHeader>
);

// The open tab is routed (#/resources/<tab>).
export const ResourcesPage = ({ tab: tabArg, onTab: setTab, onError }: { tab: string | undefined; onTab: (t: ResourcesTab) => void; onError: (m: string) => void }) => {
    const [snap, setSnap] = useState<ResourceSnapshot | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const tab: ResourcesTab = tabArg === "policies" || tabArg === "actions" ? tabArg : "dashboard";
    const load = useCallback((refresh = false) => api.resources(refresh).then(setSnap).catch((e: Error) => onError(e.message)), [onError]);
    useEffect(() => {
        void load();
        const t = setInterval(() => void load(), 10_000);
        return () => clearInterval(t);
    }, [load]);
    const act = useCallback<Act>(async (label, fn) => {
        setBusy(label);
        try {
            await fn();
            await load(true);
        } catch (e) {
            onError((e as Error).message);
        } finally {
            setBusy(null);
        }
    }, [load, onError]);
    const reload = useCallback(() => void load(true), [load]);

    if (!snap) return <div className="resources-page" aria-busy="true">{header()}<Skeleton height={84} /><Skeleton height={280} /></div>;

    const h = snap.host;
    const orphans = snap.resources.filter((r) => r.kind === "orphan");
    const due = snap.resources.filter((r) => r.policy.verdict === "stop" && r.kind !== "orphan");
    const sweepCount = orphans.length + due.length;
    const worktreeDisk = snap.resources.filter((r) => r.kind === "worktree").reduce((s, r) => s + (r.diskMb ?? 0), 0);
    const d = snap.disk ?? null;
    const diskTone: Tone = d ? (d.freeMb < d.totalMb * 0.05 ? "bad" : d.freeMb < d.totalMb * 0.15 ? "warn" : "neutral") : "neutral";
    const ramTone: Tone = h.pressure === "critical" ? "bad" : h.pressure === "warn" ? "warn" : "neutral";
    const swapTone: Tone = h.swapUsedMb > snap.policies.maxSwapMb ? "bad" : h.swapUsedMb > snap.policies.maxSwapMb / 2 ? "warn" : "neutral";

    return (
        <div className="resources-page">
            {header(
                <Tabs
                    className="ev-tabs"
                    active={tab}
                    onChange={(k) => setTab(k as ResourcesTab)}
                    items={[
                        { key: "dashboard", label: "Running" },
                        { key: "policies", label: "Policies" },
                        { key: "actions", label: <>Recent actions {snap.events.length > 0 && <Badge>{snap.events.length}</Badge>}</> },
                    ]}
                />,
                <span className="res-observed">Observed {since(Date.now() - Date.parse(snap.at))}</span>,
                <>
                    <Button disabled={!!busy} onClick={() => void act("refresh", () => load(true))}><Icon name="refresh" />Refresh</Button>
                    <Button variant="danger" disabled={!!busy || sweepCount === 0} title="Stops every orphan and every resource whose policy already says stop" onClick={() => void act("sweep", () => api.sweepResources())}>
                        Clean up{sweepCount ? ` (${sweepCount})` : ""}
                    </Button>
                </>,
            )}
            {tab === "dashboard" && (
                <>
                    {h.pressure !== "ok" && (
                        <Notice tone={h.pressure === "critical" ? "bad" : "warn"}>
                            Memory pressure: {h.pressureReason}. {h.pressure === "critical" ? "Grace periods are zero, so parked dev servers and idle terminals stop now." : "Grace periods still apply."}
                        </Notice>
                    )}
                    {orphans.length > 0 && (
                        <Notice tone="warn">
                            {orphans.length} process{orphans.length === 1 ? "" : "es"} run on the host, but no task, dev server or session explains {orphans.length === 1 ? "it" : "them"}. Clean up stops {orphans.length === 1 ? "it" : "them"}.
                        </Notice>
                    )}
                    <StatRow>
                        <StatTile icon="cpu" tone={ramTone} label="Host memory" value={`${gb(h.usedMb)} used`} sub={`${gb(h.availableMb)} available of ${gb(h.totalMb)} · ${gb(h.compressedMb)} compressed`} />
                        <StatTile icon="layers" tone={swapTone} label="Swap" value={gb(h.swapUsedMb)} sub={`of ${gb(h.swapTotalMb)}`} />
                        <StatTile icon="server" label="Vortex processes" value={gb(snap.vortex.rssMb)} sub={`${snap.vortex.procs} processes · ${snap.vortex.runs} agent run${snap.vortex.runs === 1 ? "" : "s"} · ${snap.vortex.browsers} browser${snap.vortex.browsers === 1 ? "" : "s"} · dev servers for ${snap.vortex.devServerTasks} of ${snap.policies.maxDevServerTasks} tasks`} />
                        <StatTile icon="folder" tone={diskTone} label="Host storage" value={d ? `${gb(d.freeMb)} free` : "—"} sub={d ? `of ${gb(d.totalMb)} (${Math.round((1 - d.freeMb / d.totalMb) * 100)}% used) · worktrees ${gb(worktreeDisk)}` : "Not reported by this server"} />
                    </StatRow>
                    <Running rows={snap.resources} busy={busy} act={act} />
                </>
            )}
            {tab === "policies" && <Policies value={snap.policies} onSaved={reload} onError={onError} />}
            {tab === "actions" && <Events events={snap.events} />}
        </div>
    );
};
