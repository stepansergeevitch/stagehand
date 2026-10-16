import { useMemo } from "react";
import { labelsOf, STAGE_LABEL, taskLabel, type Env, type Readiness, type Task } from "./api";
import { LabelChips } from "./Labels";
import { Button, EmptyState } from "@vortex/ds";
import { DataTable, type DataColumn } from "./components/DataTable";
import { PageHeader } from "./components/PageHeader";
import { Panel } from "./components/Panel";
import { StatRow, StatTile } from "./components/StatTile";
import { KeyValue } from "./components/KeyValue";
import { age, StageProgress, TaskStatusChip, taskState } from "./components/status";

// Overview: what needs me now, then what is moving. Every task that is not finished, in one table sorted by urgency
// (needs you, blocked, failed, rate limited, running, waiting on GitHub, idle); finished and stopped tasks live on the
// Tasks page. docs/ux-redesign.md §6.1.
export const needsAttention = (t: Task): boolean => taskState(t).group === "attention";

export const Dashboard = ({ envs, tasks, readiness, onOpen, onOpenEnv }: { envs: Env[]; tasks: Task[]; readiness: Readiness[]; onOpen: (t: Task) => void; onOpenEnv?: (id: string) => void }) => {
    const envName = useMemo(() => new Map(envs.map((e) => [e.id, e.name])), [envs]);
    const rows = useMemo(
        () =>
            tasks
                .filter((t) => taskState(t).group !== "finished")
                .sort((a, b) => taskState(a).rank - taskState(b).rank || b.updated_at.localeCompare(a.updated_at)),
        [tasks],
    );
    const count = (g: ReturnType<typeof taskState>["group"]) => tasks.filter((t) => taskState(t).group === g).length;
    const attention = count("attention");
    const working = count("working");
    const waiting = count("waiting");
    const warnings = readiness.filter((r) => r.warnings.length);
    const columns: DataColumn<Task>[] = [
        { key: "status", label: "Status", value: (t) => taskState(t).label, filter: "auto", render: (t) => <TaskStatusChip task={t} /> },
        { key: "task", label: "Task", value: (t) => taskLabel(t), filter: false, render: (t) => <b>{taskLabel(t)}</b> },
        { key: "title", label: "Title", kind: "label", value: (t) => t.title ?? "", filter: false },
        { key: "env", label: "Environment", value: (t) => envName.get(t.env_id) ?? "", filter: "auto" },
        { key: "stage", label: "Stage", value: (t) => STAGE_LABEL[t.stage], filter: "auto", render: (t) => <StageProgressCell t={t} /> },
        { key: "latest", label: "Latest", value: (t) => t.status_line ?? "", filter: false, defaultHidden: true },
        { key: "labels", label: "Labels", value: (t) => labelsOf(t).map((l) => l.text).join(", "), filter: false, defaultHidden: true, render: (t) => <LabelChips labels={labelsOf(t)} /> },
        { key: "age", label: "Updated", kind: "num", value: (t) => Date.now() - new Date(t.updated_at).getTime(), sortable: true, render: (t) => age(t.updated_at) },
    ];
    return (
        <div className="overview">
            <PageHeader title="Overview" />
            <StatRow>
                <StatTile label="Needs you" tone={attention ? "warn" : "neutral"} value={attention} sub={attention ? "Waiting on a decision, blocked or failed" : "Nothing is waiting on you"} />
                <StatTile label="Running" tone={working ? "info" : "neutral"} value={working} sub="Agents working or queued" />
                <StatTile label="Waiting on others" tone={waiting ? "wait" : "neutral"} value={waiting} sub="GitHub checks, reviewers, rate limits" />
                <StatTile label="Environments" icon="server" value={envs.length} sub={warnings.length ? `${warnings.length} not ready` : "All ready"} />
            </StatRow>
            {warnings.length > 0 && (
                <Panel title="Not ready" tone="warn" badge={warnings.length} hint="Found now, not when a stage blocks. Fix these on the AI accounts and Integrations pages.">
                    <KeyValue
                        items={warnings.map((r) => ({
                            label: onOpenEnv ? <Button variant="ghost" size="sm" onClick={() => onOpenEnv(r.envId)}>{r.envName}</Button> : r.envName,
                            value: <ul className="plain">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>,
                        }))}
                    />
                </Panel>
            )}
            <DataTable
                embedded
                title="Tasks in flight"
                columns={columns}
                rows={rows}
                rowKey={(t) => t.id}
                onRowClick={onOpen}
                selectable={false}
                storageKey="overview"
                empty={<EmptyState icon="checkCircle" title="All clear">No task is running or waiting. Start one from the Tasks page.</EmptyState>}
            />
        </div>
    );
};

const StageProgressCell = ({ t }: { t: Task }) => (
    <span className="stage-cell">
        {STAGE_LABEL[t.stage]}
        <StageProgress task={t} />
    </span>
);
