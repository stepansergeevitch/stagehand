import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BaseCheckChip } from "./components/BaseCheckChip";
import { LabelChips } from "./Labels";
import { labelsOf, STAGE_LABEL, taskLabel, type Env, type Task } from "./api";
import { Badge, Button, Chip, EmptyState, Icon, Input, Tabs } from "@vortex/ds";
import type { TaskList, TaskTab } from "./routes";
import { PageFrame } from "./components/AppShell";
import { DataTable, type DataColumn, type DataGroup } from "./components/DataTable";
import { age, TaskStatusChip, taskNeed, taskState } from "./components/status";
import "./tasks.css";

// The Tasks page (docs/ux-redesign.md §4.1, §4.3 and §6.1): a tab per environment (with the count of tasks waiting on
// you), a paste bar to start tasks from ticket ids, then that environment's tasks as a table in two tabs, Active and
// Completed (finished and stopped). Active is grouped by what the task needs from you (Needs you, Running, Waiting on
// others, Idle) with ONE button per row that opens the place to act; a row opens the task workspace in place of the list.
// The environment tab is the route's `?env=`, the tab its path (`#/tasks/completed`).
//
// Keys (Emacs): C-n / C-p move between rows, RET opens, C-SPC selects, C-s searches, C-c n makes a new task, C-c C-c
// presses the focused row's button, C-g leaves a field.
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

export const TasksPage = ({ envs, envId, env, tasks, visible, list, onList, selected, detailPane, onDeleteTasks, onSelectEnv, onNewTask, onPasteTickets, onOpen }: {
    envs: Env[];
    envId: string;
    env: Env | undefined;
    // Every task (the tab counts) and the environment's tasks (the table).
    tasks: Task[];
    visible: Task[];
    list: TaskList | undefined;
    onList: (list: TaskList | undefined) => void;
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
    const rows = useMemo(
        () => visible.filter((t) => (taskState(t).group === "finished") === completed).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || taskState(a).rank - taskState(b).rank || b.updated_at.localeCompare(a.updated_at)),
        [visible, completed],
    );

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

    // Emacs keys for the list. A chord (C-c …) waits two seconds for its second key.
    const chord = useRef(0);
    const act = useRef({ onNewTask, enabled: !selected });
    act.current = { onNewTask, enabled: !selected };
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (!act.current.enabled || e.defaultPrevented || e.altKey || e.metaKey || document.querySelector("[role=dialog]")) return;
            const typing = isTyping(e.target);
            if (e.ctrlKey && e.code === "KeyG") {
                if (typing) (e.target as HTMLElement).blur();
                chord.current = 0;
                return;
            }
            if (typing) return;
            const inChord = Date.now() - chord.current < 2000;
            if (inChord) {
                chord.current = 0;
                if (e.code === "KeyN" && !e.ctrlKey) {
                    e.preventDefault();
                    act.current.onNewTask();
                } else if (e.code === "KeyC" && e.ctrlKey) {
                    e.preventDefault();
                    const row = (document.activeElement as HTMLElement | null)?.closest("tr[data-row]");
                    row?.querySelector<HTMLButtonElement>("button[data-primary]")?.click();
                }
                return;
            }
            if (e.ctrlKey && e.code === "KeyC" && !window.getSelection()?.toString()) {
                e.preventDefault();
                chord.current = Date.now();
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
        { key: "title", label: "Title", kind: "label", value: (t) => t.title ?? "", filter: false },
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
                groups={completed ? undefined : GROUPS}
                groupOf={completed ? undefined : (t) => taskState(t).group === "finished" ? "parked" : taskState(t).group}
                bulkActions={(sel, clear) => (
                    <Button size="sm" variant="danger" onClick={() => { onDeleteTasks(sel.map((t) => t.id)); clear(); }}>Delete</Button>
                )}
                empty={completed
                    ? <EmptyState icon="checkCircle" title="No completed tasks in this environment yet">Finished and stopped tasks appear here.</EmptyState>
                    : <EmptyState icon="tasks" title="No active tasks in this environment" action={env ? <Button variant="primary" onClick={onNewTask}><Icon name="plus" />Create new task</Button> : undefined}>Paste a ticket id or link to start one.</EmptyState>}
            />
        </PageFrame>
    );
};
