import { useEffect, useState } from "react";
import { DataTable, type DataColumn } from "./components/DataTable";
import { Modal } from "./Modal";
import { accountBrowserReady, accountOrderOf, api, chromeBrowserLabel, modelLabel, type Account, type ConfigDir, type Env, type AccountModels, type ModelOperation, type ModelStage, type PrompterSettings, type PrompterStatus, type Settings, type Task, type TaskManager } from "./api";

// List / create / read / update / delete for the things Stagehand is configured with.
export type ManageTab = "envs" | "dirs" | "accounts" | "integrations" | "prompter" | "pipeline";

// Every card on the Integrations page carries one of these, so a new kind of integration announces what it is.
type IntegrationType = "task manager" | "notifications" | "decision model" | "assistant" | "documents";
const TypeChip = ({ type }: { type: IntegrationType }) => <span className="chip type" title="integration type">{type}</span>;

const repoList = (json: string | null): string => {
    try {
        const v: unknown = json ? JSON.parse(json) : [];
        return Array.isArray(v) && v.length ? v.join(", ") : "single repo";
    } catch {
        return "single repo";
    }
};


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
// Which model runs what on one account: its default, per stage the first run on a task and every later run (a review
// round sent back, Retry, a contract or unblock retry, a QA return to Implementation), and per side operation. A task
// created with its own model uses that everywhere. Every select saves at once; a blank falls back along the arrows.
const AccountModelsSection = ({ a, settings, act }: { a: Account; settings: Settings; act: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const m = a.models ?? { default: null, stages: {}, reruns: {}, operations: {} };
    const label = (v: string | null | undefined): string => (v ? modelLabel(v, settings.models) ?? v : "");
    const cliDefault = `the CLI's default (${label(a.default_model) || "?"})`;
    const defaultLabel = m.default ? label(m.default) : cliDefault;
    const options = (blank: string) => settings.models.map((o) => <option key={o.value} value={o.value}>{o.value === "" ? blank : o.label}</option>);
    const save = (models: Partial<AccountModels>) => void act(() => api.patchAccount(a.id, { models }));
    return (
        <section className="card item">
            <h2>Models</h2>
            <p className="field-hint">
                {settings.modelsFetchedAt ? `Model list from the Models API, fetched ${new Date(settings.modelsFetchedAt).toLocaleString()}` : "Built-in model list (nothing fetched yet)"}
                {settings.modelsError ? ` · last fetch failed: ${settings.modelsError}` : ""}
                {" "}<button type="button" className="tiny" onClick={() => void act(() => api.refreshModels())}>Refresh</button>
            </p>
            <div className="env-fields" style={{ maxWidth: 560 }}>
                <label>Default (the fallback of every blank below)
                    <select value={m.default ?? ""} onChange={(e) => save({ default: e.target.value || null })}>{options(`→ ${cliDefault}`)}</select>
                </label>
            </div>
            <table className="models-table">
                <thead><tr><th>Stage</th><th>First run</th><th>Reruns</th></tr></thead>
                <tbody>
                    {MODEL_STAGES.map((st) => (
                        <tr key={st.key}>
                            <td>{st.label}</td>
                            <td><select value={m.stages[st.key] ?? ""} onChange={(e) => save({ stages: { [st.key]: e.target.value || null } })}>{options(`→ default (${defaultLabel})`)}</select></td>
                            <td><select value={m.reruns[st.key] ?? ""} onChange={(e) => save({ reruns: { [st.key]: e.target.value || null } })}>{options(`→ first run (${m.stages[st.key] ? label(m.stages[st.key]) : defaultLabel})`)}</select></td>
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
                            <td><select value={m.operations[o.key] ?? ""} onChange={(e) => save({ operations: { [o.key]: e.target.value || null } })}>{options(o.key.startsWith("pr_fix") ? `→ PR Fix stage (${m.stages.pr_fix ? label(m.stages.pr_fix) : defaultLabel})` : `→ default (${defaultLabel})`)}</select></td>
                            <td className="quiet">{o.hint}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
};

// Which stages a task goes through: settings of the pipeline itself, not of any one environment or account.
const PipelineCard = ({ settings, act }: { settings: Settings; act: (fn: () => Promise<unknown>) => Promise<void> }) => (
    <section className="card item">
        <h2>Stages</h2>
        <label className="inline"><input type="checkbox" checked={settings.codeReview !== false} onChange={(e) => void act(() => api.patchSettings({ codeReview: e.target.checked }))} /> Code Review stage after Implementation — gstack's pre-landing checklist applied by a fresh session: mechanical findings fixed and committed, serious open ones sent back to Implementation once, everything shown at User Review</label>
    </section>
);

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
            {tab === "envs" && <EnvTable envs={envs} configDirs={configDirs} accounts={accounts} tasks={tasks} onConfigure={onConfigureEnv} onAdd={onAddEnv} act={act} />}
            {tab === "dirs" && <ConfigDirTable dirs={configDirs} onOpen={onOpenDir} act={act} />}
            {tab === "accounts" && <AccountTable accounts={accounts} envs={envs} tasks={tasks} settings={settings} onAdd={onAddAccount} act={act} onTerminal={onTerminal} onError={onError} />}
            {tab === "prompter" && settings && <PrompterCard settings={settings} accounts={accounts} onChanged={onChanged} onError={onError} />}
            {tab === "pipeline" && settings && <PipelineCard settings={settings} act={act} />}
            {tab === "integrations" && <IntegrationTable settings={settings} onChanged={onChanged} onError={onError} />}
        </div>
    );
};

const EnvTable = ({ envs, configDirs, accounts, tasks, onConfigure, onAdd, act }: { envs: Env[]; configDirs: ConfigDir[]; accounts: Account[]; tasks: Task[]; onConfigure: (id: string) => void; onAdd: () => void; act: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const taskCount = (e: Env): number => tasks.filter((t) => t.env_id === e.id).length;
    const dirName = (e: Env): string => configDirs.find((d) => d.id === e.config_dir_id)?.name ?? "server default";
    const accountList = (e: Env): string => accountOrderOf(e).map((id, i) => `${i + 1}. ${accounts.find((a) => a.id === id)?.name ?? "?"}`).join("  ") || "any that can run in the dir";
    const columns: DataColumn<Env>[] = [
        { key: "name", label: "Name", kind: "label", value: (e) => e.name, filter: false },
        { key: "source", label: "Tickets", value: (e) => e.ticket_source, filter: "auto" },
        { key: "base", label: "Base branch", value: (e) => e.base_branch, filter: "auto", render: (e) => <span className="chip accent">{e.base_branch}</span> },
        { key: "repos", label: "Repos", value: (e) => repoList(e.repos), filter: false },
        { key: "dir", label: "Config dir", value: dirName, filter: "auto" },
        { key: "accounts", label: "AI accounts", value: accountList, filter: false, defaultHidden: true },
        { key: "path", label: "Path", value: (e) => e.path, filter: false, render: (e) => <code>{e.path}</code> },
        { key: "tasks", label: "Tasks", kind: "num", value: taskCount, filter: false },
    ];
    return (
        <DataTable
            title="Environments"
            entity="environment"
            onCreate={onAdd}
            columns={columns}
            rows={envs}
            rowKey={(e) => e.id}
            onRowClick={(e) => onConfigure(e.id)}
            storageKey="config-envs"
            defaultSort={{ key: "name", desc: false }}
            empty="No environment yet."
            bulkActions={(sel, clear) => {
                const busy = sel.filter((e) => taskCount(e) > 0);
                return (
                    <button className="danger tiny" disabled={busy.length > 0} title={busy.length ? `delete the tasks of ${busy.map((e) => e.name).join(", ")} first` : "remove from Stagehand (files untouched)"} onClick={() => { if (confirm(`Remove ${sel.length} environment(s) from Stagehand? Files on disk are not touched.`)) void act(async () => { for (const e of sel) await api.deleteEnv(e.id); clear(); }); }}>
                        Delete
                    </button>
                );
            }}
        />
    );
};

const ConfigDirTable = ({ dirs, onOpen, act }: { dirs: ConfigDir[]; onOpen: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const [adding, setAdding] = useState(false);
    const [add, setAdd] = useState({ name: "", path: "" });
    const columns: DataColumn<ConfigDir>[] = [
        { key: "name", label: "Name", kind: "label", value: (d) => d.name, filter: false },
        { key: "disk", label: "On disk", value: (d) => (d.contents.exists ? "present" : "missing"), filter: "auto", render: (d) => (d.contents.exists ? <span className="chip ok">present</span> : <span className="chip bad">missing</span>) },
        { key: "skills", label: "Skills", kind: "num", value: (d) => d.contents.skills.length, filter: false },
        { key: "agents", label: "Subagents", kind: "num", value: (d) => d.contents.agents.length, filter: false },
        { key: "mcp", label: "MCP servers", kind: "num", value: (d) => d.contents.mcpServers.length, filter: false },
        { key: "hooks", label: "Hooks", value: (d) => d.contents.hooks.join(", ") || "none", filter: false },
        { key: "claudemd", label: "CLAUDE.md", value: (d) => d.contents.hasClaudeMd, filter: "auto" },
        { key: "envs", label: "Used by", value: (d) => d.envs.join(", ") || "no environment", filter: false },
        { key: "runnable", label: "Runnable with", value: (d) => d.usable_accounts.join(", ") || "no account", filter: false, defaultHidden: true },
        { key: "path", label: "Path", value: (d) => d.path, filter: false, render: (d) => <code>{d.path}</code> },
    ];
    return (
        <>
            <DataTable
                title="Claude config dirs"
                entity="config dir"
                onCreate={() => setAdding(true)}
                columns={columns}
                rows={dirs}
                rowKey={(d) => d.id}
                onRowClick={(d) => onOpen(d.id)}
                storageKey="config-dirs"
                defaultSort={{ key: "name", desc: false }}
                empty="No config dir registered yet."
                bulkActions={(sel, clear) => {
                    const used = sel.filter((d) => d.envs.length > 0);
                    return (
                        <button className="danger tiny" disabled={used.length > 0} title={used.length ? `still used: ${used.map((d) => d.name).join(", ")}` : "forget (nothing on disk changes)"} onClick={() => { if (confirm(`Forget ${sel.length} config dir(s)? Nothing on disk is touched.`)) void act(async () => { for (const d of sel) await api.deleteConfigDir(d.id); clear(); }); }}>
                            Delete
                        </button>
                    );
                }}
            />
            {adding && (
                <Modal title="Register a config dir" onClose={() => setAdding(false)}>
                    <div className="env-fields" style={{ maxWidth: 560 }}>
                        <label>Name <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="personal" /></label>
                        <label>Directory <input value={add.path} onChange={(e) => setAdd({ ...add, path: e.target.value })} placeholder="/Users/you/code/project/.claude" /></label>
                        <button className="primary" disabled={!add.name.trim() || !add.path.trim()} onClick={async () => { await act(() => api.addConfigDir(add.name.trim(), add.path.trim())); setAdd({ name: "", path: "" }); setAdding(false); }}>Register</button>
                    </div>
                </Modal>
            )}
        </>
    );
};

const fmtTokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));

const AccountCard = ({ a, envs, tasks, settings, act, onTerminal, onError }: { a: Account; envs: Env[]; tasks: Task[]; settings: Settings | null; act: (fn: () => Promise<unknown>) => Promise<void>; onTerminal: (n: string) => void; onError: (m: string) => void }) => {
    const onChangedSafe = () => act(async () => undefined);
    const [busy, setBusy] = useState<string | null>(null);
    const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
    const [verify, setVerify] = useState<Record<string, { ok: boolean; text: string }>>({});
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
};

const authLabel = (a: Account): string => (a.setting_up ? "token setup in progress" : a.has_token ? "token" : a.logged_in ? "legacy login" : "no auth");
const pctOf = (a: Account, window: string): number | null => {
    const l = a.limits.find((x) => x.window === window);
    return l && !l.expired ? Math.round(l.utilization * 100) : null;
};

const AccountTable = ({ accounts, envs, tasks, settings, onAdd, act, onTerminal, onError }: { accounts: Account[]; envs: Env[]; tasks: Task[]; settings: Settings | null; onAdd: () => void; act: (fn: () => Promise<unknown>) => Promise<void>; onTerminal: (n: string) => void; onError: (m: string) => void }) => {
    const [open, setOpen] = useState<string | null>(null);
    const usedCount = (a: Account): number => envs.filter((e) => e.default_account_id === a.id).length + tasks.filter((t) => t.account_id === a.id).length;
    const usedBy = (a: Account): string => envs.filter((e) => accountOrderOf(e).includes(a.id)).map((e) => `${e.name} (#${accountOrderOf(e).indexOf(a.id) + 1})`).join(", ") || "no environment";
    const columns: DataColumn<Account>[] = [
        { key: "name", label: "Name", kind: "label", value: (a) => a.name, filter: false },
        { key: "provider", label: "Provider", value: (a) => a.provider, filter: "auto" },
        { key: "auth", label: "Auth", value: authLabel, filter: "auto", render: (a) => <span className={`chip ${a.setting_up ? "wait" : a.has_token ? "ok" : a.logged_in ? "warn" : "bad"}`}>{authLabel(a)}</span> },
        { key: "chrome", label: "Chrome", value: (a) => (accountBrowserReady(a) ? a.chrome_browser_name ?? "ready" : "none"), filter: "auto" },
        { key: "plan", label: "Plan", value: (a) => a.plan ?? "", filter: "auto" },
        { key: "email", label: "Email", value: (a) => a.email ?? "", filter: false },
        { key: "model", label: "Default model", value: (a) => modelLabel(a.models?.default ?? a.default_model, settings?.models) ?? "", filter: "auto", defaultHidden: true },
        { key: "five", label: "5 h", kind: "num", value: (a) => pctOf(a, "five_hour"), filter: false, render: (a) => { const v = pctOf(a, "five_hour"); return v === null ? "—" : `${v}%`; } },
        { key: "week", label: "7 d", kind: "num", value: (a) => pctOf(a, "seven_day"), filter: false, render: (a) => { const v = pctOf(a, "seven_day"); return v === null ? "—" : `${v}%`; } },
        { key: "today", label: "Today", kind: "num", value: (a) => a.usage?.today.cost ?? 0, filter: false, render: (a) => `$${(a.usage?.today.cost ?? 0).toFixed(2)}` },
        { key: "weekCost", label: "This week", kind: "num", value: (a) => a.usage?.week.cost ?? 0, filter: false, render: (a) => `$${(a.usage?.week.cost ?? 0).toFixed(2)}` },
        { key: "used", label: "Used by", value: usedBy, filter: false, defaultHidden: true },
    ];
    const current = accounts.find((a) => a.id === open);
    return (
        <>
            <DataTable
                title="AI accounts"
                entity="account"
                onCreate={onAdd}
                columns={columns}
                rows={accounts}
                rowKey={(a) => a.id}
                onRowClick={(a) => setOpen(a.id)}
                activeKey={open}
                storageKey="config-accounts"
                defaultSort={{ key: "name", desc: false }}
                empty="No AI account yet."
                bulkActions={(sel, clear) => {
                    const used = sel.filter((a) => usedCount(a) > 0);
                    return (
                        <button className="danger tiny" disabled={used.length > 0} title={used.length ? `still used: ${used.map((a) => a.name).join(", ")}` : "forget the accounts and their tokens"} onClick={() => { if (confirm(`Forget ${sel.length} account(s) and their stored tokens?`)) void act(async () => { for (const a of sel) await api.deleteAccount(a.id); clear(); }); }}>
                            Delete
                        </button>
                    );
                }}
            />
            {current && (
                <Modal title={current.name} wide onClose={() => setOpen(null)}>
                    <AccountCard a={current} envs={envs} tasks={tasks} settings={settings} act={act} onTerminal={onTerminal} onError={onError} />
                    {settings && <AccountModelsSection a={current} settings={settings} act={act} />}
                </Modal>
            )}
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

// Notion: the integration token Product Owners fetch pages with (share each page with the integration in Notion).
const NotionCard = ({ onError }: { onError: (m: string) => void }) => {
    const [state, setState] = useState<{ configured: boolean; token: string | null } | null>(null);
    const [token, setToken] = useState("");
    const load = () => api.notion().then(setState).catch((e: Error) => onError(e.message));
    useEffect(() => { void load(); }, []);
    if (!state) return null;
    return (
        <section className="card manager">
            <h2>Notion <TypeChip type="documents" /> {state.configured ? <span className="chip ok">configured</span> : <span className="chip">no token</span>}</h2>
            <p className="field-hint">Product Owners fetch Notion pages by URL with this token. Share each page with the integration in Notion first.</p>
            <div className="env-fields manager-fields">
                <label>Integration token<input value={token} onChange={(e) => setToken(e.target.value)} placeholder={state.token ?? "ntn_… or secret_…"} /></label>
            </div>
            <div className="actions">
                <button className="primary" disabled={!token} onClick={async () => { try { await api.setNotion(token); setToken(""); await load(); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Save</button>
                <button className="danger" disabled={!state.configured} onClick={async () => { if (!confirm("Remove the Notion token?")) return; await api.setNotion(null); await load(); }}>Remove token</button>
            </div>
        </section>
    );
};

const TaskManagerCard = ({ m, onSaved, onError }: { m: TaskManager; onSaved: () => Promise<void>; onError: (m: string) => void }) => {
    const [edit, setEdit] = useState<Record<string, { token: string; teamId: string }>>({});
    const [test, setTest] = useState<Record<string, { ok: boolean; text: string; sample?: string[] }>>({});
    const load = onSaved;
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
};

// One row per integration Stagehand talks to; a row opens that integration's card.
type IntegrationRow = { id: string; name: string; type: IntegrationType; status: string; ok: boolean; usedBy: string };

const IntegrationTable = ({ settings, onChanged, onError }: { settings: Settings | null; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const [managers, setManagers] = useState<TaskManager[] | null>(null);
    const [notion, setNotion] = useState<{ configured: boolean } | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const load = async (): Promise<void> => {
        await Promise.all([api.taskManagers().then(setManagers), api.notion().then(setNotion)]).catch((e: Error) => onError(e.message));
    };
    useEffect(() => { void load(); }, []);
    const rows: IntegrationRow[] = [
        ...(managers ?? []).map((m) => ({ id: `tm:${m.source}`, name: m.label, type: "task manager" as const, status: m.configured ? "configured" : "no token", ok: m.configured, usedBy: m.envs.join(", ") })),
        ...(notion ? [{ id: "notion", name: "Notion", type: "documents" as const, status: notion.configured ? "configured" : "no token", ok: notion.configured, usedBy: "" }] : []),
        ...(settings
            ? [
                  { id: "notifications", name: "Notifications", type: "notifications" as const, status: settings.notifications.ntfyTopic ? "phone via ntfy" : "desktop only", ok: true, usedBy: "" },
                  { id: "jev", name: "Jev (TypeSafe AI)", type: "decision model" as const, status: settings.typesafeApiKey ? "configured" : "no key", ok: Boolean(settings.typesafeApiKey), usedBy: "" },
              ]
            : []),
    ];
    const columns: DataColumn<IntegrationRow>[] = [
        { key: "name", label: "Name", kind: "label", value: (r) => r.name, filter: false },
        { key: "type", label: "Type", value: (r) => r.type, filter: "auto", render: (r) => <TypeChip type={r.type} /> },
        { key: "status", label: "Status", value: (r) => r.status, filter: "auto", render: (r) => <span className={`chip ${r.ok ? "ok" : ""}`}>{r.status}</span> },
        { key: "used", label: "Used by", value: (r) => r.usedBy, filter: false, render: (r) => r.usedBy || <span className="quiet">—</span> },
    ];
    const current = rows.find((r) => r.id === open);
    const manager = current?.id.startsWith("tm:") ? managers?.find((m) => `tm:${m.source}` === current.id) : undefined;
    return (
        <>
            <DataTable
                title="Integrations"
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpen(r.id)}
                activeKey={open}
                storageKey="config-integrations"
                empty={managers === null ? "loading…" : "No integration."}
            />
            {current && (
                <Modal title={current.name} wide onClose={() => setOpen(null)}>
                    {manager && <TaskManagerCard m={manager} onSaved={load} onError={onError} />}
                    {current.id === "notion" && <NotionCard onError={onError} />}
                    {current.id === "notifications" && settings && <NotificationsCard settings={settings} onChanged={onChanged} onError={onError} />}
                    {current.id === "jev" && settings && <JevCard settings={settings} onChanged={onChanged} onError={onError} />}
                </Modal>
            )}
        </>
    );
};
