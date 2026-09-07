import { useEffect, useState } from "react";
import { api, modelLabel, type Account, type Env, type Settings, type Task, type TaskManager } from "./api";

// List / create / read / update / delete for the three things Stagehand is configured with.
export type ManageTab = "envs" | "accounts" | "managers";

const repoList = (json: string | null): string => {
    try {
        const v: unknown = json ? JSON.parse(json) : [];
        return Array.isArray(v) && v.length ? v.join(", ") : "single repo";
    } catch {
        return "single repo";
    }
};

const TITLE: Record<ManageTab, string> = { envs: "Environments", accounts: "AI accounts", managers: "Task managers" };

export const ManagePage = ({
    tab,
    envs,
    accounts,
    tasks,
    settings,
    onConfigureEnv,
    onAddEnv,
    onAddAccount,
    onChanged,
    onError,
    onTerminal,
}: {
    tab: ManageTab;
    envs: Env[];
    accounts: Account[];
    tasks: Task[];
    settings: Settings | null;
    onConfigureEnv: (id: string) => void;
    onAddEnv: () => void;
    onAddAccount: () => void;
    onChanged: () => Promise<void>;
    onError: (m: string) => void;
    onTerminal: (name: string) => void;
}) => {
    const act = async (fn: () => Promise<unknown>) => {
        try {
            await fn();
            await onChanged();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        }
    };
    return (
        <div className="env-page manage-page">
            <h1>{TITLE[tab]}</h1>
            {tab === "envs" && <EnvList envs={envs} accounts={accounts} tasks={tasks} onConfigure={onConfigureEnv} onAdd={onAddEnv} onDelete={(id) => act(() => api.deleteEnv(id))} />}
            {tab === "accounts" && <AccountList accounts={accounts} envs={envs} tasks={tasks} settings={settings} onAdd={onAddAccount} act={act} onTerminal={onTerminal} onChanged={onChanged} />}
            {tab === "managers" && <TaskManagerList onError={onError} />}
        </div>
    );
};

const EnvList = ({ envs, accounts, tasks, onConfigure, onAdd, onDelete }: { envs: Env[]; accounts: Account[]; tasks: Task[]; onConfigure: (id: string) => void; onAdd: () => void; onDelete: (id: string) => Promise<void> }) => (
    <>
        <div className="actions" style={{ marginTop: 0 }}><button className="primary" onClick={onAdd}>+ Environment</button></div>
        {envs.map((e) => {
            const n = tasks.filter((t) => t.env_id === e.id).length;
            return (
                <section className="card item" key={e.id}>
                    <h2>{e.name} <span className="chip">{e.ticket_source}</span> <span className="chip accent">{e.base_branch}</span></h2>
                    <div className="kv">
                        <b>Path</b><code>{e.path}</code>
                        <b>Repos</b><span>{repoList(e.repos)}</span>
                        <b>Tasks</b><span>{n}</span>
                        <b>Config dir</b><span>{accounts.find((a) => a.id === e.default_account_id)?.name ?? "—"}</span>
                    </div>
                    <div className="actions">
                        <button onClick={() => onConfigure(e.id)}>Configure</button>
                        <button className="danger" disabled={n > 0} title={n > 0 ? "delete its tasks first" : "remove this environment from Stagehand (files untouched)"} onClick={() => { if (confirm(`Remove environment ${e.name} from Stagehand? Files on disk are not touched.`)) void onDelete(e.id); }}>Delete</button>
                    </div>
                </section>
            );
        })}
    </>
);

const AccountList = ({ accounts, envs, tasks, settings, onAdd, act, onTerminal, onChanged }: { accounts: Account[]; envs: Env[]; tasks: Task[]; settings: Settings | null; onAdd: () => void; act: (fn: () => Promise<unknown>) => Promise<void>; onTerminal: (n: string) => void; onChanged: () => Promise<void> }) => {
    const [adopt, setAdopt] = useState({ name: "", dir: "" });
    const [busy, setBusy] = useState<string | null>(null);
    const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
    return (
        <>
            <div className="actions" style={{ marginTop: 0 }}>
                <button className="primary" onClick={onAdd}>+ Account (log in)</button>
            </div>
            <details className="card">
                <summary>Adopt an existing Claude config dir</summary>
                <div className="card-body env-fields" style={{ maxWidth: 560 }}>
                    <label>Name <input value={adopt.name} onChange={(e) => setAdopt({ ...adopt, name: e.target.value })} placeholder="lowercase-name" /></label>
                    <label>Directory <input value={adopt.dir} onChange={(e) => setAdopt({ ...adopt, dir: e.target.value })} placeholder="/Users/you/code/project/.claude" /></label>
                    <button disabled={!adopt.name || !adopt.dir || busy === "adopt"} onClick={async () => { setBusy("adopt"); await act(() => api.adoptAccount(adopt.name.trim(), adopt.dir.trim())); setAdopt({ name: "", dir: "" }); setBusy(null); }}>{busy === "adopt" ? "Checking login and Chrome…" : "Adopt"}</button>
                </div>
            </details>
            {accounts.map((a) => {
                const five = a.limits.find((l) => l.window === "five_hour");
                const week = a.limits.find((l) => l.window === "seven_day");
                const used = envs.filter((e) => e.default_account_id === a.id).length + tasks.filter((t) => t.account_id === a.id).length;
                return (
                    <section className="card item" key={a.id}>
                        <h2>
                            {rename?.id === a.id ? (
                                <span className="inline-edit">
                                    <input value={rename.name} onChange={(e) => setRename({ id: a.id, name: e.target.value })} />
                                    <button onClick={async () => { await act(() => api.patchAccount(a.id, { name: rename.name.trim() })); setRename(null); }}>Save</button>
                                    <button onClick={() => setRename(null)}>×</button>
                                </span>
                            ) : (
                                <span onDoubleClick={() => setRename({ id: a.id, name: a.name })} title="double-click to rename">{a.name}</span>
                            )}
                            {a.logged_in ? <span className="chip ok">{a.email ?? "logged in"}</span> : <span className="chip bad">not logged in</span>}
                            {a.plan && <span className="chip">{a.plan}</span>}
                            {a.chrome_capable === 1 && <span className="chip ok">chrome</span>}
                        </h2>
                        <div className="kv">
                            <b>Config dir</b><code>{a.config_dir}</code>
                            <b>Default model</b><span>{modelLabel(a.default_model, settings?.models) ?? "—"}</span>
                            <b>Usage 5h / 7d</b><span className="mono">{five ? `${Math.round(five.utilization * 100)}%` : "—"} / {week ? `${Math.round(week.utilization * 100)}%` : "—"}</span>
                            <b>Failover</b>
                            <label className="inline"><input type="checkbox" checked={!!a.failover_enabled} onChange={(e) => void act(() => api.patchAccount(a.id, { failover_enabled: e.target.checked }))} /> hand work to another account at {Math.round(a.failover_threshold * 100)}%</label>
                        </div>
                        <div className="actions">
                            <button disabled={busy === a.id} onClick={async () => { setBusy(a.id); await act(() => api.refreshAccount(a.id, true)); setBusy(null); }}>{busy === a.id ? "Probing…" : "Refresh + probe"}</button>
                            <button onClick={async () => { try { const r = await api.loginAccount(a.id); onTerminal(r.terminal); } catch (e) { await onChanged(); } }}>Log in</button>
                            <button className="danger" disabled={used > 0} title={used > 0 ? "an env or task still uses it" : "forget this account (config dir untouched)"} onClick={() => { if (confirm(`Forget account ${a.name}? Its config dir is not touched.`)) void act(() => api.deleteAccount(a.id)); }}>Delete</button>
                        </div>
                    </section>
                );
            })}
        </>
    );
};

const TaskManagerList = ({ onError }: { onError: (m: string) => void }) => {
    const [items, setItems] = useState<TaskManager[] | null>(null);
    const [edit, setEdit] = useState<Record<string, { token: string; teamId: string }>>({});
    const [test, setTest] = useState<Record<string, { ok: boolean; text: string; sample?: string[] }>>({});
    const load = () => api.taskManagers().then(setItems).catch((e: Error) => onError(e.message));
    useEffect(() => { void load(); }, []);
    if (!items) return <div className="empty">loading…</div>;
    return (
        <>
            <p className="field-hint">Credentials are stored in ~/.stagehand/config.json. With a token, tickets are fetched server-side (fast, no Claude run); without one, Research fetches them through the account's MCP.</p>
            {items.map((m) => {
                const e = edit[m.source] ?? { token: "", teamId: m.teamId ?? "" };
                const t = test[m.source];
                return (
                    <section className="card manager" key={m.source}>
                        <h2>{m.label} {m.configured ? <span className="chip ok">configured</span> : <span className="chip">no token</span>}</h2>
                        <div className="kv">
                            <b>Used by</b><span>{m.envs.join(", ") || "no environment yet"}</span>
                        </div>
                        <div className="env-fields manager-fields">
                            <label>{m.source === "clickup" ? "Personal API token" : "API key"}
                                <input value={e.token} onChange={(ev) => setEdit({ ...edit, [m.source]: { ...e, token: ev.target.value } })} placeholder={m.token ?? (m.source === "clickup" ? "pk_…" : "lin_api_…")} />
                            </label>
                            {m.source === "clickup" && (
                                <label>Team id
                                    <input value={e.teamId} onChange={(ev) => setEdit({ ...edit, [m.source]: { ...e, teamId: ev.target.value } })} placeholder="team id" />
                                </label>
                            )}
                        </div>
                        <div className="actions">
                            <button className="primary" disabled={!e.token && e.teamId === (m.teamId ?? "")} onClick={async () => { try { await api.patchTaskManager(m.source, { ...(e.token ? { token: e.token } : {}), ...(m.source === "clickup" ? { teamId: e.teamId || null } : {}) }); setEdit({ ...edit, [m.source]: { token: "", teamId: e.teamId } }); await load(); } catch (err) { onError(String((err as Error).message ?? err)); } }}>Save</button>
                            <button disabled={!m.configured} onClick={async () => { setTest({ ...test, [m.source]: { ok: true, text: "testing…" } }); const r = await api.testTaskManager(m.source); setTest({ ...test, [m.source]: r.ok ? { ok: true, text: `OK — ${r.count} ticket(s) assigned to you`, sample: r.sample } : { ok: false, text: `failed: ${r.error}` } }); }}>Test</button>
                            <button className="danger" disabled={!m.configured} onClick={async () => { if (!confirm(`Remove the ${m.label} token?`)) return; await api.patchTaskManager(m.source, { token: null }); await load(); }}>Remove token</button>
                        </div>
                        {t && (
                            <div className={`test-result ${t.ok ? "" : "bad"}`}>
                                <div>{t.text}</div>
                                {t.sample && t.sample.length > 0 && <ul className="plain">{t.sample.map((s) => <li key={s}>{s}</li>)}</ul>}
                            </div>
                        )}
                    </section>
                );
            })}
        </>
    );
};
