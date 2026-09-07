import { useEffect, useState } from "react";
import { api, modelLabel, type Account, type ConfigDir, type Env, type Settings, type Task, type TaskManager } from "./api";

// List / create / read / update / delete for the things Stagehand is configured with.
export type ManageTab = "envs" | "dirs" | "accounts" | "managers";

const repoList = (json: string | null): string => {
    try {
        const v: unknown = json ? JSON.parse(json) : [];
        return Array.isArray(v) && v.length ? v.join(", ") : "single repo";
    } catch {
        return "single repo";
    }
};

const TITLE: Record<ManageTab, string> = { envs: "Environments", dirs: "Claude config dirs", accounts: "AI accounts", managers: "Task managers" };

export const ManagePage = ({
    tab,
    envs,
    configDirs,
    accounts,
    tasks,
    settings,
    onConfigureEnv,
    onOpenDir,
    onAddEnv,
    onAddAccount,
    onChanged,
    onError,
    onTerminal,
}: {
    tab: ManageTab;
    envs: Env[];
    configDirs: ConfigDir[];
    accounts: Account[];
    tasks: Task[];
    settings: Settings | null;
    onConfigureEnv: (id: string) => void;
    onOpenDir: (id: string) => void;
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
            {tab === "envs" && <EnvList envs={envs} configDirs={configDirs} accounts={accounts} tasks={tasks} onConfigure={onConfigureEnv} onAdd={onAddEnv} onDelete={(id) => act(() => api.deleteEnv(id))} />}
            {tab === "dirs" && <ConfigDirList dirs={configDirs} onOpen={onOpenDir} act={act} />}
            {tab === "accounts" && <AccountList accounts={accounts} envs={envs} tasks={tasks} settings={settings} onAdd={onAddAccount} act={act} onTerminal={onTerminal} onError={onError} />}
            {tab === "managers" && <TaskManagerList onError={onError} />}
        </div>
    );
};

const EnvList = ({ envs, configDirs, accounts, tasks, onConfigure, onAdd, onDelete }: { envs: Env[]; configDirs: ConfigDir[]; accounts: Account[]; tasks: Task[]; onConfigure: (id: string) => void; onAdd: () => void; onDelete: (id: string) => Promise<void> }) => (
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
                        <b>Config dir</b><span>{configDirs.find((d) => d.id === e.config_dir_id)?.name ?? "server default"}</span>
                        <b>Default account</b><span>{accounts.find((a) => a.id === e.default_account_id)?.name ?? "first usable"}</span>
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

const ConfigDirList = ({ dirs, onOpen, act }: { dirs: ConfigDir[]; onOpen: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const [add, setAdd] = useState({ name: "", path: "" });
    const [probing, setProbing] = useState<string | null>(null);
    return (
        <>
            <p className="field-hint">A config dir is a Claude directory on this host (skills, hooks, subagents, commands, MCP servers, CLAUDE.md) plus the commit/branch/PR rules Stagehand enforces. Environments point at one; any AI account with a token can run in any dir.</p>
            <details className="card">
                <summary>Register a config dir</summary>
                <div className="card-body env-fields" style={{ maxWidth: 560 }}>
                    <label>Name <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="dualentry" /></label>
                    <label>Directory <input value={add.path} onChange={(e) => setAdd({ ...add, path: e.target.value })} placeholder="/Users/you/code/project/.claude" /></label>
                    <button className="primary" disabled={!add.name.trim() || !add.path.trim()} onClick={async () => { await act(() => api.addConfigDir(add.name.trim(), add.path.trim())); setAdd({ name: "", path: "" }); }}>Register</button>
                </div>
            </details>
            {dirs.map((d) => {
                const c = d.contents;
                return (
                    <section className="card item" key={d.id}>
                        <h2>
                            {d.name}
                            {!c.exists && <span className="chip bad">missing on disk</span>}
                            {d.chrome_capable === 1 ? <span className="chip ok">chrome</span> : d.chrome_capable === 0 ? <span className="chip">no chrome</span> : <span className="chip">chrome not probed</span>}
                        </h2>
                        <div className="kv">
                            <b>Path</b><code>{d.path}</code>
                            <b>Contains</b>
                            <span>
                                {[
                                    `${c.skills.length} skill${c.skills.length === 1 ? "" : "s"}`,
                                    c.hooks.length ? `hooks on ${c.hooks.join(", ")}` : "no hooks",
                                    `${c.agents.length} subagent${c.agents.length === 1 ? "" : "s"}`,
                                    `${c.mcpServers.length} MCP server${c.mcpServers.length === 1 ? "" : "s"}`,
                                    c.hasClaudeMd ? "CLAUDE.md" : "no CLAUDE.md",
                                ].join(" · ")}
                            </span>
                            <b>Used by</b><span>{d.envs.join(", ") || "no environment yet"}</span>
                            <b>Runnable with</b><span>{d.usable_accounts.join(", ") || "no account (needs a token)"}</span>
                        </div>
                        <div className="actions">
                            <button onClick={() => onOpen(d.id)}>Rules and contents</button>
                            <button disabled={probing === d.id || d.usable_accounts.length === 0} title={d.usable_accounts.length === 0 ? "no account can run in this dir" : "run a tiny agent with --chrome to check the extension bridge"} onClick={async () => { setProbing(d.id); await act(() => api.probeConfigDir(d.id)); setProbing(null); }}>{probing === d.id ? "Probing…" : "Probe Chrome"}</button>
                            <button className="danger" disabled={d.envs.length > 0} title={d.envs.length ? "an environment still uses it" : "forget this dir (nothing on disk changes)"} onClick={() => { if (confirm(`Forget config dir ${d.name}? Nothing on disk is touched.`)) void act(() => api.deleteConfigDir(d.id)); }}>Delete</button>
                        </div>
                    </section>
                );
            })}
        </>
    );
};

const AccountList = ({ accounts, envs, tasks, settings, onAdd, act, onTerminal, onError }: { accounts: Account[]; envs: Env[]; tasks: Task[]; settings: Settings | null; onAdd: () => void; act: (fn: () => Promise<unknown>) => Promise<void>; onTerminal: (n: string) => void; onError: (m: string) => void }) => {
    const onChangedSafe = () => act(async () => undefined);
    const [busy, setBusy] = useState<string | null>(null);
    const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
    const [verify, setVerify] = useState<Record<string, { ok: boolean; text: string }>>({});
    return (
        <>
            <p className="field-hint">An AI account is a provider login, stored as a long-lived token; it can run in any config dir. Accounts without a token are legacy browser logins tied to one directory.</p>
            <div className="actions" style={{ marginTop: 0 }}>
                <button className="primary" onClick={onAdd}>+ Account</button>
            </div>
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
                            <span className="chip">{a.provider}</span>
                            {a.setting_up ? <span className="chip wait">token setup in progress</span> : a.has_token ? <span className="chip ok">token</span> : a.logged_in ? <span className="chip warn">legacy login</span> : <span className="chip bad">no auth</span>}
                            {a.email && <span className="chip">{a.email}</span>}
                            {a.plan && <span className="chip">{a.plan}</span>}
                        </h2>
                        <div className="kv">
                            <b>Runs in</b><span>{a.has_token ? "any config dir" : a.logged_in ? <>only <code>{a.auth_dir}</code> (set up a token to use it anywhere)</> : "nowhere yet — set up a token"}</span>
                            <b>Default model</b><span>{modelLabel(a.default_model, settings?.models) ?? "—"}</span>
                            <b>Usage 5h / 7d</b><span className="mono">{five ? `${Math.round(five.utilization * 100)}%` : "—"} / {week ? `${Math.round(week.utilization * 100)}%` : "—"}</span>
                            <b>Failover</b>
                            <label className="inline"><input type="checkbox" checked={!!a.failover_enabled} onChange={(e) => void act(() => api.patchAccount(a.id, { failover_enabled: e.target.checked }))} /> when rate-limited, hand the task to another account at under {Math.round(a.failover_threshold * 100)}% usage</label>
                        </div>
                        <div className="actions">
                            <button onClick={async () => { try { const r = await api.setupToken(a.id); onTerminal(r.terminal); } catch (e) { onError(String((e as Error).message ?? e)); } }}>{a.has_token ? "Renew token" : "Set up token"}</button>
                            <button disabled={busy === a.id} onClick={async () => {
                                setBusy(a.id);
                                setVerify({ ...verify, [a.id]: { ok: true, text: "running a trivial agent turn…" } });
                                try {
                                    const r = await api.refreshAccount(a.id);
                                    setVerify((v) => ({ ...v, [a.id]: { ok: r.ok, text: r.detail } }));
                                    await onChangedSafe();
                                } catch (e) {
                                    setVerify((v) => ({ ...v, [a.id]: { ok: false, text: String((e as Error).message ?? e) } }));
                                } finally {
                                    setBusy(null);
                                }
                            }}>{busy === a.id ? "Checking…" : "Verify"}</button>
                            <button className="danger" disabled={used > 0} title={used > 0 ? "an env or task still uses it" : "forget this account and its token"} onClick={() => { if (confirm(`Forget account ${a.name} and its stored token?`)) void act(() => api.deleteAccount(a.id)); }}>Delete</button>
                        </div>
                        {verify[a.id] && <div className={`test-result ${verify[a.id]!.ok ? "" : "bad"}`}>{verify[a.id]!.text}</div>}
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
