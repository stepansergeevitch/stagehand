import { useEffect, useState } from "react";
import { accountBrowserReady, accountOrderOf, api, chromeBrowserLabel, modelLabel, type Account, type ConfigDir, type Env, type ModelOperation, type ModelStage, type PrompterSettings, type PrompterStatus, type Settings, type Task, type TaskManager } from "./api";

// List / create / read / update / delete for the things Stagehand is configured with.
export type ManageTab = "envs" | "dirs" | "accounts" | "integrations";

// Every card on the Integrations page carries one of these, so a new kind of integration announces what it is.
type IntegrationType = "task manager" | "notifications" | "decision model" | "assistant";
const TypeChip = ({ type }: { type: IntegrationType }) => <span className="chip type" title="integration type">{type}</span>;

const repoList = (json: string | null): string => {
    try {
        const v: unknown = json ? JSON.parse(json) : [];
        return Array.isArray(v) && v.length ? v.join(", ") : "single repo";
    } catch {
        return "single repo";
    }
};

const TITLE: Record<ManageTab, string> = { envs: "Environments", dirs: "Claude config dirs", accounts: "AI accounts", integrations: "Integrations" };

// Which model runs what: the global default, one model per stage for its first run on a task and one for every later
// run (review rounds, retries, QA returns), and one per side operation. Every select saves at once.
const MODEL_STAGES: Array<{ key: ModelStage; label: string }> = [
    { key: "research", label: "Research" },
    { key: "design_proposal", label: "Design Proposal" },
    { key: "qa_baseline", label: "QA baseline" },
    { key: "implementation", label: "Implementation" },
    { key: "code_review", label: "Code Review" },
    { key: "manual_qa", label: "Manual QA" },
    { key: "pr_creation_review", label: "PR draft" },
    { key: "pr_fix", label: "PR Fix (any cause)" },
];
const MODEL_OPERATIONS: Array<{ key: ModelOperation; label: string; hint: string }> = [
    { key: "pr_fix_ci", label: "PR Fix for failing checks", hint: "wins over the PR Fix stage model for rounds started from CI" },
    { key: "pr_fix_comments", label: "PR Fix for comments", hint: "rounds started from picked PR comments or Code-changes comments" },
    { key: "chat", label: "Chat (Ask)", hint: "questions in the task's Chat and on diff lines" },
    { key: "instruct", label: "Chat (Do)", hint: "free-text instructions carried out in the worktree" },
    { key: "rebase", label: "Rebase with the agent", hint: "only when the plain git rebase conflicted" },
    { key: "fix_service", label: "Fix a BE/FE start", hint: "the App widget's Fix with agent" },
    { key: "git_edit", label: "Remove a commit", hint: "history edits from Code changes" },
];
const ModelsCard = ({ settings, accounts, act }: { settings: Settings; accounts: Account[]; act: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const fallback = `Account default · ${accounts.filter((a) => a.logged_in).map((a) => `${a.name}: ${modelLabel(a.default_model, settings.models) ?? "?"}`).join(", ") || "no account"}`;
    const options = (blank: string) => settings.models.map((m) => <option key={m.value} value={m.value}>{m.value === "" ? blank : m.label}</option>);
    const first = settings.stageModels ?? {};
    const rerun = settings.stageRerunModels ?? {};
    const ops = settings.operationModels ?? {};
    const globalLabel = settings.defaultModel ? modelLabel(settings.defaultModel, settings.models) ?? settings.defaultModel : "account default";
    return (
        <section className="card item">
            <h2>Models</h2>
            <p className="field-hint">A task created with its own model uses that everywhere. Otherwise a stage's first run on a task takes its "first run" model, every later run of that stage (a review round sent back, Retry, a contract or unblock retry, a QA return to Implementation) takes its "reruns" model, and the side operations take theirs. A blank falls back along the arrows.</p>
            <p className="field-hint">
                {settings.modelsFetchedAt ? `Model list from the Models API, fetched ${new Date(settings.modelsFetchedAt).toLocaleString()}` : "Built-in model list (nothing fetched yet)"}
                {settings.modelsError ? ` · last fetch failed: ${settings.modelsError}` : ""}
                {" "}<button type="button" onClick={() => void act(() => api.refreshModels())}>Refresh</button>
            </p>
            <div className="env-fields" style={{ maxWidth: 560 }}>
                <label className="inline"><input type="checkbox" checked={settings.codeReview !== false} onChange={(e) => void act(() => api.patchSettings({ codeReview: e.target.checked }))} /> Code Review stage after Implementation — gstack's pre-landing checklist applied by a fresh session: mechanical findings fixed and committed, serious open ones sent back to Implementation once, everything shown at User Review</label>
                <label>Global default (the fallback of every blank below)
                    <select value={settings.defaultModel ?? ""} onChange={(e) => void act(() => api.patchSettings({ defaultModel: e.target.value || null }))}>{options(fallback)}</select>
                </label>
            </div>
            <table className="models-table">
                <thead><tr><th>Stage</th><th>First run</th><th>Reruns</th></tr></thead>
                <tbody>
                    {MODEL_STAGES.map((s) => (
                        <tr key={s.key}>
                            <td>{s.label}</td>
                            <td><select value={first[s.key] ?? ""} onChange={(e) => void act(() => api.patchSettings({ stageModels: { [s.key]: e.target.value || null } }))}>{options(`→ global default (${globalLabel})`)}</select></td>
                            <td><select value={rerun[s.key] ?? ""} onChange={(e) => void act(() => api.patchSettings({ stageRerunModels: { [s.key]: e.target.value || null } }))}>{options(`→ first run (${first[s.key] ? modelLabel(first[s.key], settings.models) ?? first[s.key] : globalLabel})`)}</select></td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <table className="models-table">
                <thead><tr><th>Operation</th><th>Model</th><th></th></tr></thead>
                <tbody>
                    {MODEL_OPERATIONS.map((o) => (
                        <tr key={o.key}>
                            <td>{o.label}</td>
                            <td><select value={ops[o.key] ?? ""} onChange={(e) => void act(() => api.patchSettings({ operationModels: { [o.key]: e.target.value || null } }))}>{options(o.key.startsWith("pr_fix") ? `→ PR Fix stage (${first.pr_fix ? modelLabel(first.pr_fix, settings.models) ?? first.pr_fix : globalLabel})` : `→ global default (${globalLabel})`)}</select></td>
                            <td className="quiet">{o.hint}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
};

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
            {tab === "accounts" && settings && <PrompterCard settings={settings} accounts={accounts} onChanged={onChanged} onError={onError} />}
            {tab === "integrations" && <p className="field-hint">External services Stagehand talks to. Each card is tagged with its type: task manager (tickets), notifications (pushes to you), decision model (Jev).</p>}
            {tab === "integrations" && <TaskManagerList onError={onError} />}
            {tab === "integrations" && settings && <NotificationsCard settings={settings} onChanged={onChanged} onError={onError} />}
            {tab === "integrations" && settings && <JevCard settings={settings} onChanged={onChanged} onError={onError} />}
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
                        <b>AI accounts</b><span>{accountOrderOf(e).map((id, i) => `${i + 1}. ${accounts.find((a) => a.id === id)?.name ?? "?"}`).join("  ") || "any that can run in the dir"}</span>
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
    return (
        <>
            <p className="field-hint">A config dir is a Claude directory on this host (skills, hooks, subagents, commands, MCP servers, CLAUDE.md) plus the commit/branch/PR rules Stagehand enforces. Environments point at one; any AI account with a token can run in any dir.</p>
            <details className="card">
                <summary>Register a config dir</summary>
                <div className="card-body env-fields" style={{ maxWidth: 560 }}>
                    <label>Name <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="personal" /></label>
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
                            <button className="danger" disabled={d.envs.length > 0} title={d.envs.length ? "an environment still uses it" : "forget this dir (nothing on disk changes)"} onClick={() => { if (confirm(`Forget config dir ${d.name}? Nothing on disk is touched.`)) void act(() => api.deleteConfigDir(d.id)); }}>Delete</button>
                        </div>
                    </section>
                );
            })}
        </>
    );
};

const fmtTokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

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
            {settings && <ModelsCard settings={settings} accounts={accounts} act={act} />}
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
                            {accountBrowserReady(a) ? <span className="chip ok">chrome{a.chrome_browser_name ? ` · ${a.chrome_browser_name}` : ""}</span> : <span className="chip">no chrome</span>}
                            {a.email && <span className="chip">{a.email}</span>}
                            {a.plan && <span className="chip">{a.plan}</span>}
                        </h2>
                        <div className="kv">
                            <b>Runs in</b><span>{a.has_token ? "any config dir" : a.logged_in ? <>only <code>{a.auth_dir}</code> (set up a token to use it anywhere)</> : "nowhere yet — set up a token"}</span>
                            <b>Browser login</b>
                            <span>
                                {a.login_ok === null ? <span className="chip">unknown — probe</span> : a.login_ok ? <span className="chip ok">in {a.login_dir ?? a.auth_dir}</span> : <span className="chip bad">none</span>}
                                <span className="field-hint">Browser stages (QA, login helper) need a claude.ai browser login plus a Chrome profile whose Claude extension is signed into this account; tokens get no Chrome bridge. A login in the account's own config dir serves envs using that dir; "Log in (browser)" adds one in {a.browser_dir}, which serves every env (the env's config dir is mirrored in). "Probe Chrome" restarts Chrome automatically (closing all its windows/tabs) if the first connection attempt fails — a brand-new login location's first connection often needs that once.</span>
                            </span>
                            <b>Chrome profile</b>
                            <span>
                                {a.chrome_capable === null ? <span className="chip">not probed</span> : a.chrome_capable ? (
                                    <select value={a.chrome_device_id ?? ""} onChange={(e) => void act(() => api.patchAccount(a.id, { chromeDeviceId: e.target.value || null }))}>
                                        <option value="">— pick a profile —</option>
                                        {(a.browsers ?? []).map((b) => <option key={b.deviceId} value={b.deviceId}>{chromeBrowserLabel(b)}{b.account ? ` · ${b.account}` : ""}{b.profile ? "" : ` (${b.deviceId.slice(0, 8)})`}</option>)}
                                    </select>
                                ) : <span className="chip bad">no Chrome bridge under this login</span>}
                            </span>
                            <b>Chrome per QA run</b>
                            <span>
                                <label className="inline"><input type="checkbox" checked={a.chrome_clone_qa === 1} disabled={!a.chrome_device_id} onChange={(e) => void act(() => api.patchAccount(a.id, { chromeCloneQa: e.target.checked }))} /> copy the profile for every browser QA run</label>
                                <span className="field-hint">On: each QA baseline / Manual QA run copies the Chrome profile above (cookies and app logins included, about one second), starts its own Chrome window on the copy with the QA launch flags, drives that window, and deletes the copy afterwards — several browser runs of this account go in parallel (up to maxChromeClonesPerAccount, 3) and your own Chrome is never touched. Log in to the apps in the profile above; every copy inherits it. Off: runs share the profile above, one at a time.</span>
                            </span>
                            <b>Default model</b><span>{modelLabel(a.default_model, settings?.models) ?? "—"}</span>
                            <b>Windows 5h / 7d</b>
                            <span className="mono">
                                {five ? (five.expired ? "? (reset since)" : `${Math.round(five.utilization * 100)}%`) : "—"} / {week ? (week.expired ? "?" : `${Math.round(week.utilization * 100)}%`) : "—"}
                                {five?.updatedAt && <span className="field-hint">as of {new Date(five.updatedAt).toLocaleString()}{a.windows.length ? ` · one window ≈ ${a.windows.map((w) => `$${w.usdPerWindow.toFixed(0)} (${w.window === "five_hour" ? "5 h" : w.window === "seven_day" ? "7 d" : w.window})`).join(", ")} of estimated cost` : ""}</span>}
                            </span>
                            <b>Consumed today / week</b><span className="mono">{fmtTokens(a.usage?.today.tokens ?? 0)} · ${(a.usage?.today.cost ?? 0).toFixed(2)} / {fmtTokens(a.usage?.week.tokens ?? 0)} · ${(a.usage?.week.cost ?? 0).toFixed(2)}</span>
                            <b>Used by</b><span>{envs.filter((e) => accountOrderOf(e).includes(a.id)).map((e) => `${e.name} (#${accountOrderOf(e).indexOf(a.id) + 1})`).join(", ") || "no environment lists it"}</span>
                        </div>
                        <div className="actions">
                            <button onClick={async () => { try { const r = await api.setupToken(a.id); onTerminal(r.terminal); } catch (e) { onError(String((e as Error).message ?? e)); } }}>{a.has_token ? "Renew token" : "Set up token"}</button>
                            <button onClick={async () => { try { const r = await api.loginAccount(a.id); onTerminal(r.terminal); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Log in (browser)</button>
                            <button disabled={busy === `chrome-${a.id}`} onClick={async () => {
                                setBusy(`chrome-${a.id}`);
                                setVerify((v) => ({ ...v, [a.id]: { ok: true, text: "checking the browser login, then running a tiny --chrome agent…" } }));
                                try {
                                    const r = await api.probeAccountChrome(a.id);
                                    setVerify((v) => ({ ...v, [a.id]: { ok: r.ok, text: r.detail } }));
                                    await onChangedSafe();
                                } catch (e) {
                                    setVerify((v) => ({ ...v, [a.id]: { ok: false, text: String((e as Error).message ?? e) } }));
                                } finally {
                                    setBusy(null);
                                }
                            }}>{busy === `chrome-${a.id}` ? "Probing…" : "Probe Chrome"}</button>
                            <button disabled={busy === `clone-${a.id}` || !a.chrome_device_id} title="Copies the chosen Chrome profile, starts a Chrome window on the copy, waits for its extension to connect, then removes it" onClick={async () => {
                                setBusy(`clone-${a.id}`);
                                setVerify((v) => ({ ...v, [a.id]: { ok: true, text: "copying the profile, starting a Chrome on the copy, waiting for its extension…" } }));
                                try {
                                    const r = await api.testAccountClone(a.id);
                                    setVerify((v) => ({ ...v, [a.id]: { ok: r.ok, text: r.detail } }));
                                } catch (e) {
                                    setVerify((v) => ({ ...v, [a.id]: { ok: false, text: String((e as Error).message ?? e) } }));
                                } finally {
                                    setBusy(null);
                                }
                            }}>{busy === `clone-${a.id}` ? "Cloning…" : "Test profile cloning"}</button>
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
                            {a.plan !== "enterprise" && a.logged_in === 1 && (
                                <button disabled={a.refreshing_limits} onClick={async () => { setVerify((v) => ({ ...v, [a.id]: { ok: true, text: "refreshing the rate-limit windows (one tiny Sonnet turn)…" } })); try { const r = await api.refreshLimits(a.id); setVerify((v) => ({ ...v, [a.id]: { ok: r.ok, text: r.detail } })); await onChangedSafe(); } catch (e) { setVerify((v) => ({ ...v, [a.id]: { ok: false, text: String((e as Error).message ?? e) } })); } }}>{a.refreshing_limits ? "Refreshing…" : "Refresh limits"}</button>
                            )}
                            <button className="danger" disabled={used > 0} title={used > 0 ? "an env or task still uses it" : "forget this account and its token"} onClick={() => { if (confirm(`Forget account ${a.name} and its stored token?`)) void act(() => api.deleteAccount(a.id)); }}>Delete</button>
                        </div>
                        {verify[a.id] && <div className={`test-result ${verify[a.id]!.ok ? "" : "bad"}`}>{verify[a.id]!.text}</div>}
                    </section>
                );
            })}
        </>
    );
};

// Where Stagehand pushes "a task needs you" events: macOS notification centre and, for the phone, an ntfy topic.
const NotificationsCard = ({ settings, onChanged, onError }: { settings: Settings; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const n = settings.notifications;
    const [f, setF] = useState({ macos: n.macos, ntfyServer: n.ntfyServer, ntfyTopic: n.ntfyTopic ?? "", ntfyToken: "", baseUrl: n.baseUrl ?? "", localBaseUrl: n.localBaseUrl ?? "http://localhost:5173" });
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    return (
        <section className="card manager">
            <h2>Notifications <TypeChip type="notifications" /> {n.ntfyTopic ? <span className="chip ok">phone via ntfy</span> : <span className="chip">desktop only</span>}</h2>
            <p className="field-hint">Sent whenever a task starts waiting on you: review needed, blocked (login, missing data), failed, or parked on a rate limit — once per distinct reason. Phone: install the ntfy app (iOS/Android), subscribe to a private topic name, and enter it here; Stagehand posts to it. Set the public URL so a tap opens the task.</p>
            <div className="env-fields manager-fields">
                <label className="inline"><input type="checkbox" checked={f.macos} onChange={(e) => setF({ ...f, macos: e.target.checked })} /> macOS notification centre on this Mac <span className="chip">{settings.desktopNotifier}</span></label>
                <label>URL of this UI on this Mac (a click on the desktop notification opens the task there) <input value={f.localBaseUrl} onChange={(e) => setF({ ...f, localBaseUrl: e.target.value })} placeholder="http://localhost:5173" /></label>
                <label>ntfy topic (a hard-to-guess name, e.g. stagehand-7f3a9c) <input value={f.ntfyTopic} onChange={(e) => setF({ ...f, ntfyTopic: e.target.value })} placeholder="not set — no phone pushes" /></label>
                <label>ntfy server <input value={f.ntfyServer} onChange={(e) => setF({ ...f, ntfyServer: e.target.value })} /></label>
                <label>ntfy access token (only for protected topics / self-hosted servers) <input value={f.ntfyToken} onChange={(e) => setF({ ...f, ntfyToken: e.target.value })} placeholder={n.ntfyToken ?? "not set"} /></label>
                <label>Public URL of this UI for links in pushes <input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="https://your-host:4748" /></label>
            </div>
            <div className="actions">
                <button className="primary" onClick={async () => { try { await api.patchSettings({ notifications: { macos: f.macos, ntfyServer: f.ntfyServer, ntfyTopic: f.ntfyTopic || null, ...(f.ntfyToken ? { ntfyToken: f.ntfyToken } : {}), baseUrl: f.baseUrl || null, localBaseUrl: f.localBaseUrl || "http://localhost:5173" } }); setF({ ...f, ntfyToken: "" }); await onChanged(); setResult({ ok: true, text: "saved" }); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Save</button>
                <button onClick={async () => { setResult({ ok: true, text: "sending…" }); try { const r = await api.testNotification(); setResult({ ok: !r.error, text: `desktop ${r.macos ? "sent" : "off"} · phone ${r.ntfy === null ? "not configured" : r.ntfy ? "sent" : `failed: ${r.error ?? "?"}`}` }); } catch (e) { setResult({ ok: false, text: String((e as Error).message ?? e) }); } }}>Send a test</button>
            </div>
            {result && <div className={`test-result ${result.ok ? "" : "bad"}`}>{result.text}</div>}
        </section>
    );
};

// Prompter: the assistant in the bottom-right corner of the app. Runs on a token account in its own config dir with its
// own MemPalace (~/.stagehand/prompter); this card picks the account and model, the idle timeout, and seeds the palace.
const PrompterCard = ({ settings, accounts, onChanged, onError }: { settings: Settings; accounts: Account[]; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    // A server older than this UI (between a deploy and its restart) has no prompter settings yet.
    const p: PrompterSettings = settings.prompter ?? { accountId: null, model: "fable", idleHours: 24, purgeDays: 7, farewell: true, maxTurns: 40, seedFrom: "", seedWings: [] };
    const [status, setStatus] = useState<PrompterStatus | null>(null);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const [idle, setIdle] = useState(String(p.idleHours));
    const [purge, setPurge] = useState(String(p.purgeDays));
    const [busy, setBusy] = useState(false);
    const refresh = async () => setStatus(await api.prompterStatus().catch(() => null));
    useEffect(() => {
        void refresh();
    }, []);
    const save = async (body: Parameters<typeof api.patchSettings>[0]["prompter"]) => {
        try {
            await api.patchSettings({ prompter: body });
            await onChanged();
            await refresh();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        }
    };
    const tokenAccounts = accounts.filter((a) => a.has_token);
    return (
        <section className="card manager">
            <h2>Prompter <TypeChip type="assistant" /> {status ? (status.ready ? <span className="chip ok">ready</span> : <span className="chip bad">not ready</span>) : null}{status && status.open > 0 && <span className="chip">{status.open} open chat{status.open === 1 ? "" : "s"}</span>}</h2>
            <p className="field-hint">The assistant in the bottom-right corner. It runs headless on a token account, in its own config dir with its own MemPalace under <code>{status?.home ?? "~/.stagehand/prompter"}</code>; every chat is a session of its own (several can be open at once) and the palace is its memory between chats. It sees the current page (the URL) with every message and acts through the local API. Usage is recorded in Analytics as kind <code>prompter</code>.</p>
            {status && !status.ready && <div className="blocked-box">{status.reason}</div>}
            <div className="kv">
                <b>AI account</b>
                <span>
                    <select value={p.accountId ?? ""} onChange={(e) => void save({ accountId: e.target.value || null })}>
                        <option value="">— first account with a token{status?.account ? ` (${status.account})` : ""} —</option>
                        {tokenAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ""}</option>)}
                    </select>
                </span>
                <b>Default model</b>
                <span>
                    <select value={p.model} onChange={(e) => void save({ model: e.target.value })}>
                        {settings.models.filter((m) => m.value).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                    <span className="field-hint">The window's own model select overrides this for the next new chat.</span>
                </span>
                <b>End an idle chat after</b>
                <span>
                    <input value={idle} onChange={(e) => setIdle(e.target.value)} onBlur={() => { const n = Number(idle); if (Number.isFinite(n) && n > 0 && n !== p.idleHours) void save({ idleHours: n }); }} style={{ width: 80 }} /> hours without activity (a message, or an open window)
                    <span className="field-hint">Several chats can be open at once (the window's session strip). A server restart never ends a chat: the window re-attaches, and a turn that died with the server is sent again.</span>
                </span>
                <b>Remove closed chats after</b>
                <span>
                    <input value={purge} onChange={(e) => setPurge(e.target.value)} onBlur={() => { const n = Number(purge); if (Number.isFinite(n) && n > 0 && n !== p.purgeDays) void save({ purgeDays: n }); }} style={{ width: 80 }} /> days (messages and per-turn logs)
                </span>
                <b>Farewell turn</b>
                <span>
                    <label className="inline"><input type="checkbox" checked={p.farewell} onChange={(e) => void save({ farewell: e.target.checked })} /> before a chat ends, one short turn lets it file what is not filed yet</label>
                </span>
                <b>Palace</b>
                <span>
                    {status?.seeded ? <>seeded {new Date(status.seeded.at).toLocaleString()} · {status.seeded.total} drawer(s)</> : "not seeded yet"}
                    <span className="field-hint">Seeding copies the Stagehand knowledge (wings {p.seedWings.join(", ")} and the diary entries about it) from <code>{p.seedFrom}</code>. Re-running only adds what is missing.</span>
                </span>
            </div>
            <div className="actions">
                <button disabled={busy} onClick={async () => { setBusy(true); setResult({ ok: true, text: "copying drawers…" }); try { const r = await api.prompterSeed(); setResult({ ok: r.ok, text: r.detail }); await refresh(); } catch (e) { setResult({ ok: false, text: String((e as Error).message ?? e) }); } finally { setBusy(false); } }}>{busy ? "Seeding…" : status?.seeded ? "Seed again" : "Seed the palace"}</button>
                <button onClick={() => void refresh()}>Refresh</button>
            </div>
            {result && <div className={`test-result ${result.ok ? "" : "bad"}`}>{result.text}</div>}
        </section>
    );
};

// Jev (TypeSafe AI): a decision model that answers typed yes/no, choice and score questions with probabilities in
// ~100–500 ms — for the engine's small judgments (CI failure triage, QA blocker kinds, comment routing) instead of
// regexes or a full Claude run.
const JevCard = ({ settings, onChanged, onError }: { settings: Settings; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const [key, setKey] = useState("");
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const configured = Boolean(settings.typesafeApiKey);
    return (
        <section className="card manager">
            <h2>Jev (TypeSafe AI) <TypeChip type="decision model" /> {configured ? <span className="chip ok">configured</span> : <span className="chip">no key</span>}</h2>
            <p className="field-hint">TypeSafe AI's Jev answers typed questions (yes/no, choice, score) over a piece of state with calibrated probabilities — no prose, sub-second, $0.042 per 1M input tokens. Calls are recorded in Analytics as kind <code>jev</code>. Without a key every Jev-backed judgment falls back to the built-in heuristics.</p>
            <div className="env-fields manager-fields">
                <label>TypeSafe API key <input value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.typesafeApiKey ?? "apikey_…"} /></label>
            </div>
            <div className="actions">
                <button className="primary" disabled={!key.trim()} onClick={async () => { try { await api.patchSettings({ typesafeApiKey: key.trim() }); setKey(""); await onChanged(); setResult({ ok: true, text: "saved" }); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Save</button>
                <button disabled={!configured} onClick={async () => { setResult({ ok: true, text: "asking Jev to triage a sample CI failure…" }); try { const r = await api.testJev(); setResult(r.ok ? { ok: true, text: `OK — ${r.model} answered in ${r.ms} ms (${r.inputTokens} input tokens): ${r.summary}` } : { ok: false, text: `failed: ${r.error}` }); } catch (e) { setResult({ ok: false, text: String((e as Error).message ?? e) }); } }}>Test</button>
                <button className="danger" disabled={!configured} onClick={async () => { if (!confirm("Remove the TypeSafe API key?")) return; try { await api.patchSettings({ typesafeApiKey: null }); await onChanged(); setResult(null); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Remove key</button>
            </div>
            {result && <div className={`test-result ${result.ok ? "" : "bad"}`}>{result.text}</div>}
        </section>
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
                        <h2>{m.label} <TypeChip type="task manager" /> {m.configured ? <span className="chip ok">configured</span> : <span className="chip">no token</span>}</h2>
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
