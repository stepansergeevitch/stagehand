import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, labelsOf, STAGE_LABEL, type Env, type FeedEvent, type Task } from "./api";
import { Badge, Button, Checkbox, Icon, Input, Kbd, Menu, Notice, Popover, Tabs } from "@vortex/ds";
import type { FeedType, FeedView, TaskFilter, TaskTab } from "./routes";
import { PageFrame } from "./components/AppShell";
import { PageHeader } from "./components/PageHeader";
import { FilterChip } from "./components/FilterChip";
import { ViewSwitch } from "./components/ViewSwitch";
import { useDismiss } from "./components/useDismiss";
import { age, needAction, taskState } from "./components/status";
import { feedBus } from "./feedBus";
import "./feed.css";

// The Feed (#/tasks/feed), the Tasks list's other view: what happened to the tasks, and what is owed. Same frame as the list
// (title with List | Feed, search, New task, environment tabs with an All tab first, filters). Needs you comes first and
// stays until the task no longer needs a human; below it the stream, grouped by day, with unseen events marked and a
// "New since" divider. Runs of updates from one task collapse into one row. New events never move rows under the pointer:
// while the stream is hovered or focused they wait behind a pill. Every Needs-you button is the Tasks list's (NEED_ACTIONS).
//
// Keys (Emacs): C-n / C-p move between rows, RET opens, C-s searches, C-c n makes a task, C-c s marks the row seen,
// C-c r shows waiting events, C-c l goes to the list, C-c C-c presses the row's button, C-x then ← / → switches environment.

const GLYPH: Record<string, string> = {
    design_ready: "D", questions: "?", user_review: "R", pr_drafts: "P", needs_review: "R", blocked: "!", failed: "✕", merge_failed: "M",
    stage_started: "▶", pr_waiting: "…", pr_green: "✓", pr_approved: "✓", checks_passed: "✓", pr_fix: "↻", rate_limited: "⏸", done: "✓", stopped: "■", created: "+",
};
const TONE: Record<FeedEvent["category"], string> = { needs_you: "warn", agent: "info", pr: "ok", system: "neutral", lifecycle: "neutral" };

const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const dayLabel = (iso: string): string => {
    const d = new Date(iso);
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(new Date()) - start(d)) / 86_400_000);
    return diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};
const canHold = (): boolean => window.matchMedia("(hover: hover)").matches;
const isTyping = (el: EventTarget | null): boolean => {
    const e = el as HTMLElement | null;
    return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable);
};

// One row of the stream: a single event, or a run of updates from one task.
type Item = { kind: "event"; event: FeedEvent } | { kind: "burst"; key: string; events: FeedEvent[] };

const FeedRow = ({ event: ev, showEnv, envName, primary, unseen, onOpen, onSeen }: {
    event: FeedEvent; showEnv: boolean; envName: string; primary: boolean; unseen: boolean;
    onOpen: (taskId: string, tab?: TaskTab) => void; onSeen: (id: string) => void;
}) => {
    const action = primary ? needAction(ev.kind, ev.stage) : undefined;
    const meta = ev.resolved_at ? `Handled at ${hhmm(ev.resolved_at)}` : ev.detail ?? ev.task_title ?? "";
    return (
        <div
            className={`feed-row${unseen ? " unseen" : ""}`}
            tabIndex={0}
            data-feed-row={ev.id}
            data-task={ev.task_id}
            onClick={() => onOpen(ev.task_id)}
            onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(ev.task_id); }}
        >
            <span className={`feed-ic ${TONE[ev.category]}${ev.kind === "failed" ? " bad" : ""}`} aria-hidden="true">{GLYPH[ev.kind] ?? "•"}</span>
            <div className="feed-body">
                <div className="feed-title">
                    {unseen && <span className="feed-new">New</span>}
                    {showEnv && <span className="feed-env">{envName}</span>}
                    {ev.ticket_id && <span className="mono feed-ticket">{ev.ticket_id}</span>}
                    {ev.text}
                </div>
                {meta && <div className="feed-meta">{meta}</div>}
            </div>
            <div className="feed-side">
                <span className="feed-hover">
                    {unseen && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onSeen(ev.id); }}>Mark seen</Button>}
                </span>
                <span className="feed-time" title={new Date(ev.at).toLocaleString()}>{age(ev.at)}</span>
                {action && <Button size="sm" variant={action.danger ? "danger" : "primary"} data-primary onClick={(e) => { e.stopPropagation(); onOpen(ev.task_id, action.tab); }}>{action.label}</Button>}
            </div>
        </div>
    );
};

export const FeedPage = ({ envs, envId, tasks, filter, feed, connected, onSelectEnv, onFilter, onFeed, onView, onNewTask, onOpen }: {
    envs: Env[];
    // undefined = every environment.
    envId: string | undefined;
    tasks: Task[];
    filter: TaskFilter;
    feed: FeedView;
    connected: boolean;
    onSelectEnv: (id: string | undefined) => void;
    onFilter: (filter: TaskFilter) => void;
    onFeed: (feed: FeedView) => void;
    onView: (v: "list") => void;
    onNewTask: () => void;
    onOpen: (taskId: string, tab?: TaskTab) => void;
}) => {
    const [events, setEvents] = useState<FeedEvent[] | null>(null);
    const [open, setOpen] = useState<FeedEvent[]>([]);
    const [more, setMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [queued, setQueued] = useState<FeedEvent[]>([]);
    const [holding, setHolding] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [digestOpen, setDigestOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const digestRef = useDismiss(digestOpen, () => setDigestOpen(false));
    const menuRef = useDismiss(menuOpen, () => setMenuOpen(false));
    const PAGE = 50;

    const load = useCallback(async () => {
        try {
            setError(null);
            const p = await api.feed({ ...(envId ? { env: envId } : {}), limit: PAGE });
            setEvents(p.events);
            setOpen(p.open);
            setMore(p.events.length >= PAGE);
            setQueued([]);
        } catch (e) {
            setError(String((e as Error).message ?? e));
            setEvents((cur) => cur ?? []);
        }
    }, [envId]);
    useEffect(() => { setEvents(null); void load(); }, [load]);

    const loadEarlier = async (): Promise<void> => {
        const last = events?.[events.length - 1];
        if (!last) return;
        const p = await api.feed({ ...(envId ? { env: envId } : {}), before: last.at, limit: PAGE });
        setEvents((cur) => [...(cur ?? []), ...p.events.filter((e) => !(cur ?? []).some((c) => c.id === e.id))]);
        setMore(p.events.length >= PAGE);
    };

    // A pushed event: a new row, or an update of one we have (resolved).
    const apply = useCallback((ev: FeedEvent) => {
        if (envId && ev.env_id !== envId) return;
        setEvents((cur) => {
            if (!cur) return cur;
            const i = cur.findIndex((c) => c.id === ev.id);
            if (i >= 0) return cur.map((c) => (c.id === ev.id ? ev : c));
            return [ev, ...cur];
        });
        setOpen((cur) => {
            const rest = cur.filter((c) => c.id !== ev.id);
            return ev.category === "needs_you" && !ev.resolved_at ? [ev, ...rest] : rest;
        });
    }, [envId]);
    useEffect(() => feedBus.subscribe((ev) => {
        // A resolved event leaves Needs you at once; a new one waits while the stream is held.
        if (holding && !ev.resolved_at && !events?.some((c) => c.id === ev.id)) setQueued((q) => [ev, ...q.filter((x) => x.id !== ev.id)]);
        else apply(ev);
    }), [apply, holding, events]);
    const showQueued = (): void => { for (const ev of [...queued].reverse()) apply(ev); setQueued([]); };

    const markSeen = (body: { ids?: string[]; taskId?: string; all?: boolean }): void => {
        const now = new Date().toISOString();
        setEvents((cur) => cur?.map((e) => ((body.all || body.ids?.includes(e.id) || (body.taskId && e.task_id === body.taskId)) && !e.seen_at ? { ...e, seen_at: now } : e)) ?? cur);
        setOpen((cur) => cur.map((e) => ((body.all || body.ids?.includes(e.id) || (body.taskId && e.task_id === body.taskId)) && !e.seen_at ? { ...e, seen_at: now } : e)));
        void api.feedSeen({ ...body, ...(body.all && envId ? { env: envId } : {}) }).catch(() => undefined);
    };
    const openTask = (taskId: string, tab?: TaskTab): void => { markSeen({ taskId }); onOpen(taskId, tab); };

    // Filters.
    const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
    const q = filter.q?.trim().toLowerCase();
    const keep = (e: FeedEvent): boolean => {
        if (feed.type && e.category !== feed.type) return false;
        if (!feed.type && !feed.lifecycle && (e.category === "lifecycle" || e.category === "system")) return false;
        if (filter.stage && e.stage !== filter.stage) return false;
        if (filter.label && !labelsOf(taskById.get(e.task_id) ?? { labels: null } as Task).some((l) => l.text === filter.label)) return false;
        if (q && ![e.text, e.ticket_id ?? "", e.task_title ?? "", e.detail ?? ""].some((v) => v.toLowerCase().includes(q))) return false;
        return true;
    };
    const openShown = open.filter(keep);
    const openIds = new Set(open.map((e) => e.id));
    const stream = (events ?? []).filter((e) => !openIds.has(e.id) && keep(e));
    const unseenEvents = [...(events ?? []).filter((e) => !e.seen_at), ...open.filter((e) => !e.seen_at && !(events ?? []).some((x) => x.id === e.id))];
    const filtered = !!(filter.q || filter.stage || filter.label || feed.type || feed.lifecycle);
    const labelOptions = [...new Set(tasks.filter((t) => !envId || t.env_id === envId).flatMap((t) => labelsOf(t).map((l) => l.text)))].sort();
    const envName = (id: string): string => envs.find((e) => e.id === id)?.name ?? "";

    // Rows: runs of 3+ updates from one task become one row; the unseen ones are marked.
    const items: Array<{ day: string; items: Item[] }> = [];
    {
        let i = 0;
        while (i < stream.length) {
            const e = stream[i]!;
            let j = i + 1;
            while (j < stream.length && stream[j]!.task_id === e.task_id && (e.category === "agent" || e.category === "pr") && (stream[j]!.category === "agent" || stream[j]!.category === "pr")) j++;
            const day = dayLabel(e.at);
            const item: Item = j - i >= 3 ? { kind: "burst", key: `${e.task_id}:${e.id}`, events: stream.slice(i, j) } : { kind: "event", event: e };
            if (item.kind === "burst") i = j;
            else i += 1;
            const last = items[items.length - 1];
            if (last && last.day === day) last.items.push(item);
            else items.push({ day, items: [item] });
        }
    }
    const newestUnseen = stream.filter((e) => !e.seen_at);
    const sinceAt = unseenEvents.length ? unseenEvents.reduce((a, b) => (a.at < b.at ? a : b)).at : null;
    const counts = {
        needs: unseenEvents.filter((e) => e.category === "needs_you").length,
        agent: unseenEvents.filter((e) => e.category === "agent").length,
        pr: unseenEvents.filter((e) => e.category === "pr").length,
        other: unseenEvents.filter((e) => e.category === "system" || e.category === "lifecycle").length,
    };
    const totalNeeds = tasks.filter((t) => taskState(t).group === "attention").length;
    const needsIn = (id: string) => tasks.filter((t) => t.env_id === id && taskState(t).group === "attention").length;
    const latestAt = (events ?? [])[0]?.at;

    // Emacs keys.
    const chord = useRef<{ prefix: "c" | "x"; at: number } | null>(null);
    const act = useRef({ onNewTask, onView, showQueued, onSelectEnv, envId, envs, markSeen });
    act.current = { onNewTask, onView, showQueued, onSelectEnv, envId, envs, markSeen };
    useEffect(() => {
        const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-feed-row]")];
        const onKey = (e: KeyboardEvent): void => {
            if (e.defaultPrevented || e.altKey || e.metaKey || document.querySelector("[role=dialog]")) return;
            const typing = isTyping(e.target);
            if (e.ctrlKey && e.code === "KeyG") {
                if (typing) (e.target as HTMLElement).blur();
                chord.current = null;
                return;
            }
            if (typing) return;
            const c = chord.current && Date.now() - chord.current.at < 2000 ? chord.current : null;
            chord.current = null;
            const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-feed-row]") ?? null;
            if (c?.prefix === "c") {
                if (e.code === "KeyN" && !e.ctrlKey) { e.preventDefault(); act.current.onNewTask(); }
                else if (e.code === "KeyL" && !e.ctrlKey) { e.preventDefault(); act.current.onView("list"); }
                else if (e.code === "KeyR" && !e.ctrlKey) { e.preventDefault(); act.current.showQueued(); }
                else if (e.code === "KeyS" && !e.ctrlKey) { e.preventDefault(); if (focused?.dataset.feedRow) act.current.markSeen({ ids: [focused.dataset.feedRow] }); }
                else if (e.code === "KeyC" && e.ctrlKey) { e.preventDefault(); focused?.querySelector<HTMLButtonElement>("button[data-primary]")?.click(); }
                return;
            }
            if (c?.prefix === "x") {
                const ids = [undefined, ...act.current.envs.map((x) => x.id)];
                const i = ids.indexOf(act.current.envId);
                if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); act.current.onSelectEnv(ids[i - 1]); }
                else if (e.key === "ArrowRight" && i < ids.length - 1) { e.preventDefault(); act.current.onSelectEnv(ids[i + 1]); }
                return;
            }
            if (e.ctrlKey && (e.code === "KeyC" || e.code === "KeyX") && !window.getSelection()?.toString()) {
                e.preventDefault();
                chord.current = { prefix: e.code === "KeyC" ? "c" : "x", at: Date.now() };
            } else if (e.ctrlKey && e.code === "KeyS") {
                e.preventDefault();
                document.querySelector<HTMLInputElement>(".tasks-search input")?.focus();
            } else if (e.ctrlKey && (e.code === "KeyN" || e.code === "KeyP")) {
                const all = rows();
                const at = focused ? all.indexOf(focused) : -1;
                const next = all[e.code === "KeyN" ? (at < 0 ? 0 : at + 1) : (at < 0 ? all.length - 1 : at - 1)];
                if (next) { e.preventDefault(); next.focus(); }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const typeChip = (key: FeedType | undefined, label: string, count?: number) => (
        <Button key={label} size="sm" className="filter-chip-btn" on={feed.type === key} aria-pressed={feed.type === key} onClick={() => onFeed({ ...feed, ...(key ? { type: key } : { type: undefined }) })}>
            {label}{count ? <span className="mono"> {count}</span> : null}
        </Button>
    );
    const renderRow = (ev: FeedEvent, primary: boolean) => (
        <FeedRow key={ev.id} event={ev} showEnv={!envId} envName={envName(ev.env_id)} primary={primary} unseen={!ev.seen_at} onOpen={openTask} onSeen={(id) => markSeen({ ids: [id] })} />
    );
    const nothing = events !== null && openShown.length === 0 && stream.length === 0;

    return (
        <PageFrame width="wide">
            <PageHeader
                title="Tasks"
                meta={<ViewSwitch view="feed" onChange={(v) => { if (v === "list") onView("list"); }} />}
                actions={
                    <>
                        <label className="tasks-search">
                            <span>Search</span>
                            <Input type="search" placeholder="id, title, label" aria-label="Search tasks" value={filter.q ?? ""} onChange={(e) => onFilter({ ...filter, q: e.target.value || undefined })} />
                            <Kbd>C-s</Kbd>
                        </label>
                        <Button variant="primary" className="tasks-new" onClick={onNewTask}>New task <Kbd>C-c n</Kbd></Button>
                    </>
                }
            />
            <Tabs
                items={[
                    { key: "", label: <>All{totalNeeds > 0 && <Badge tone="warn" title={`${totalNeeds} waiting on you`} aria-label={`${totalNeeds} waiting on you`}>{totalNeeds}</Badge>}</> },
                    ...envs.map((e) => { const n = needsIn(e.id); return { key: e.id, label: <>{e.name}{n > 0 && <Badge tone="warn" title={`${n} waiting on you`} aria-label={`${n} waiting on you`}>{n}</Badge>}</> }; }),
                ]}
                active={envId ?? ""}
                onChange={(k) => onSelectEnv(k || undefined)}
            />
            <div className="feed-bar">
                {typeChip(undefined, "All")}
                {typeChip("needs_you", "Needs you", open.length)}
                {typeChip("agent", "Agent")}
                {typeChip("pr", "Pull requests")}
                <FilterChip label="Stage" value={filter.stage ? STAGE_LABEL[filter.stage] : undefined} options={Object.values(STAGE_LABEL)} onPick={(v) => onFilter({ ...filter, stage: (Object.keys(STAGE_LABEL) as Array<keyof typeof STAGE_LABEL>).find((k) => STAGE_LABEL[k] === v) })} />
                <FilterChip label="Label" value={filter.label} options={labelOptions} onPick={(v) => onFilter({ ...filter, label: v })} />
                <span className="feed-bar-end">
                    <span className="feed-live" role="status">{connected ? "Live" : ""}</span>
                    <span className="feed-pop" ref={digestRef}>
                        <Button size="sm" disabled={!sinceAt} aria-haspopup="dialog" aria-expanded={digestOpen} onClick={() => setDigestOpen((o) => !o)}>{sinceAt ? `Since ${hhmm(sinceAt)}` : "Nothing new"}<Icon name="chevronDown" /></Button>
                        {digestOpen && sinceAt && (
                            <Popover className="feed-digest" role="dialog" aria-label={`Since ${hhmm(sinceAt)}`}>
                                <b>Since you were last here, {hhmm(sinceAt)}</b>
                                {counts.needs > 0 && <div><Badge tone="warn">{counts.needs}</Badge> {counts.needs === 1 ? "new thing needs you" : "new things need you"}</div>}
                                {counts.agent > 0 && <div><Badge>{counts.agent}</Badge> from agents</div>}
                                {counts.pr > 0 && <div><Badge>{counts.pr}</Badge> {counts.pr === 1 ? "pull request update" : "pull request updates"}</div>}
                                {counts.other > 0 && <div><Badge>{counts.other}</Badge> started, stopped or limited</div>}
                                <Button size="sm" onClick={() => { markSeen({ all: true }); setDigestOpen(false); }}>Mark all seen</Button>
                            </Popover>
                        )}
                    </span>
                    <span className="feed-pop" ref={menuRef}>
                        <Button size="sm" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Feed options" onClick={() => setMenuOpen((o) => !o)}>⋯</Button>
                        {menuOpen && (
                            <Menu className="feed-menu">
                                <Checkbox label="Started and stopped" checked={!!feed.lifecycle} onChange={() => onFeed({ ...feed, lifecycle: feed.lifecycle ? undefined : true })} />
                            </Menu>
                        )}
                    </span>
                </span>
            </div>
            {!connected && <Notice tone="warn">Live updates stopped.{latestAt ? ` Showing events from ${hhmm(latestAt)}.` : ""} Reconnecting.</Notice>}
            {error && <Notice tone="bad">{error}</Notice>}
            {events === null && (
                <div className="feed-loading" role="status" aria-live="polite"><i /><i /><i /><span>Loading events</span></div>
            )}
            {nothing && (
                <div className="tasks-empty">
                    {filtered
                        ? <><b>Nothing matches</b><Button onClick={() => { onFilter({}); onFeed({}); }}>Clear filters</Button></>
                        : <><b>All clear</b><p>Nothing needs you{envId ? ` in ${envName(envId)}` : " in any environment"}.{latestAt ? ` Last checked ${hhmm(new Date().toISOString())}.` : ""}</p><Button onClick={() => onView("list")}>Go to List</Button></>}
                </div>
            )}
            {events !== null && !nothing && (
                <div
                    className="feed-stream"
                    onMouseEnter={() => { if (canHold()) setHolding(true); }}
                    onMouseLeave={() => { if (!document.activeElement?.closest(".feed-stream")) setHolding(false); }}
                    onFocus={(e) => { if (canHold() && (e.target as HTMLElement).matches(":focus-visible")) setHolding(true); }}
                    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover")) setHolding(false); }}
                >
                    {queued.length > 0 && (
                        <div className="feed-queued"><Button size="sm" variant="primary" onClick={showQueued}>{queued.length} new {queued.length === 1 ? "event" : "events"} <Icon name="chevronDown" /></Button></div>
                    )}
                    {openShown.length > 0 && (
                        <section className="feed-block feed-needs" aria-label="Needs you">
                            <div className="feed-block-head">Needs you <Badge tone="warn">{openShown.length}</Badge></div>
                            {openShown.map((ev) => renderRow(ev, true))}
                        </section>
                    )}
                    {items.map((g, gi) => (
                        <section key={g.day} className="feed-day" aria-label={g.day}>
                            <div className="feed-day-head">{g.day}</div>
                            <div className="feed-block">
                                {gi === 0 && newestUnseen.length > 0 && (
                                    <div className="feed-divider">
                                        <span>New since {hhmm(newestUnseen[newestUnseen.length - 1]!.at)}</span>
                                        <Button size="sm" onClick={() => markSeen({ all: true })}>Mark all seen <Kbd>C-c s</Kbd></Button>
                                    </div>
                                )}
                                {g.items.map((it) => it.kind === "event" ? renderRow(it.event, false) : (
                                    <div key={it.key}>
                                        <div className={`feed-row${it.events.some((e) => !e.seen_at) ? " unseen" : ""}`} tabIndex={0} data-feed-row={it.events[0]!.id} data-task={it.events[0]!.task_id} onClick={() => openTask(it.events[0]!.task_id)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openTask(it.events[0]!.task_id); }}>
                                            <span className="feed-ic info" aria-hidden="true">▶</span>
                                            <div className="feed-body">
                                                <div className="feed-title">
                                                    {it.events.some((e) => !e.seen_at) && <span className="feed-new">New</span>}
                                                    {!envId && <span className="feed-env">{envName(it.events[0]!.env_id)}</span>}
                                                    {it.events[0]!.ticket_id && <span className="mono feed-ticket">{it.events[0]!.ticket_id}</span>}
                                                    {it.events.length} updates
                                                    <Button size="sm" variant="ghost" aria-expanded={expanded.has(it.key)} onClick={(e) => { e.stopPropagation(); setExpanded((cur) => { const n = new Set(cur); if (n.has(it.key)) n.delete(it.key); else n.add(it.key); return n; }); }}>{expanded.has(it.key) ? "Hide" : "Show all"}</Button>
                                                </div>
                                                <div className="feed-meta">{it.events[0]!.text}</div>
                                            </div>
                                            <div className="feed-side"><span className="feed-time" title={new Date(it.events[0]!.at).toLocaleString()}>{age(it.events[0]!.at)}</span></div>
                                        </div>
                                        {expanded.has(it.key) && <div className="feed-burst">{it.events.map((e) => <span key={e.id}><b>{hhmm(e.at)}</b> {e.text}</span>)}</div>}
                                    </div>
                                ))}
                            </div>
                        </section>
                    ))}
                    {more && <div className="feed-more"><Button onClick={() => void loadEarlier()}>Load earlier</Button></div>}
                </div>
            )}
        </PageFrame>
    );
};
