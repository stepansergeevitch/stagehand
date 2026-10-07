import { useEffect, useState } from "react";
import { DataTable, type DataColumn } from "./components/DataTable";
import { Modal } from "./Modal";
import { navigate, type Route } from "./routes";
import { authLabel, PrompterPage, type IntegrationType } from "./ConfigEntities";
import { accountBrowserReady, accountOrderOf, api, modelLabel, type Account, type ConfigDir, type Env, type Settings, type Task, type TaskManager } from "./api";

// List / create / read / update / delete for the things Stagehand is configured with.
export type ManageTab = "envs" | "dirs" | "accounts" | "integrations" | "prompter";

// Every card on the Integrations page carries one of these, so a new kind of integration announces what it is.
const TypeChip = ({ type }: { type: IntegrationType }) => <span className="chip type" title="integration type">{type}</span>;

const repoList = (json: string | null): string => {
    try {
        const v: unknown = json ? JSON.parse(json) : [];
        return Array.isArray(v) && v.length ? v.join(", ") : "single repo";
    } catch {
        return "single repo";
    }
};


export const ManagePage = ({
    tab,
    route,
    envs,
    configDirs,
    accounts,
    tasks,
    settings,
    onConfigureEnv,
    onOpenDir,
    onAddEnv,
    onAddAccount,
    onOpenAccount,
    onOpenIntegration,
    onChanged,
    onError,
}: {
    tab: ManageTab;
    // The route: the Prompter's tab and the config dirs' Create dialog live in it.
    route: Route;
    envs: Env[];
    configDirs: ConfigDir[];
    accounts: Account[];
    tasks: Task[];
    settings: Settings | null;
    onConfigureEnv: (id: string) => void;
    onOpenDir: (id: string) => void;
    onAddEnv: () => void;
    onAddAccount: () => void;
    onOpenAccount: (id: string) => void;
    onOpenIntegration: (id: string) => void;
    onChanged: () => Promise<void>;
    onError: (m: string) => void;
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
            {tab === "dirs" && <ConfigDirTable dirs={configDirs} adding={route.page === "config-dirs" && !!route.create} onOpen={onOpenDir} act={act} />}
            {tab === "accounts" && <AccountTable accounts={accounts} envs={envs} tasks={tasks} settings={settings} onAdd={onAddAccount} onOpen={onOpenAccount} act={act} />}
            {tab === "prompter" && settings && <PrompterPage settings={settings} accounts={accounts} tab={route.page === "prompter" ? route.tab : undefined} onTab={(t) => navigate({ page: "prompter", tab: t })} onChanged={onChanged} onError={onError} />}
            {tab === "integrations" && <IntegrationTable settings={settings} onOpen={onOpenIntegration} onError={onError} />}
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

const ConfigDirTable = ({ dirs, adding, onOpen, act }: { dirs: ConfigDir[]; adding: boolean; onOpen: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const setAdding = (on: boolean): void => navigate(on ? { page: "config-dirs", create: true } : { page: "config-dirs" });
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

const pctOf = (a: Account, window: string): number | null => {
    const l = a.limits.find((x) => x.window === window);
    return l && !l.expired ? Math.round(l.utilization * 100) : null;
};

const AccountTable = ({ accounts, envs, tasks, settings, onAdd, onOpen, act }: { accounts: Account[]; envs: Env[]; tasks: Task[]; settings: Settings | null; onAdd: () => void; onOpen: (id: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) => {
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
    return (
        <>
            <DataTable
                title="AI accounts"
                entity="account"
                onCreate={onAdd}
                columns={columns}
                rows={accounts}
                rowKey={(a) => a.id}
                onRowClick={(a) => onOpen(a.id)}
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
        </>
    );
};

// One row per integration Stagehand talks to; a row opens its entity view.
type IntegrationRow = { id: string; name: string; type: IntegrationType; status: string; ok: boolean; usedBy: string };

const IntegrationTable = ({ settings, onOpen, onError }: { settings: Settings | null; onOpen: (id: string) => void; onError: (m: string) => void }) => {
    const [managers, setManagers] = useState<TaskManager[] | null>(null);
    const [notion, setNotion] = useState<{ configured: boolean } | null>(null);
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
    return (
        <>
            <DataTable
                title="Integrations"
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                onRowClick={(r) => onOpen(r.id)}
                storageKey="config-integrations"
                empty={managers === null ? "loading…" : "No integration."}
            />
        </>
    );
};
