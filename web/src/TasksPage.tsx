import { useMemo, type ReactNode } from "react";
import { BaseCheckChip } from "./components/BaseCheckChip";
import { LabelChips } from "./Labels";
import { labelsOf, STAGE_LABEL, taskLabel, type Env, type Task } from "./api";
import { Button, Icon, Input, Select, StatusDot } from "@vortex/ds";
import { age, taskState } from "./components/status";
import "./tasks.css";

// The Tasks page: the environment's tasks on the left (grouped by what they are doing), the open task on the right; on
// phones one pane at a time. Phase 2 (docs/ux-redesign.md §6.2) replaces the list with a DataTable and the right pane with
// the task workspace; until then this keeps the master/detail behaviour in the new shell.
type Group = "Pinned" | "Needs input" | "Working" | "Idle" | "Failed" | "Completed" | "Stopped";
const GROUP_ORDER: Group[] = ["Pinned", "Needs input", "Working", "Idle", "Failed", "Completed", "Stopped"];

const groupOf = (t: Task): Group => {
    if (t.pinned) return "Pinned";
    switch (t.status) {
        case "waiting_user":
        case "blocked":
            return "Needs input";
        case "running":
        case "queued":
            return "Working";
        case "failed":
            return "Failed";
        case "done":
            return "Completed";
        case "stopped":
            return "Stopped";
        default:
            return "Idle";
    }
};

export const TasksPage = ({ envs, envId, env, visible, selected, detailPane, picked, onPick, onDeletePicked, onSelectEnv, onNewTask, onOpen, onClose }: {
    envs: Env[];
    envId: string;
    env: Env | undefined;
    // The environment's tasks.
    visible: Task[];
    selected: string | null;
    // What the right pane shows: the task view, a loading line, or the empty hint.
    detailPane: ReactNode;
    picked: Set<string>;
    onPick: (next: Set<string>) => void;
    onDeletePicked: () => void;
    onSelectEnv: (id: string) => void;
    onNewTask: () => void;
    onOpen: (id: string) => void;
    onClose: () => void;
}) => {
    const grouped = useMemo(() => {
        const m = new Map<Group, Task[]>();
        for (const t of visible) m.set(groupOf(t), [...(m.get(groupOf(t)) ?? []), t]);
        return GROUP_ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
    }, [visible]);
    return (
        <div className={`tasks-split ${selected ? "has-selection" : ""}`}>
            <aside className="list">
                <div className="list-head">
                    <Select value={envId} onChange={(e) => onSelectEnv(e.target.value)} aria-label="Environment">
                        {envs.map((e) => (
                            <option key={e.id} value={e.id}>{e.name} ({e.base_branch})</option>
                        ))}
                    </Select>
                    <Button variant="primary" disabled={!env} onClick={onNewTask}><Icon name="plus" />New task</Button>
                    {picked.size > 0 && (
                        <div className="bulk-bar">
                            <span>{picked.size} selected</span>
                            <Button size="sm" variant="danger" onClick={onDeletePicked}>Delete selected</Button>
                            <Button size="sm" onClick={() => onPick(new Set())}>Clear</Button>
                        </div>
                    )}
                </div>
                {visible.length === 0 && <div className="empty">No tasks in this env yet.</div>}
                {grouped.map(([g, list]) => (
                    <div key={g}>
                        <div className="group">{g}</div>
                        {list.map((t) => {
                            const s = taskState(t);
                            return (
                                <div key={t.id} className={`row ${selected === t.id ? "selected" : ""} ${picked.has(t.id) ? "picked" : ""}`} onClick={() => onOpen(t.id)}>
                                    <Input
                                        type="checkbox"
                                        className="pick"
                                        title="Select for bulk delete"
                                        aria-label="Select for bulk delete"
                                        checked={picked.has(t.id)}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(t.id); else n.delete(t.id); onPick(n); }}
                                    />
                                    <StatusDot tone={s.tone} pulse={s.pulse} title={s.label} />
                                    <span className="name">{taskLabel(t)}<small>{t.title ?? ""}</small></span>
                                    <span className="age">{age(t.updated_at)}</span>
                                    <span className="pr"><BaseCheckChip state={t.base_check_state} detail={t.base_check_detail} compact /></span>
                                    <span className="status"><LabelChips labels={labelsOf(t)} /><span className="status-text">{t.status_line ?? STAGE_LABEL[t.stage]}</span></span>
                                </div>
                            );
                        })}
                    </div>
                ))}
            </aside>
            <section className="detail tasks-detail">
                {selected && <Button variant="ghost" size="sm" className="back" onClick={onClose}><Icon name="arrowLeft" />Tasks</Button>}
                {detailPane}
            </section>
        </div>
    );
};
