import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BaseCheckChip } from "./components/BaseCheckChip";
import { LabelChips } from "./Labels";
import { labelsOf, STAGE_LABEL, taskLabel, type Env, type Task } from "./api";
import { Badge, Button, Chip, EmptyState, Icon, Input, Kbd, Notice, Tabs } from "@vortex/ds";
import type { TaskFilter, TaskList, TaskTab } from "./routes";
import { PageFrame } from "./components/AppShell";
import { DataTable, type DataColumn, type DataGroup, type Filters } from "./components/DataTable";
import { age, TaskStatusChip, taskNeed, taskState } from "./components/status";
import "./tasks.css";

// The Tasks page (docs/ux-redesign.md §4.1, §4.3 and §6.1): a tab per environment (with the count of tasks waiting on
// you), a paste bar to start tasks from ticket ids, then that environment's tasks as a table in two tabs, Active and
// Completed (finished and stopped). Active is grouped by what the task needs from you (Needs you, Running, Waiting on
// others, Idle) with ONE button per row that opens the place to act; a row opens the task workspace in place of the list.
// The environment tab is the route's `?env=`, the tab its path (`#/tasks/completed`).
//
// Live updates never move a row under the pointer: while the table is hovered or has focus, a change that would
// regroup or add a row waits behind a pill ("2 updates. Apply"), the rest (status text, ages) updates in place.
// Search, stage and label are the route's `?q=&stage=&label=`; the result line says what matches in other environments.
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

// One task as the search sees it.
const matches = (t: Task, f: TaskFilter): boolean => {
    const q = f.q?.trim().toLowerCase();
    if (q && ![t.ticket_id, t.title ?? "", labelsOf(t).map((l) => l.text).join(" "), t.status_line ?? "", STAGE_LABEL[t.stage]].some((v) => v.toLowerCase().includes(q))) return false;
    if (f.stage && t.stage !== f.stage) return false;
    if (f.label && !labelsOf(t).some((l) => l.text === f.label)) return false;
    return true;
};

// A task on a phone: id and age, title, labels, then ONE 44px button, or the line saying what it is doing and its stage.
const TaskCard = ({ task: t, onOpen }: { task: Task; onOpen: (id: string, tab?: TaskTab) => void }) => {
    const need = taskNeed(t);
    return (
        <div className="task-card">
            <div className="task-card-top"><b className="task-id">{taskLabel(t)}</b><span className="mono">{age(t.updated_at)}</span></div>
            <div className="task-card-title">{t.title}</div>
            {labelsOf(t).length > 0 && <LabelChips labels={labelsOf(t)} />}
            {need.action
                ? <Button variant={t.status === "failed" ? "danger" : "primary"} className="task-card-action" onClick={(e) => { e.stopPropagation(); onOpen(t.id, need.action!.tab); }}>{need.action.label}</Button>
                : <><span className="task-need">{need.text}</span><span className="task-card-stage">{STAGE_LABEL[t.stage]}</span></>}
        </div>
    );
};

export const TasksPage = ({ envs, envId, env, tasks, visible, list, filter, onList, onFilter, selected, detailPane, onDeleteTasks, onSelectEnv, onNewTask, onPasteTickets, onOpen }: {
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
    onSelectEnv: (id: string) => void;
    onNewTask: () => void;
    // The paste bar: one task per ticket, with the environment's defaults.
    onPasteTickets: (tickets: string[]) => Promise<void>;
    onOpen: (id: string, tab?: TaskTab) => void;
}) => {
    const completed = list === "completed";
    // Tasks waiting on you, per environment: the badge on its tab.
    const needsYou = (id: string) => tasks.filter((t) => t.env_id === id && taskState(t).group === "attention").length;
    // Pinned first, then by what needs you, then the latest.
    const liveRows = useMemo(
        () => visible.filter((t) => (taskState(t).group === "finished") === completed).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || taskState(a).rank - taskState(b).rank || b.updated_at.localeCompare(a.updated_at)),
        [visible, completed],
    );
    const groupKey = (t: Task): string => (taskState(t).group === "finished" ? "parked" : taskState(t).group);

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
    const pending = snap
        ? liveRows.filter((t) => snap.group[t.id] === undefined || snap.group[t.id] !== groupKey(t)).length + snap.ids.filter((id) => !liveRows.some((t) => t.id === id)).length
        : 0;
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

    // Search and filters are the route's: DataTable shows them as its query and the Stage / Labels filters.
    const filters: Filters = { ...(filter.stage ? { stage: [STAGE_LABEL[filter.stage]] } : {}), ...(filter.label ? { labels: [filter.label] } : {}) };
    const setFilters = (f: Filters): void => {
        const stage = f.stage?.[0] ? (Object.keys(STAGE_LABEL) as Task["stage"][]).find((k) => STAGE_LABEL[k] === f.stage![0]) : undefined;
        onFilter({ ...(filter.q ? { q: filter.q } : {}), ...(stage ? { stage } : {}), ...(f.labels?.[0] ? { label: f.labels[0] } : {}) });
    };
    const filtered = !!(filter.q || filter.stage || filter.label);
    // Matches in the other environments, for the result line.
    const elsewhere = filtered
        ? envs.filter((e) => e.id !== envId).map((e) => ({ env: e, n: tasks.filter((t) => t.env_id === e.id && (taskState(t).group === "finished") === completed && matches(t, filter)).length })).filter((x) => x.n > 0)
        : [];

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
    const act = useRef({ onNewTask, enabled: !selected, apply, toggleList: () => onList(completed ? undefined : "completed"), step: (d: number) => { const i = envs.findIndex((e) => e.id === envId); const to = envs[i + d]; if (to) onSelectEnv(to.id); } });
    act.current = { onNewTask, enabled: !selected, apply, toggleList: () => onList(completed ? undefined : "completed"), step: (d: number) => { const i = envs.findIndex((e) => e.id === envId); const to = envs[i + d]; if (to) onSelectEnv(to.id); } };
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
                document.querySelector<HTMLInputElement>(".dt-search input")?.focus();
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
        ...(completed ? [{ key: "status", label: "Status", value: (t: Task) => taskState(t).label, filter: "auto" as const, render: (t: Task) => <TaskStatusChip task={t} /> }] : []),
        { key: "task", label: "Task", value: (t) => taskLabel(t), filter: false, render: (t) => <b className="task-id">{t.pinned ? <Icon name="pin" aria-label="Pinned" /> : null}{taskLabel(t)}</b> },
        { key: "title", label: "Title", kind: "label", value: (t) => t.title ?? "", filter: false, render: (t) => <>{t.title ?? ""}{changed.has(t.id) && <Chip tone="info" className="task-updated">Updated</Chip>}</> },
        { key: "labels", label: "Labels", value: (t) => labelsOf(t).map((l) => l.text).join(", "), values: (t) => labelsOf(t).map((l) => l.text), filter: true, render: (t) => <LabelChips labels={labelsOf(t)} /> },
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
        { key: "stage", label: "Stage", value: (t) => STAGE_LABEL[t.stage], filter: "auto", render: (t) => STAGE_LABEL[t.stage] },
        { key: "base", label: "Base", value: (t) => t.base_check_state ?? "", filter: false, defaultHidden: true, render: (t) => <BaseCheckChip state={t.base_check_state} detail={t.base_check_detail} /> },
        { key: "age", label: "Updated", kind: "num", value: (t) => Date.now() - new Date(t.updated_at).getTime(), render: (t) => age(t.updated_at) },
    ];
    if (selected) return <PageFrame width="wide">{detailPane}</PageFrame>;
    return (
        <PageFrame width="wide">
            <Tabs
                items={envs.map((e) => {
                    const n = needsYou(e.id);
                    return { key: e.id, label: <>{e.name}{n > 0 && <Badge tone="warn" title={`${n} waiting on you`} aria-label={`${n} waiting on you`}>{n}</Badge>}</> };
                })}
                active={envId}
                onChange={onSelectEnv}
            />
            {!completed && env && (
                <form className="task-paste" onSubmit={(e) => void submitPaste(e)}>
                    <Input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste an id or link" aria-label="Ticket id or link" disabled={pasting} />
                </form>
            )}
            <Tabs
                items={[{ key: "active", label: "Active" }, { key: "completed", label: "Completed" }]}
                variant="pill"
                active={completed ? "completed" : "active"}
                onChange={(k) => onList(k === "completed" ? "completed" : undefined)}
            />
            {!completed && rows.length > 0 && !rows.some((t) => taskState(t).group === "attention") && (
                <Notice tone="ok">
                    <b>All clear in {env?.name ?? "this environment"}.</b> Nothing waits on you.
                    {" "}{[[rows.filter((t) => taskState(t).group === "working").length, "running"], [rows.filter((t) => taskState(t).group === "waiting").length, "waiting on others"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(", ")}
                </Notice>
            )}
            <div
                className="tasks-table"
                onMouseEnter={() => setHolding(true)}
                onMouseLeave={() => { if (!document.activeElement?.closest(".tasks-table")) setHolding(false); }}
                onFocus={() => setHolding(true)}
                onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover")) setHolding(false); }}
            >
            {pending > 0 && (
                <div className="task-updates">
                    <Button size="sm" onClick={apply}>{pending} {pending === 1 ? "update" : "updates"}. Apply <Kbd>C-c r</Kbd></Button>
                </div>
            )}
            <DataTable
                title="Tasks"
                entity="task"
                onCreate={onNewTask}
                createDisabled={env ? undefined : "Pick an environment first"}
                columns={columns}
                rows={rows}
                rowKey={(t) => t.id}
                onRowClick={(t) => onOpen(t.id)}
                storageKey={completed ? "tasks-completed" : "tasks-active"}
                card={(t) => <TaskCard task={t} onOpen={onOpen} />}
                groups={completed ? undefined : GROUPS}
                groupOf={completed ? undefined : (t) => snap?.group[t.id] ?? groupKey(t)}
                query={filter.q ?? ""}
                onQuery={(q) => onFilter({ ...filter, ...(q ? { q } : { q: undefined }) })}
                filters={filters}
                onFilters={setFilters}
                resultLine={(shown, all) => (
                    <>
                        {shown} of {all} {all === 1 ? "task" : "tasks"} in {env?.name ?? "this environment"} match.
                        {elsewhere.map((x) => <Button key={x.env.id} size="sm" variant="ghost" onClick={() => onFilter(filter, x.env.id)}>{x.n} more {x.n === 1 ? "matches" : "match"} in {x.env.name}</Button>)}
                    </>
                )}
                bulkActions={(sel, clear) => (
                    <Button size="sm" variant="danger" onClick={() => { onDeleteTasks(sel.map((t) => t.id)); clear(); }}>Delete</Button>
                )}
                empty={completed
                    ? <EmptyState icon="checkCircle" title="No completed tasks in this environment yet" />
                    : <EmptyState icon="tasks" title={`No tasks in ${env?.name ?? "this environment"} yet`} action={env ? <Button variant="primary" onClick={onNewTask}><Icon name="plus" />Pick from my tickets</Button> : undefined} />}
            />
            </div>
        </PageFrame>
    );
};
