import { useMemo, type ReactNode } from "react";
import { BaseCheckChip } from "./components/BaseCheckChip";
import { LabelChips } from "./Labels";
import { labelsOf, STAGE_LABEL, taskLabel, type Env, type Task } from "./api";
import { Button, EmptyState, Icon, Select, Tabs } from "@vortex/ds";
import type { TaskList } from "./routes";
import { StatRow, StatTile } from "./components/StatTile";
import { PageFrame } from "./components/AppShell";
import { DataTable, type DataColumn } from "./components/DataTable";
import { age, StageCell, TaskStatusChip, taskState } from "./components/status";
import "./tasks.css";

// The Tasks page (docs/ux-redesign.md §4.1, §4.3 and §6.1): the four triage tiles (all environments), then one
// environment's tasks as a table in two tabs, Active (not finished, most urgent first) and Completed (finished and
// stopped); a row opens the task workspace in place of the list. The environment picker is the route's `?env=`, the
// tab its path (`#/tasks/completed`).
export const TasksPage = ({ envs, envId, env, tasks, visible, list, onList, selected, detailPane, onDeleteTasks, onSelectEnv, onNewTask, onOpen }: {
    envs: Env[];
    envId: string;
    env: Env | undefined;
    // Every task (the tiles) and the environment's tasks (the table).
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
    onOpen: (id: string) => void;
}) => {
    // Pinned first, then by what needs you, then the latest.
    const completed = list === "completed";
    const count = (g: ReturnType<typeof taskState>["group"]) => tasks.filter((t) => taskState(t).group === g).length;
    const attention = count("attention");
    const working = count("working");
    const waiting = count("waiting");
    const rows = useMemo(
        () => visible.filter((t) => (taskState(t).group === "finished") === completed).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || taskState(a).rank - taskState(b).rank || b.updated_at.localeCompare(a.updated_at)),
        [visible, completed],
    );
    const columns: DataColumn<Task>[] = [
        { key: "status", label: "Status", value: (t) => taskState(t).label, filter: "auto", render: (t) => <TaskStatusChip task={t} /> },
        { key: "task", label: "Task", value: (t) => taskLabel(t), filter: false, render: (t) => <b className="task-id">{t.pinned ? <Icon name="pin" aria-label="Pinned" /> : null}{taskLabel(t)}</b> },
        { key: "title", label: "Title", kind: "label", value: (t) => t.title ?? "", filter: false },
        { key: "stage", label: "Stage", value: (t) => STAGE_LABEL[t.stage], filter: "auto", render: (t) => <StageCell task={t} /> },
        { key: "latest", label: "Latest", value: (t) => t.status_line ?? "", filter: false, defaultHidden: true },
        { key: "base", label: "Base", value: (t) => t.base_check_state ?? "", filter: false, defaultHidden: true, render: (t) => <BaseCheckChip state={t.base_check_state} detail={t.base_check_detail} /> },
        { key: "labels", label: "Labels", value: (t) => labelsOf(t).map((l) => l.text).join(", "), filter: false, defaultHidden: true, render: (t) => <LabelChips labels={labelsOf(t)} /> },
        { key: "age", label: "Updated", kind: "num", value: (t) => Date.now() - new Date(t.updated_at).getTime(), render: (t) => age(t.updated_at) },
    ];
    if (selected) return <PageFrame width="wide">{detailPane}</PageFrame>;
    return (
        <PageFrame width="wide">
            <StatRow>
                <StatTile label="Needs you" tone={attention ? "warn" : "neutral"} value={attention} sub={attention ? "Waiting on a decision, blocked or failed" : "Nothing is waiting on you"} />
                <StatTile label="Running" tone={working ? "info" : "neutral"} value={working} sub="Agents working or queued" />
                <StatTile label="Waiting on others" tone={waiting ? "wait" : "neutral"} value={waiting} sub="GitHub checks, reviewers, rate limits" />
                <StatTile label="Environments" icon="server" value={envs.length} />
            </StatRow>
            <Tabs
                items={[{ key: "active", label: "Active" }, { key: "completed", label: "Completed" }]}
                active={completed ? "completed" : "active"}
                onChange={(k) => onList(k === "completed" ? "completed" : undefined)}
            />
            <DataTable
                title="Tasks"
                entity="task"
                actions={
                    <Select value={envId} onChange={(e) => onSelectEnv(e.target.value)} aria-label="Environment">
                        {envs.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.base_branch})</option>)}
                    </Select>
                }
                onCreate={onNewTask}
                createDisabled={env ? undefined : "Pick an environment first"}
                columns={columns}
                rows={rows}
                rowKey={(t) => t.id}
                onRowClick={(t) => onOpen(t.id)}
                storageKey={completed ? "tasks-completed" : "tasks"}
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
