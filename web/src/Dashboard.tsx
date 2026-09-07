import { useMemo } from "react";
import { STAGE_LABEL, type Env, type Task, type TaskStatus } from "./api";

// Every task across all environments that is waiting on a human or has stopped making progress.
const ATTENTION: TaskStatus[] = ["waiting_user", "blocked", "rate_limited", "failed"];
const RANK: Record<string, number> = { waiting_user: 0, blocked: 1, failed: 2, rate_limited: 3 };
const CHIP: Record<string, [string, string]> = {
    waiting_user: ["needs you", "wait"], blocked: ["blocked", "warn"], failed: ["failed", "bad"], rate_limited: ["rate limited", "warn"],
};

const age = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
};

export const needsAttention = (t: Task): boolean => ATTENTION.includes(t.status);

export const Dashboard = ({ envs, tasks, onOpen }: { envs: Env[]; tasks: Task[]; onOpen: (t: Task) => void }) => {
    const byEnv = useMemo(() => {
        const m = new Map<string, Task[]>();
        for (const t of tasks.filter(needsAttention)) m.set(t.env_id, [...(m.get(t.env_id) ?? []), t]);
        for (const list of m.values()) list.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.updated_at.localeCompare(a.updated_at));
        return envs.map((e) => [e, m.get(e.id) ?? []] as const);
    }, [envs, tasks]);
    const total = byEnv.reduce((n, [, l]) => n + l.length, 0);
    return (
        <div className="env-page dashboard">
            <h1>Dashboard</h1>
            <p className="field-hint">{total === 0 ? "Nothing needs your attention." : `${total} task${total === 1 ? "" : "s"} waiting on you across ${byEnv.filter(([, l]) => l.length).length} environment(s).`}</p>
            {byEnv.map(([e, list]) => (
                <section className="card" key={e.id}>
                    <h2>{e.name} <span className="chip">{list.length}</span></h2>
                    {list.length === 0 && <div className="quiet">all clear</div>}
                    {list.map((t) => {
                        const [label, cls] = CHIP[t.status] ?? [t.status, ""];
                        return (
                            <div key={t.id} className="attn" onClick={() => onOpen(t)}>
                                <span className={`chip ${cls}`}>{label}</span>
                                <span className="name">{t.ticket_id}<small>{t.title ?? ""}</small></span>
                                <span className="stage-name">{STAGE_LABEL[t.stage]}</span>
                                <span className="age">{age(t.updated_at)}</span>
                                {t.status_line && <span className="line">{t.status_line}</span>}
                            </div>
                        );
                    })}
                </section>
            ))}
        </div>
    );
};
