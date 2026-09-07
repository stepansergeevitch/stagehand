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
    <section className="card">
        <div className="actions" style={{ marginTop: 0 }}><button className="primary" onClick={onAdd}>+ Environment</button></div>
        <div className="table-wrap">
            <table>
                <thead><tr><th>Name</th><th>Path</th><th>Repos</th><th>Base</th><th>Tasks</th><th>Config dir</th><th>Task system</th><th></th></tr></thead>
                <tbody>
                    {envs.map((e) => {
                        const n = tasks.filter((t) => t.env_id === e.id).length;
                        return (
                            <tr key={e.id}>
                                <td><b>{e.name}</b></td>
                                <td><code>{e.path}</code></td>
                                <td>{repoList(e.repos)}</td>
                                <td><code>{e.base_branch}</code></td>
                                <td>{n}</td>
                                <td>{accounts.find((a) => a.id === e.default_account_id)?.name ?? "—"}</td>
                                <td>{e.ticket_source}</td>
                                <td className="row-actions">
                                    <button onClick={() => onConfigure(e.id)}>Configure</button>
                                    <button className="danger" disabled={n > 0} title={n > 0 ? "delete its tasks first" : "remove this environment from Stagehand (files untouched)"} onClick={() => { if (confirm(`Remove environment ${e.name} from Stagehand? Files on disk are not touched.`)) void onDelete(e.id); }}>Delete</button>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    </section>
);

const AccountList = ({ accounts, envs, tasks, settings, onAdd, act, onTerminal, onChanged }: { accounts: Account[]; envs: Env[]; tasks: Task[]; settings: Settings | null; onAdd: () => void; act: (fn: () => Promise<unknown>) => Promise<void>; onTerminal: (n: string) => void; onChanged: () => Promise<void> }) => {
    const [adopt, setAdopt] = useState({ name: "", dir: "" });
    const [busy, setBusy] = useState<string | null>(null);
    const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
    return (
        <section className="card">
            <div className="actions" style={{ marginTop: 0 }}>
                <button className="primary" onClick={onAdd}>+ Account (log in)</button>
            </div>
            <details>
                <summary>Adopt an existing Claude config dir</summary>
                <div className="env-fields" style={{ maxWidth: 560 }}>
                    <label>Name <input value={adopt.name} onChange={(e) => setAdopt({ ...adopt, name: e.target.value })} placeholder="lowercase-name" /></label>
                    <label>Directory <input value={adopt.dir} onChange={(e) => setAdopt({ ...adopt, dir: e.target.value })} placeholder="/Users/you/code/project/.claude" /></label>
                    <button disabled={!adopt.name || !adopt.dir || busy === "adopt"} onClick={async () => { setBusy("adopt"); await act(() => api.adoptAccount(adopt.name.trim(), adopt.dir.trim())); setAdopt({ name: "", dir: "" }); setBusy(null); }}>{busy === "adopt" ? "Checking login and Chrome…" : "Adopt"}</button>
                </div>
            </details>
            <div className="table-wrap">
                <table>
                    <thead><tr><th>Name</th><th>Config dir</th><th>Login</th><th>Plan</th><th>Chrome</th><th>Default model</th><th>5h / 7d</th><th>Failover</th><th></th></tr></thead>
                    <tbody>
                        {accounts.map((a) => {
                            const five = a.limits.find((l) => l.window === "five_hour");
                            const week = a.limits.find((l) => l.window === "seven_day");
                            const used = envs.filter((e) => e.default_account_id === a.id).length + tasks.filter((t) => t.account_id === a.id).length;
                            return (
                                <tr key={a.id}>
                                    <td>
                                        {rename?.id === a.id ? (
                                            <span className="inline-edit">
                                                <input value={rename.name} onChange={(e) => setRename({ id: a.id, name: e.target.value })} />
                                                <button onClick={async () => { await act(() => api.patchAccount(a.id, { name: rename.name.trim() })); setRename(null); }}>Save</button>
                                                <button onClick={() => setRename(null)}>×</button>
                                            </span>
                                        ) : (
                                            <b onDoubleClick={() => setRename({ id: a.id, name: a.name })} title="double-click to rename">{a.name}</b>
                                        )}
                                    </td>
                                    <td><code>{a.config_dir}</code></td>
                                    <td>{a.logged_in ? <span className="chip ok">{a.email ?? "logged in"}</span> : <span className="chip bad">not logged in</span>}</td>
                                    <td>{a.plan ?? "—"}</td>
                                    <td>{a.chrome_capable === null ? "?" : a.chrome_capable ? <span className="chip ok">yes</span> : <span className="chip">no</span>}</td>
                                    <td>{modelLabel(a.default_model, settings?.models) ?? "—"}</td>
                                    <td className="mono">{five ? `${Math.round(five.utilization * 100)}%` : "—"} / {week ? `${Math.round(week.utilization * 100)}%` : "—"}</td>
                                    <td>
                                        <label className="inline"><input type="checkbox" checked={!!a.failover_enabled} onChange={(e) => void act(() => api.patchAccount(a.id, { failover_enabled: e.target.checked }))} /> at {Math.round(a.failover_threshold * 100)}%</label>
                                    </td>
                                    <td className="row-actions">
                                        <button disabled={busy === a.id} onClick={async () => { setBusy(a.id); await act(() => api.refreshAccount(a.id, true)); setBusy(null); }}>{busy === a.id ? "Probing…" : "Refresh + probe"}</button>
                                        <button onClick={async () => { try { const r = await api.loginAccount(a.id); onTerminal(r.terminal); } catch (e) { await onChanged(); } }}>Log in</button>
                                        <button className="danger" disabled={used > 0} title={used > 0 ? "an env or task still uses it" : "forget this account (config dir untouched)"} onClick={() => { if (confirm(`Forget account ${a.name}? Its config dir is not touched.`)) void act(() => api.deleteAccount(a.id)); }}>Delete</button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
};

const TaskManagerList = ({ onError }: { onError: (m: string) => void }) => {
    const [items, setItems] = useState<TaskManager[] | null>(null);
    const [edit, setEdit] = useState<Record<string, { token: string; teamId: string }>>({});
    const [test, setTest] = useState<Record<string, string>>({});
    const load = () => api.taskManagers().then(setItems).catch((e: Error) => onError(e.message));
    useEffect(() => { void load(); }, []);
    if (!items) return <div className="empty">loading…</div>;
    return (
        <section className="card">
            <p className="field-hint">Credentials are stored in ~/.stagehand/config.json. With a token, tickets are fetched server-side (fast, no Claude run); without one, Research fetches them through the account's MCP.</p>
            <div className="table-wrap">
                <table>
                    <thead><tr><th>System</th><th>Status</th><th>Token</th><th>Team id</th><th>Used by</th><th></th></tr></thead>
                    <tbody>
                        {items.map((m) => {
                            const e = edit[m.source] ?? { token: "", teamId: m.teamId ?? "" };
                            return (
                                <tr key={m.source}>
                                    <td><b>{m.label}</b></td>
                                    <td>{m.configured ? <span className="chip ok">configured</span> : <span className="chip">no token</span>}{test[m.source] && <div className="field-hint">{test[m.source]}</div>}</td>
                                    <td><input value={e.token} onChange={(ev) => setEdit({ ...edit, [m.source]: { ...e, token: ev.target.value } })} placeholder={m.token ?? (m.source === "clickup" ? "pk_…" : "lin_api_…")} /></td>
                                    <td>{m.source === "clickup" ? <input value={e.teamId} onChange={(ev) => setEdit({ ...edit, [m.source]: { ...e, teamId: ev.target.value } })} placeholder="team id" /> : "—"}</td>
                                    <td>{m.envs.join(", ") || "—"}</td>
                                    <td className="row-actions">
                                        <button className="primary" disabled={!e.token && e.teamId === (m.teamId ?? "")} onClick={async () => { try { await api.patchTaskManager(m.source, { ...(e.token ? { token: e.token } : {}), ...(m.source === "clickup" ? { teamId: e.teamId || null } : {}) }); setEdit({ ...edit, [m.source]: { token: "", teamId: e.teamId } }); await load(); } catch (err) { onError(String((err as Error).message ?? err)); } }}>Save</button>
                                        <button disabled={!m.configured} onClick={async () => { setTest({ ...test, [m.source]: "testing…" }); const r = await api.testTaskManager(m.source); setTest({ ...test, [m.source]: r.ok ? `OK — ${r.count} ticket(s) assigned to you${r.sample?.length ? `: ${r.sample.join(" · ")}` : ""}` : `failed: ${r.error}` }); }}>Test</button>
                                        <button className="danger" disabled={!m.configured} onClick={async () => { if (!confirm(`Remove the ${m.label} token?`)) return; await api.patchTaskManager(m.source, { token: null }); await load(); }}>Remove token</button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
};
