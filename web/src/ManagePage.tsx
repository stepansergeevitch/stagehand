import { useEffect, useState } from "react";
import { Loading } from "./components/Loading";
import { money } from "./format";
import { DataTable, type DataColumn } from "./components/DataTable";
import { Modal } from "./Modal";
import { navigate, type Route } from "./routes";
import { authLabel, authTone, PrompterPage, type IntegrationType } from "./ConfigEntities";
import { accountBrowserReady, accountOrderOf, api, modelLabel, trackerName, type Account, type ConfigDir, type Env, type Settings, type Task, type TaskManager, type TokenIntegration, TOKEN_INTEGRATIONS } from "./api";
import { Field } from "./components/EntityView";
import { limitTone } from "./SettingsParts";
import { Button, Chip, Input } from "@vortex/ds";

// List / create / read / update / delete for the things Vortex is configured with.
export type ManageTab = "envs" | "dirs" | "accounts" | "integrations" | "prompter";

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
    // Runs a change, reloads, and says whether it worked (an error goes to the page's notice).
    const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
        try {
            await fn();
            await onChanged();
            return true;
        } catch (e) {
            onError(String((e as Error).message ?? e));
            return false;
        }
    };
    return (
        <>
            {tab === "envs" && <EnvTable envs={envs} configDirs={configDirs} accounts={accounts} tasks={tasks} onConfigure={onConfigureEnv} onAdd={onAddEnv} act={act} />}
            {tab === "dirs" && <ConfigDirTable dirs={configDirs} adding={route.page === "config-dirs" && !!route.create} onOpen={onOpenDir} act={act} />}
            {tab === "accounts" && <AccountTable accounts={accounts} envs={envs} tasks={tasks} settings={settings} onAdd={onAddAccount} onOpen={onOpenAccount} act={act} />}
            {tab === "prompter" && settings && <PrompterPage settings={settings} accounts={accounts} tab={route.page === "prompter" ? route.tab : undefined} onTab={(t) => navigate({ page: "prompter", tab: t })} onChanged={onChanged} onError={onError} />}
            {tab === "integrations" && <IntegrationTable settings={settings} onOpen={onOpenIntegration} onError={onError} />}
        </>
    );
};

type Act = (fn: () => Promise<unknown>) => Promise<boolean>;

const EnvTable = ({ envs, configDirs, accounts, tasks, onConfigure, onAdd, act }: { envs: Env[]; configDirs: ConfigDir[]; accounts: Account[]; tasks: Task[]; onConfigure: (id: string) => void; onAdd: () => void; act: Act }) => {
    const taskCount = (e: Env): number => tasks.filter((t) => t.env_id === e.id).length;
    const dirName = (e: Env): string => configDirs.find((d) => d.id === e.config_dir_id)?.name ?? "server default";
    const accountList = (e: Env): string => accountOrderOf(e).map((id, i) => `${i + 1}. ${accounts.find((a) => a.id === id)?.name ?? "?"}`).join("  ") || "any that can run in the dir";
    const columns: DataColumn<Env>[] = [
        { key: "name", label: "Name", kind: "label", value: (e) => e.name, filter: false },
        { key: "source", label: "Tickets", value: (e) => e.ticket_source, filter: "auto", render: (e) => trackerName(e.ticket_source) },
        { key: "base", label: "Base branch", value: (e) => e.base_branch, filter: "auto", render: (e) => <Chip mono>{e.base_branch}</Chip> },
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
                    <Button variant="danger" size="sm" disabled={busy.length> 0} title={busy.length ? `delete the tasks of ${busy.map((e) => e.name).join(", ")} first` : "remove from Vortex (files untouched)"} onClick={() => { if (confirm(`Remove ${sel.length} environment(s) from Vortex? Files on disk are not touched.`)) void act(async () => { for (const e of sel) await api.deleteEnv(e.id); clear(); }); }}>
                        Delete
                    </Button>
                );
            }}
        />
    );
};

const ConfigDirTable = ({ dirs, adding, onOpen, act }: { dirs: ConfigDir[]; adding: boolean; onOpen: (id: string) => void; act: Act }) => {
    const setAdding = (on: boolean): void => navigate(on ? { page: "config-dirs", create: true } : { page: "config-dirs" });
    const [add, setAdd] = useState({ name: "", path: "" });
    const columns: DataColumn<ConfigDir>[] = [
        { key: "name", label: "Name", kind: "label", value: (d) => d.name, filter: false },
        { key: "disk", label: "On disk", value: (d) => (d.contents.exists ? "present" : "missing"), filter: "auto", render: (d) => (d.contents.exists ? <Chip tone="ok">present</Chip> : <Chip tone="bad">missing</Chip>) },
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
                        <Button variant="danger" size="sm" disabled={used.length> 0} title={used.length ? `still used: ${used.map((d) => d.name).join(", ")}` : "forget (nothing on disk changes)"} onClick={() => { if (confirm(`Forget ${sel.length} config dir(s)? Nothing on disk is touched.`)) void act(async () => { for (const d of sel) await api.deleteConfigDir(d.id); clear(); }); }}>
                            Delete
                        </Button>
                    );
                }}
            />
            {adding && (
                <Modal
                    title="Register a config dir"
                    onClose={() => setAdding(false)}
                    footer={<><Button onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" type="submit" form="register-dir" disabled={!add.name.trim() || !add.path.trim()}>Register</Button></>}
                >
                    <form
                        id="register-dir"
                        className="modal-form"
                        onSubmit={async (e) => {
                            e.preventDefault();
                            if (await act(() => api.addConfigDir(add.name.trim(), add.path.trim()))) {
                                setAdd({ name: "", path: "" });
                                setAdding(false);
                            }
                        }}
                    >
                        <Field label="Name" hint="How the dir is listed on environments."><Input autoFocus value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="personal" /></Field>
                        <Field label="Directory" hint="A Claude config directory: the folder holding settings.json, skills, agents and CLAUDE.md, usually a project's .claude."><Input value={add.path} onChange={(e) => setAdd({ ...add, path: e.target.value })} placeholder="/Users/you/code/project/.claude" /></Field>
                    </form>
                </Modal>
            )}
        </>
    );
};

const pctOf = (a: Account, window: string): number | null => {
    const l = a.limits.find((x) => x.window === window);
    return l && !l.expired ? Math.round(l.utilization * 100) : null;
};

const AccountTable = ({ accounts, envs, tasks, settings, onAdd, onOpen, act }: { accounts: Account[]; envs: Env[]; tasks: Task[]; settings: Settings | null; onAdd: () => void; onOpen: (id: string) => void; act: Act }) => {
    const usedCount = (a: Account): number => envs.filter((e) => e.default_account_id === a.id).length + tasks.filter((t) => t.account_id === a.id).length;
    const usedBy = (a: Account): string => envs.filter((e) => accountOrderOf(e).includes(a.id)).map((e) => `${e.name} (#${accountOrderOf(e).indexOf(a.id) + 1})`).join(", ") || "no environment";
    const columns: DataColumn<Account>[] = [
        { key: "name", label: "Name", kind: "label", value: (a) => a.name, filter: false },
        { key: "provider", label: "Provider", value: (a) => a.provider, filter: "auto" },
        { key: "auth", label: "Auth", value: authLabel, filter: "auto", render: (a) => <Chip tone={authTone(a)}>{authLabel(a)}</Chip> },
        { key: "chrome", label: "Chrome", value: (a) => (accountBrowserReady(a) ? a.chrome_browser_name ?? "ready" : "none"), filter: "auto", defaultHidden: true },
        { key: "plan", label: "Plan", value: (a) => a.plan ?? "", filter: "auto" },
        { key: "email", label: "Email", value: (a) => a.email ?? "", filter: false },
        { key: "model", label: "Default model", value: (a) => modelLabel(a.models?.default ?? a.default_model, settings?.models) ?? "", filter: "auto", defaultHidden: true },
        { key: "five", label: "5 h", kind: "num", value: (a) => pctOf(a, "five_hour"), filter: false, render: (a) => { const v = pctOf(a, "five_hour"); return v === null ? "—" : <Chip tone={limitTone(v)}>{v}%</Chip>; } },
        { key: "week", label: "7 d", kind: "num", value: (a) => pctOf(a, "seven_day"), filter: false, render: (a) => { const v = pctOf(a, "seven_day"); return v === null ? "—" : <Chip tone={limitTone(v)}>{v}%</Chip>; } },
        { key: "today", label: "Today", kind: "num", value: (a) => a.usage?.today.cost ?? 0, filter: false, render: (a) => money(a.usage?.today.cost ?? 0) },
        { key: "weekCost", label: "This week", kind: "num", value: (a) => a.usage?.week.cost ?? 0, filter: false, render: (a) => money(a.usage?.week.cost ?? 0) },
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
                        <Button variant="danger" size="sm" disabled={used.length> 0} title={used.length ? `still used: ${used.map((a) => a.name).join(", ")}` : "forget the accounts and their tokens"} onClick={() => { if (confirm(`Forget ${sel.length} account(s) and their stored tokens?`)) void act(async () => { for (const a of sel) await api.deleteAccount(a.id); clear(); }); }}>
                            Delete
                        </Button>
                    );
                }}
            />
        </>
    );
};

// One row per integration Vortex talks to; a row opens its entity view.
type IntegrationRow = { id: string; name: string; type: IntegrationType; status: string; ok: boolean; usedBy: string };

const IntegrationTable = ({ settings, onOpen, onError }: { settings: Settings | null; onOpen: (id: string) => void; onError: (m: string) => void }) => {
    const [managers, setManagers] = useState<TaskManager[] | null>(null);
    const [tokenStates, setTokenStates] = useState<TokenIntegration[] | null>(null);
    const load = async (): Promise<void> => {
        await Promise.all([api.taskManagers().then(setManagers), Promise.all(TOKEN_INTEGRATIONS.map((t) => api.tokenIntegration(t.id))).then(setTokenStates)]).catch((e: Error) => onError(e.message));
    };
    useEffect(() => { void load(); }, []);
    const rows: IntegrationRow[] = [
        ...(managers ?? []).map((m) => ({ id: `tm:${m.source}`, name: m.label, type: "task manager" as const, status: m.configured ? "configured" : m.source === "tasksmd" ? "no folder" : "no token", ok: m.configured, usedBy: m.envs.join(", ") })),
        ...(tokenStates ?? []).map((t) => ({ id: t.id, name: TOKEN_INTEGRATIONS.find((x) => x.id === t.id)!.name, type: "documents" as const, status: t.configured ? "configured" : "no token", ok: t.configured, usedBy: "" })),
        ...(settings
            ? [
                  { id: "notifications", name: "Notifications", type: "notifications" as const, status: settings.notifications.ntfyTopic ? "phone via ntfy" : "desktop only", ok: true, usedBy: "" },
                  { id: "jev", name: "Jev (TypeSafe AI)", type: "decision model" as const, status: settings.typesafeApiKey ? "configured" : "no key", ok: Boolean(settings.typesafeApiKey), usedBy: "" },
              ]
            : []),
    ];
    const columns: DataColumn<IntegrationRow>[] = [
        { key: "name", label: "Name", kind: "label", value: (r) => r.name, filter: false },
        { key: "type", label: "Type", value: (r) => r.type, filter: "auto", render: (r) => <Chip>{r.type}</Chip> },
        { key: "status", label: "Status", value: (r) => r.status, filter: "auto", render: (r) => <Chip tone={r.ok ? "ok" : "neutral"}>{r.status}</Chip> },
        { key: "used", label: "Used by", value: (r) => r.usedBy, filter: false, render: (r) => r.usedBy || "—" },
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
                empty={managers === null ? <Loading lines={2} /> : "No integration."}
                defaultSort={{ key: "name", desc: false }}
            />
        </>
    );
};
