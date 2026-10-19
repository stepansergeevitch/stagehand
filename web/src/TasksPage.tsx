import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BaseCheckChip } from "./components/BaseCheckChip";
import { LabelChips } from "./Labels";
import { labelsOf, STAGE_LABEL, taskLabel, type Env, type Task } from "./api";
import { Button, Badge, Chip, Icon, Input, Kbd, Tabs } from "@vortex/ds";
import type { TaskFilter, TaskList, TaskTab } from "./routes";
import { PageFrame } from "./components/AppShell";
import { PageHeader } from "./components/PageHeader";
import { FilterChip } from "./components/FilterChip";
import { DataTable, type DataColumn, type DataGroup } from "./components/DataTable";
import { age, TaskStatusChip, taskNeed, taskState } from "./components/status";
import "./tasks.css";

// The Tasks page, as the approved design draws it (docs/ux-redesign.md §4.1, §4.3 and §6.1). Top to bottom: the title with
// the search and New task, a tab per environment (the badge counts tasks waiting on you), a paste bar that starts one task
// per ticket id, the Active / Completed switch with the Pinned, Stage and Label filters, then the table. Active is grouped
// by what the task needs from you (Needs you, Running, Waiting on others, Idle folded) with a **What it needs** column: ONE
// button that opens the exact place, or the task's status line when nothing is to be pressed. A row opens the workspace.
// On a phone only the title with New task, the environment tabs and the task cards remain.
//
// Live updates never move a row under the pointer: while the table is hovered or has focus, a change that would regroup or
// add a row waits behind a pill ("2 updates: … Apply"), the rest (status text, ages) updates in place.
// Search, stage, label and pinned are the route's `?q=&stage=&label=&pinned=1`.
//
// Keys (Emacs): C-n / C-p move between rows, RET opens, C-SPC selects, C-s searches, C-c n makes a new task, C-c C-c
// presses the focused row's button, C-c r applies waiting updates, C-c c switches Active / Completed, C-x then ← / →
// switches environment, C-g leaves a field.
const GROUPS: DataGroup[] = [
    { key: "attention", label: <Chip tone="warn">Needs you</Chip> },
    { key: "working", label: <Chip tone="info">Running</Chip> },
    { key: "waiting", label: <Chip tone="wait">Waiting on others</Chip> },
    { key: "parked", label: <Chip tone="neutral">Idle</Chip>, collapsed: true },
];

const isTyping = (el: EventTarget | null): boolean => {
    const e = el as HTMLElement | null;
    return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable);
};

// One task as the search and the filters see it.
const matches = (t: Task, f: TaskFilter): boolean => {
    const q = f.q?.trim().toLowerCase();
    if (q && ![t.ticket_id, t.title ?? "", labelsOf(t).map((l) => l.text).join(" "), t.status_line ?? "", STAGE_LABEL[t.stage]].some((v) => v.toLowerCase().includes(q))) return false;
    if (f.stage && t.stage !== f.stage) return false;
    if (f.label && !labelsOf(t).some((l) => l.text === f.label)) return false;
    if (f.pinned && !t.pinned) return false;
    return true;
};

// A touch screen has no hover and a tap leaves focus behind, so the list never holds there: changes apply at once.
const canHold = (): boolean => window.matchMedia("(hover: hover)").matches;

const groupKey = (t: Task): string => (taskState(t).group === "finished" ? "parked" : taskState(t).group);

// What changed for a task while the list was held, in words: "ENG-24850 started again".
const changeWords = (t: Task, before: string | undefined): string => {
    const now = groupKey(t);
    if (before === undefined) return `${t.ticket_id} was added`;
    if (t.stage === "pr_green") return `${t.ticket_id} is green`;
    if (now === "working") return `${t.ticket_id} ${before === "attention" ? "started again" : "is running"}`;
    if (now === "attention") return `${t.ticket_id} needs you`;
    if (now === "waiting") return `${t.ticket_id} is waiting on others`;
    return `${t.ticket_id} is ${taskState(t).group === "finished" ? "done" : "idle"}`;
};

// A task on a phone: id and age, title, then ONE 44px button, or the line saying what it is doing and its stage.
const TaskCard = ({ task: t, onOpen }: { task: Task; onOpen: (id: string, tab?: TaskTab) => void }) => {
    const need = taskNeed(t);
    return (
        <div className="task-card">
            <div className="task-card-top"><b className="task-id">{taskLabel(t)}</b><span className="mono">{age(t.updated_at)}</span></div>
            <div className="task-card-title">{t.title}</div>
            {need.action
                ? <Button variant={t.status === "failed" ? "danger" : "primary"} className="task-card-action" onClick={(e) => { e.stopPropagation(); onOpen(t.id, need.action!.tab); }}>{need.action.label}</Button>
                : <><span className="task-need">{need.text}</span><span className="task-card-stage">{STAGE_LABEL[t.stage]}</span></>}
        </div>
    );
};

export const TasksPage = ({ envs, envId, env, tasks, visible, list, filter, onList, onFilter, selected, detailPane, onDeleteTasks, onPinTasks, onStopTasks, onSelectEnv, onNewTask, onPasteTickets, onOpen }: {
    envs: Env[];
    envId: string;
    env: Env | undefined;
    // Every task (the tab counts) and the environment's tasks (the table).
    tasks: Task[];
    visible: Task[];
    list: TaskList | undefined;
    filter: TaskFilter;
    onList: (list: TaskList | undefined) => void;
    // Search and filters; `env` jumps to another environment keeping them.
    onFilter: (filter: TaskFilter, env?: string) => void;
    selected: string | null;
    // What the workspace shows: the task view or a loading line.
    detailPane: ReactNode;
    onDeleteTasks: (ids: string[]) => void;
    onPinTasks: (ids: string[]) => void;
    onStopTasks: (ids: string[]) => void;
    onSelectEnv: (id: string) => void;
    onNewTask: () => void;
    // The paste bar: one task per ticket, with the environment's defaults.
    onPasteTickets: (tickets: string[]) => Promise<void>;
    onOpen: (id: string, tab?: TaskTab) => void;
}) => {
    const completed = list === "completed";
    // Tasks waiting on you, per environment: the badge on its tab.
    const needsYou = (id: string) => tasks.filter((t) => t.env_id === id && taskState(t).group === "attention").length;
    const inList = useMemo(() => visible.filter((t) => (taskState(t).group === "finished") === completed), [visible, completed]);
    // Pinned first, then by what needs you, then the latest.
    const liveRows = useMemo(
        () => inList.filter((t) => matches(t, filter)).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || taskState(a).rank - taskState(b).rank || b.updated_at.localeCompare(a.updated_at)),
        [inList, filter],
    );
    const activeCount = visible.filter((t) => taskState(t).group !== "finished").length;
    const completedCount = visible.length - activeCount;

    // The hold: pointer over the table or focus inside it. Its snapshot keeps each row's place; live data still shows.
    type Snap = { ids: string[]; group: Record<string, string> };
    const capture = (): Snap => ({ ids: liveRows.map((t) => t.id), group: Object.fromEntries(liveRows.map((t) => [t.id, groupKey(t)])) });
    const [holding, setHolding] = useState(false);
    const [snap, setSnap] = useState<Snap | null>(null);
    useEffect(() => {
        if (holding && !snap) setSnap(capture());
        if (!holding && snap) setSnap(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [holding]);
    useEffect(() => setSnap(null), [completed, envId]);
    const rows = useMemo(() => {
        if (!snap) return liveRows;
        const byId = new Map(liveRows.map((t) => [t.id, t]));
        return snap.ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
    }, [liveRows, snap]);
    const changes = snap ? liveRows.filter((t) => snap.group[t.id] !== groupKey(t)) : [];
    const pending = snap ? changes.length + snap.ids.filter((id) => !liveRows.some((t) => t.id === id)).length : 0;
    const apply = (): void => { if (snap) setSnap(capture()); };

    // A row whose state just changed carries a text mark for three seconds.
    const seen = useRef(new Map<string, string>());
    const [changed, setChanged] = useState<Set<string>>(new Set());
    useEffect(() => {
        const now: string[] = [];
        for (const t of liveRows) {
            const sig = `${t.status}|${t.stage}`;
            const before = seen.current.get(t.id);
            if (before !== undefined && before !== sig) now.push(t.id);
            seen.current.set(t.id, sig);
        }
        if (!now.length) return;
        setChanged((cur) => new Set([...cur, ...now]));
        const timer = setTimeout(() => setChanged((cur) => new Set([...cur].filter((id) => !now.includes(id)))), 3000);
        return () => clearTimeout(timer);
    }, [liveRows]);

    // The tab title carries the total waiting on you, in every environment.
    const total = tasks.filter((t) => taskState(t).group === "attention").length;
    useEffect(() => {
        document.title = `${total > 0 ? `(${total}) ` : ""}Tasks · Vortex`;
        return () => { document.title = "Vortex"; };
    }, [total]);

    const filtered = !!(filter.q || filter.stage || filter.label || filter.pinned);
    // Matches in the other environments, for the result line.
    const elsewhere = filtered
        ? envs.filter((e) => e.id !== envId).map((e) => ({ env: e, n: tasks.filter((t) => t.env_id === e.id && (taskState(t).group === "finished") === completed && matches(t, filter)).length })).filter((x) => x.n > 0)
        : [];
    const stageOf = (label: string | undefined) => (Object.keys(STAGE_LABEL) as Task["stage"][]).find((k) => STAGE_LABEL[k] === label);
    const labelOptions = [...new Set(inList.flatMap((t) => labelsOf(t).map((l) => l.text)))].sort();

    const [paste, setPaste] = useState("");
    const [pasting, setPasting] = useState(false);
    const submitPaste = async (e: FormEvent): Promise<void> => {
        e.preventDefault();
        const tickets = paste.split(/[\s,]+/).filter(Boolean);
        if (!tickets.length || !env || pasting) return;
        setPasting(true);
        try {
            await onPasteTickets(tickets);
            setPaste("");
        } finally {
            setPasting(false);
        }
    };

    // Emacs keys for the list. A chord (C-c …, C-x …) waits two seconds for its second key.
    const chord = useRef<{ prefix: "c" | "x"; at: number } | null>(null);
    const step = (d: number): void => { const i = envs.findIndex((e) => e.id === envId); const to = envs[i + d]; if (to) onSelectEnv(to.id); };
    const act = useRef({ onNewTask, enabled: !selected, apply, toggleList: () => onList(completed ? undefined : "completed"), step });
    act.current = { onNewTask, enabled: !selected, apply, toggleList: () => onList(completed ? undefined : "completed"), step };
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (!act.current.enabled || e.defaultPrevented || e.altKey || e.metaKey || document.querySelector("[role=dialog]")) return;
            const typing = isTyping(e.target);
            if (e.ctrlKey && e.code === "KeyG") {
                if (typing) (e.target as HTMLElement).blur();
                chord.current = null;
                return;
            }
            if (typing) return;
            const c = chord.current && Date.now() - chord.current.at < 2000 ? chord.current : null;
            chord.current = null;
            if (c?.prefix === "c") {
                if (e.code === "KeyN" && !e.ctrlKey) { e.preventDefault(); act.current.onNewTask(); }
                else if (e.code === "KeyR" && !e.ctrlKey) { e.preventDefault(); act.current.apply(); }
                else if (e.code === "KeyC" && !e.ctrlKey) { e.preventDefault(); act.current.toggleList(); }
                else if (e.code === "KeyC" && e.ctrlKey) {
                    e.preventDefault();
                    const row = (document.activeElement as HTMLElement | null)?.closest("tr[data-row]");
                    row?.querySelector<HTMLButtonElement>("button[data-primary]")?.click();
                }
                return;
            }
            if (c?.prefix === "x") {
                if (e.key === "ArrowLeft") { e.preventDefault(); act.current.step(-1); }
                else if (e.key === "ArrowRight") { e.preventDefault(); act.current.step(1); }
                return;
            }
            if (e.ctrlKey && (e.code === "KeyC" || e.code === "KeyX") && !window.getSelection()?.toString()) {
                e.preventDefault();
                chord.current = { prefix: e.code === "KeyC" ? "c" : "x", at: Date.now() };
            } else if (e.ctrlKey && e.code === "KeyS") {
                e.preventDefault();
                document.querySelector<HTMLInputElement>(".tasks-search input")?.focus();
            } else if (e.ctrlKey && (e.code === "KeyN" || e.code === "KeyP")) {
                const rowsEl = [...document.querySelectorAll<HTMLElement>("tr[data-row]")];
                if (!(document.activeElement as HTMLElement | null)?.closest("tr[data-row]")) {
                    e.preventDefault();
                    (e.code === "KeyN" ? rowsEl[0] : rowsEl[rowsEl.length - 1])?.focus();
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const columns: DataColumn<Task>[] = [
        ...(completed ? [{ key: "status", label: "Status", value: (t: Task) => taskState(t).label, filter: false as const, render: (t: Task) => <TaskStatusChip task={t} /> }] : []),
        { key: "task", label: "Task", value: (t) => taskLabel(t), filter: false, render: (t) => <b className="task-id">{t.pinned ? <Icon name="pin" aria-label="Pinned" /> : null}{taskLabel(t)}</b> },
        { key: "title", label: "Title", kind: "label", value: (t) => t.title ?? "", filter: false, render: (t) => <>{t.title ?? ""}{changed.has(t.id) && <Chip tone="info" className="task-updated">Updated</Chip>}</> },
        { key: "labels", label: "Labels", value: (t) => labelsOf(t).map((l) => l.text).join(", "), filter: false, render: (t) => <LabelChips labels={labelsOf(t)} /> },
        ...(completed ? [] : [{
            key: "need",
            label: "What it needs",
            value: (t: Task) => taskNeed(t).text,
            filter: false as const,
            render: (t: Task) => {
                const need = taskNeed(t);
                return need.action
                    ? <Button size="sm" variant={t.status === "failed" ? "danger" : "primary"} data-primary onClick={(e) => { e.stopPropagation(); onOpen(t.id, need.action!.tab); }}>{need.action.label}</Button>
                    : <span className="task-need">{need.text}</span>;
            },
        }]),
        { key: "stage", label: "Stage", value: (t) => STAGE_LABEL[t.stage], filter: false, render: (t) => STAGE_LABEL[t.stage] },
        { key: "base", label: "Base", value: (t) => t.base_check_state ?? "", filter: false, defaultHidden: true, render: (t) => <BaseCheckChip state={t.base_check_state} detail={t.base_check_detail} /> },
        { key: "age", label: "Updated", kind: "num", value: (t) => Date.now() - new Date(t.updated_at).getTime(), render: (t) => age(t.updated_at) },
    ];
    if (selected) return <PageFrame width="wide">{detailPane}</PageFrame>;

    const running = inList.filter((t) => taskState(t).group === "working").length;
    const waiting = inList.filter((t) => taskState(t).group === "waiting").length;
    const allClear = !completed && inList.length > 0 && !filtered && !inList.some((t) => taskState(t).group === "attention");
    const showRunning = (): void => {
        const head = document.querySelector<HTMLElement>("tr.dt-group[data-group=working] button");
        if (head?.getAttribute("aria-expanded") === "false") head.click();
        head?.scrollIntoView({ block: "center" });
        head?.focus();
    };
    const parts = [
        running > 0 ? `${running} ${running === 1 ? "task is" : "tasks are"} running` : "",
        waiting > 0 ? `${waiting} ${waiting === 1 ? "is" : "are"} waiting on others` : "",
    ].filter(Boolean);

    return (
        <PageFrame width="wide">
            <PageHeader
                title="Tasks"
                actions={
                    <>
                        <label className="tasks-search">
                            <span>Search</span>
                            <Input type="search" placeholder="id, title, label" aria-label="Search tasks" value={filter.q ?? ""} onChange={(e) => onFilter({ ...filter, q: e.target.value || undefined })} />
                            <Kbd>C-s</Kbd>
                        </label>
                        <Button variant="primary" className="tasks-new" disabled={!env} onClick={onNewTask}>New task <Kbd>C-c n</Kbd></Button>
                    </>
                }
            />
            <Tabs
                items={envs.map((e) => {
                    const n = needsYou(e.id);
                    return { key: e.id, label: <>{e.name}{n > 0 && <Badge tone="warn" title={`${n} waiting on you`} aria-label={`${n} waiting on you`}>{n}</Badge>}</> };
                })}
                active={envId}
                onChange={onSelectEnv}
            />
            {env && (
                <form className="task-paste" onSubmit={(e) => void submitPaste(e)}>
                    <Input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste an id or link" aria-label="Ticket id or link" disabled={pasting} />
                </form>
            )}
            <div className="tasks-bar">
                <Tabs
                    items={[
                        { key: "active", label: <>Active <span className="mono">{activeCount}</span></> },
                        { key: "completed", label: <>Completed <span className="mono">{completedCount}</span></> },
                    ]}
                    variant="pill"
                    active={completed ? "completed" : "active"}
                    onChange={(k) => onList(k === "completed" ? "completed" : undefined)}
                />
                <Button size="sm" className="filter-chip-btn" on={!!filter.pinned} aria-pressed={!!filter.pinned} onClick={() => onFilter({ ...filter, pinned: filter.pinned ? undefined : true })}>Pinned</Button>
                <FilterChip label="Stage" value={filter.stage ? STAGE_LABEL[filter.stage] : undefined} options={Object.values(STAGE_LABEL)} onPick={(v) => onFilter({ ...filter, stage: stageOf(v) })} />
                <FilterChip label="Label" value={filter.label} options={labelOptions} onPick={(v) => onFilter({ ...filter, label: v })} />
            </div>
            {filtered && (
                <div className="tasks-filtered">
                    <div className="tasks-filtered-chips">
                        {filter.q && <span className="tasks-q mono">{filter.q}</span>}
                        {filter.stage && <Button size="sm" className="filter-chip-btn" on aria-label="Remove filter Stage" onClick={() => onFilter({ ...filter, stage: undefined })}>Stage: {STAGE_LABEL[filter.stage]} <Icon name="close" /></Button>}
                        {filter.label && <Button size="sm" className="filter-chip-btn" on aria-label="Remove filter Label" onClick={() => onFilter({ ...filter, label: undefined })}>Label: {filter.label} <Icon name="close" /></Button>}
                        {filter.pinned && <Button size="sm" className="filter-chip-btn" on aria-label="Remove filter Pinned" onClick={() => onFilter({ ...filter, pinned: undefined })}>Pinned <Icon name="close" /></Button>}
                        <Button size="sm" onClick={() => onFilter({})}>Clear all</Button>
                    </div>
                    <div role="status" className="tasks-result">
                        {liveRows.length} of {inList.length} {inList.length === 1 ? "task" : "tasks"} in {env?.name ?? "this environment"} match.
                        {elsewhere.map((x) => <Button key={x.env.id} size="sm" variant="ghost" onClick={() => onFilter(filter, x.env.id)}>{x.n} more {x.n === 1 ? "matches" : "match"} in {x.env.name}</Button>)}
                    </div>
                </div>
            )}
            {allClear && (
                <div className="tasks-empty">
                    <b>All clear in {env?.name ?? "this environment"}</b>
                    <p>Nothing waits on you.{parts.length ? ` ${parts.join(" and ")}.` : ""}</p>
                    {running > 0 && <Button onClick={showRunning}>Show running</Button>}
                </div>
            )}
            <div
                className="tasks-table"
                onMouseEnter={() => { if (canHold()) setHolding(true); }}
                onMouseLeave={() => { if (!document.activeElement?.closest(".tasks-table")) setHolding(false); }}
                onFocus={(e) => { if (canHold() && (e.target as HTMLElement).matches(":focus-visible")) setHolding(true); }}
                onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover")) setHolding(false); }}
            >
                <DataTable
                    bare
                    entity="task"
                    columns={columns}
                    rows={rows}
                    rowKey={(t) => t.id}
                    onRowClick={(t) => onOpen(t.id)}
                    storageKey={completed ? "tasks-completed" : "tasks-active"}
                    card={(t) => <TaskCard task={t} onOpen={onOpen} />}
                    groups={completed ? undefined : GROUPS}
                    groupOf={completed ? undefined : (t) => snap?.group[t.id] ?? groupKey(t)}
                    topBar={pending > 0 ? (
                        <div className="dt-live">
                            <Button size="sm" className="task-updates-btn" onClick={apply}>
                                {pending} {pending === 1 ? "update" : "updates"}{changes.length ? `: ${changes.slice(0, 3).map((t) => changeWords(t, snap?.group[t.id])).join(", ")}${changes.length > 3 ? ` and ${changes.length - 3} more` : ""}` : ""}. Apply <Kbd>C-c r</Kbd>
                            </Button>
                        </div>
                    ) : undefined}
                    bulkActions={(sel, clear) => (
                        <>
                            <Button size="sm" onClick={() => { onPinTasks(sel.map((t) => t.id)); clear(); }}>Pin</Button>
                            <Button size="sm" onClick={() => { onStopTasks(sel.map((t) => t.id)); clear(); }}>Stop</Button>
                            <Button size="sm" variant="danger" className="dt-bulk-delete" onClick={() => { onDeleteTasks(sel.map((t) => t.id)); clear(); }}>Delete</Button>
                        </>
                    )}
                    empty={completed
                        ? <div className="tasks-empty"><b>No completed tasks in {env?.name ?? "this environment"} yet</b></div>
                        : filtered
                            ? <div className="tasks-empty"><b>No task matches</b><Button onClick={() => onFilter({})}>Clear all</Button></div>
                            : <div className="tasks-empty"><b>No tasks in {env?.name ?? "this environment"} yet</b><p>Paste a ticket id above, or pick one assigned to you.</p>{env && <Button variant="primary" onClick={onNewTask}>Pick from my tickets</Button>}</div>}
                />
            </div>
        </PageFrame>
    );
};
