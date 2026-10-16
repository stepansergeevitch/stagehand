import { useMemo } from "react";
import { labelsOf, STAGE_LABEL, taskLabel, type Env, type Readiness, type Task, type TaskStatus } from "./api";
import { LabelChips } from "./Labels";
import { Card, Chip } from "./components/ui";

// Every task across all environments, grouped by what it is doing: waiting on the human, working, or waiting on others
// (GitHub checks / reviewers). Finished and stopped tasks stay on the Tasks page.
const ATTENTION: TaskStatus[] = ["waiting_user", "blocked", "rate_limited", "failed"];
const WORKING: TaskStatus[] = ["running", "queued"];
const RANK: Record<string, number> = { waiting_user: 0, blocked: 1, failed: 2, rate_limited: 3 };
const CHIP: Record<string, [string, string]> = {
    waiting_user: ["needs you", "wait"], blocked: ["blocked", "warn"], failed: ["failed", "bad"], rate_limited: ["rate limited", "warn"],
    running: ["running", "accent"], queued: ["queued", ""], idle: ["waiting", ""],
};

const age = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
};

export const needsAttention = (t: Task): boolean => ATTENTION.includes(t.status);
const isWorking = (t: Task): boolean => WORKING.includes(t.status);
// Idle in a PR stage = waiting for CI or a reviewer on GitHub.
const waitsOnOthers = (t: Task): boolean => t.status === "idle" && /^pr_/.test(t.stage);

const Row = ({ t, onOpen }: { t: Task; onOpen: (t: Task) => void }) => {
    const [label, cls] = CHIP[t.status] ?? [t.status, ""];
    return (
        <div className="attn" onClick={() => onOpen(t)}>
            <Chip className={`${cls}`}>{label}</Chip>
            <span className="name">{taskLabel(t)}<small>{t.title ?? ""}</small><LabelChips labels={labelsOf(t)} /></span>
            <span className="stage-name">{STAGE_LABEL[t.stage]}</span>
            <span className="age">{age(t.updated_at)}</span>
            {t.status_line && <span className="line">{t.status_line}</span>}
        </div>
    );
};

export const Dashboard = ({ envs, tasks, readiness, onOpen }: { envs: Env[]; tasks: Task[]; readiness: Readiness[]; onOpen: (t: Task) => void }) => {
    const byEnv = useMemo(() => {
        const pick = (pred: (t: Task) => boolean, sort: (a: Task, b: Task) => number) => {
            const m = new Map<string, Task[]>();
            for (const t of tasks.filter(pred)) m.set(t.env_id, [...(m.get(t.env_id) ?? []), t]);
            for (const list of m.values()) list.sort(sort);
            return m;
        };
        const byUpdated = (a: Task, b: Task) => b.updated_at.localeCompare(a.updated_at);
        const attention = pick(needsAttention, (a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || byUpdated(a, b));
        const working = pick(isWorking, byUpdated);
        const others = pick(waitsOnOthers, byUpdated);
        return envs.map((e) => ({ env: e, attention: attention.get(e.id) ?? [], working: working.get(e.id) ?? [], others: others.get(e.id) ?? [] }));
    }, [envs, tasks]);
    const total = byEnv.reduce((n, x) => n + x.attention.length, 0);
    const running = byEnv.reduce((n, x) => n + x.working.length, 0);
    const warnings = readiness.filter((r) => r.warnings.length);
    return (
        <div className="env-page dashboard">
            <h1>Dashboard</h1>
            <p className="field-hint">
                {total === 0 ? "Nothing needs your attention." : `${total} task${total === 1 ? "" : "s"} waiting on you`}
                {running > 0 ? ` · ${running} running` : ""}
                {` across ${envs.length} environment${envs.length === 1 ? "" : "s"}.`}
            </p>
            {warnings.length > 0 && (
                <Card>
                    <h2>Not ready <Chip tone="warn">{warnings.length}</Chip></h2>
                    <p className="field-hint">Found now, not when a stage blocks. Fix these on the AI accounts / Integrations pages.</p>
                    {warnings.map((r) => (
                        <div key={r.envId} className="kv" style={{ marginBottom: 6 }}>
                            <b>{r.envName}</b>
                            <span><ul className="plain" style={{ margin: 0 }}>{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></span>
                        </div>
                    ))}
                </Card>
            )}
            {byEnv.map(({ env: e, attention, working, others }) => (
                <Card key={e.id}>
                    <h2>{e.name} <Chip>{attention.length}</Chip>{working.length > 0 && <Chip tone="accent">{working.length} running</Chip>}</h2>
                    {attention.length === 0 && working.length === 0 && others.length === 0 && <div className="quiet">all clear</div>}
                    {attention.map((t) => <Row key={t.id} t={t} onOpen={onOpen} />)}
                    {working.length > 0 && <div className="group">Running</div>}
                    {working.map((t) => <Row key={t.id} t={t} onOpen={onOpen} />)}
                    {others.length > 0 && <div className="group">Waiting on GitHub / reviewers</div>}
                    {others.map((t) => <Row key={t.id} t={t} onOpen={onOpen} />)}
                </Card>
            ))}
        </div>
    );
};
