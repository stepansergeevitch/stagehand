import { Chip, type Tone } from "@vortex/ds";
import { STAGE_LABEL, STAGE_ORDER, stageOf, type Stage, type Task, type TaskStatus } from "../api";
import "./status.css";

// The status language (docs/ux-redesign.md §5). One mapping from a task's state to a tone, a word and a rank, used by
// every list, header, tile and palette row so a state looks the same everywhere.
//   warn = you must act     bad = broken         info = an agent is working
//   wait = waiting on others (CI, reviewers, a rate-limit window)      ok = finished      neutral = parked
export interface TaskState {
    label: string;
    tone: Tone;
    pulse: boolean;
    // 0 = look at it first. Sorting by rank is "what needs me now".
    rank: number;
    group: "attention" | "working" | "waiting" | "parked" | "finished";
}

export const taskState = (t: Pick<Task, "status" | "stage">): TaskState => {
    switch (t.status as TaskStatus) {
        case "waiting_user": return { label: "Needs you", tone: "warn", pulse: false, rank: 0, group: "attention" };
        case "blocked": return { label: "Blocked", tone: "warn", pulse: false, rank: 1, group: "attention" };
        case "failed": return { label: "Failed", tone: "bad", pulse: false, rank: 2, group: "attention" };
        case "rate_limited": return { label: "Rate limited", tone: "wait", pulse: false, rank: 3, group: "waiting" };
        case "running": return { label: "Running", tone: "info", pulse: true, rank: 4, group: "working" };
        case "queued": return { label: "Queued", tone: "neutral", pulse: true, rank: 5, group: "working" };
        case "idle": return /^pr_/.test(t.stage) ? { label: "Waiting on GitHub", tone: "wait", pulse: false, rank: 6, group: "waiting" } : { label: "Idle", tone: "neutral", pulse: false, rank: 7, group: "parked" };
        case "done": return { label: "Done", tone: "ok", pulse: false, rank: 9, group: "finished" };
        case "stopped": return { label: "Stopped", tone: "neutral", pulse: false, rank: 8, group: "finished" };
        default: return { label: String(t.status), tone: "neutral", pulse: false, rank: 8, group: "parked" };
    }
};

// A task's status as a chip (a toned chip leads with a dot, so the state is never colour alone).
export const TaskStatusChip = ({ task, label }: { task: Pick<Task, "status" | "stage">; label?: string }) => {
    const s = taskState(task);
    return <Chip tone={s.tone} className={s.pulse ? "pulse" : undefined}>{label ?? s.label}</Chip>;
};

// The stage as plain text: it is a place in the workflow, not a state, so it never takes a tone.
export const StageName = ({ stage }: { stage: Stage }) => <span className="stage-name">{STAGE_LABEL[stage]}</span>;

// Where a task is in the workflow: one segment per stage, past ones filled, the current one in the status tone.
export const StageProgress = ({ task }: { task: Pick<Task, "status" | "stage"> }) => {
    const at = STAGE_ORDER.indexOf(stageOf(task.stage));
    const s = taskState(task);
    return (
        <span className="stage-progress" role="img" aria-label={`${STAGE_LABEL[task.stage]}, step ${at + 1} of ${STAGE_ORDER.length}`}>
            {STAGE_ORDER.map((st, i) => <i key={st} className={i < at ? "past" : i === at ? `now ${s.tone}` : ""} />)}
        </span>
    );
};

export const age = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
};
