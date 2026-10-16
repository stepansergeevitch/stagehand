import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Account, type ConfigDir, type Env, type PoEvent, type Readiness, type Settings, type Task, type TaskDetail, accountUsableWith, STAGE_ORDER } from "./api";
import { TaskDetailView } from "./TaskDetail";
import { formatRoute, navigate, type Route, taskRoute, useRoute, type Page, type TaskView } from "./routes";
import { Prompter } from "./Prompter";
import { prompterBus, type PrompterEvent } from "./prompterBus";
import { EnvPage } from "./EnvPage";
import { AccountPage, IntegrationPage } from "./ConfigEntities";
import { ConfigDirPage } from "./ConfigDirPage";
import { ManagePage, type ManageTab } from "./ManagePage";
import { Analytics } from "./Analytics";
import { ResourcesPage } from "./ResourcesPage";
import { Timing } from "./Timing";
import { SessionsPage } from "./SessionsPage";
import { ProductPage } from "./ProductPage";
import { TasksPage } from "./TasksPage";
import { TaskForm } from "./NewTaskForm";
import { AccountForm, EnvForm } from "./AddForms";
import { poBus } from "./poBus";
import { storage } from "./storage";
import { ErrorBoundary } from "./ErrorBoundary";
import { LazyTerminal } from "./LazyTerminal";
import { Modal } from "./components/Modal";
import { AppShell, PageFrame } from "./components/AppShell";
import { Sidebar, type NavGroup, type NavItem } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { UsageGauges } from "./components/UsageGauges";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { taskState } from "./components/status";
import { Button, Notice, StatusDot } from "@vortex/ds";

// Where the user is lives in the URL hash only (see routes.ts): reloads, back/forward, pasted links and anything that
// reads the path see the same screen. The shell is described in docs/ux-redesign.md.

// The sidebar: three groups, one level. Work is what I do every day, Insights is what it cost and where it went,
// Settings is what I configure rarely.
const NAV: { group: string; items: { id: Page; label: string; icon: NavItem["icon"]; hint: string }[] }[] = [
    {
        group: "Work",
        items: [
            { id: "tasks", label: "Tasks", icon: "tasks", hint: "What needs you now, and the active and completed tasks of one environment" },
            { id: "product", label: "Product", icon: "layers", hint: "The product context and the Product Owners: plan it, design it, split it into tickets" },
            { id: "sessions", label: "Sessions", icon: "terminal", hint: "Free-form claude sessions in an environment, with the account and worktree of your choice" },
        ],
    },
    {
        group: "Insights",
        items: [
            { id: "analytics", label: "Usage", icon: "chart", hint: "Token and cost usage by environment, task, account" },
            { id: "timing", label: "Timing", icon: "clock", hint: "How long runs and tasks take: by stage, operation, task, day; working vs waiting" },
            { id: "resources", label: "Resources", icon: "cpu", hint: "Everything Vortex runs on this host, with memory, owner and the cleanup policy" },
        ],
    },
    {
        group: "Settings",
        items: [
            { id: "envs", label: "Environments", icon: "server", hint: "Repositories, services, which config dir and account they use" },
            { id: "config-dirs", label: "Config dirs", icon: "folder", hint: "Claude config dirs: skills, hooks, rules, Chrome" },
            { id: "accounts", label: "AI accounts", icon: "user", hint: "Provider logins (tokens), usage, failover" },
            { id: "integrations", label: "Integrations", icon: "plug", hint: "External services: task managers, notifications, decision model" },
            { id: "prompter", label: "Prompter", icon: "spark", hint: "The in-app assistant: which account runs it, its model, idle and purge times" },
        ],
    },
];

// The list pages ManagePage renders, by route page.
const MANAGE_TAB: Partial<Record<Page, ManageTab>> = { envs: "envs", "config-dirs": "dirs", accounts: "accounts", integrations: "integrations", prompter: "prompter" };

// Accounts that can drive runs in this env: any with a token, or a legacy login living in the env's config dir.
const accountsFor = (env: Env | undefined, accounts: Account[], dirs: ConfigDir[]): Account[] => {
    const dir = env?.config_dir_id ? dirs.find((d) => d.id === env.config_dir_id) : undefined;
    return dir ? accounts.filter((a) => accountUsableWith(a, dir.path)) : accounts.filter((a) => a.logged_in === 1);
};

export const App = () => {
    const route = useRoute();
    const page = route.page;
    // The open task and its view come from the route: Tasks opens it in place of the list.
    const selected = (route.page === "tasks") && route.task ? route.task : null;
    const taskView: TaskView = ((route.page === "tasks") && route.view) || { tab: "work" };
    const creating = route.page === "tasks" && !!route.create;
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [configDirs, setConfigDirs] = useState<ConfigDir[]>([]);
    const [envs, setEnvs] = useState<Env[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    // The environment whose tasks the list shows: the route's, else the open task's, else the one used last.
    const [rememberedEnv, setRememberedEnv] = useState<string>(() => storage.get("vortex.env") ?? "");
    const routeEnv = route.page === "tasks" ? route.env : undefined;
    const selectedTaskEnv = selected ? tasks.find((t) => t.id === selected)?.env_id : undefined;
    const envId = routeEnv ?? selectedTaskEnv ?? rememberedEnv;
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [feed, setFeed] = useState<Record<string, string[]>>({});
    // The "Add environment" / "Add AI account" dialogs are routed (#/envs/new, #/accounts/new).
    const modal: "env" | "account" | null = route.page === "envs" && route.create ? "env" : route.page === "accounts" && route.create ? "account" : null;
    const setModal = (m: "env" | "account" | null): void => navigate(m === "env" ? { page: "envs", create: true } : m === "account" ? { page: "accounts", create: true } : modal === "env" ? { page: "envs" } : { page: "accounts" });
    const [settings, setSettings] = useState<Settings | null>(null);
    const [readiness, setReadiness] = useState<Readiness[]>([]);
    useEffect(() => {
        void api.settings().then(setSettings).catch(() => undefined);
    }, [modal, creating]);
    const [terminal, setTerminal] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [collapsed, setCollapsed] = useState<boolean>(() => storage.get("vortex.sidebar.collapsed") === "1");
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [connected, setConnected] = useState(true);

    // An old-shaped link (#/env/<id>, #/dir/<id>, #/managers, a task without a tab) is rewritten to its current form once.
    useEffect(() => {
        const h = formatRoute(route);
        if (location.hash !== h) navigate(route, { replace: true });
    }, [route]);
    useEffect(() => {
        if (!envId) return;
        storage.set("vortex.env", envId);
        setRememberedEnv(envId);
    }, [envId]);
    // Back to the list the task was opened from.
    const closeTask = useCallback(() => navigate({ page: "tasks", ...(route.page === "tasks" && route.list ? { list: route.list } : {}), ...(envId ? { env: envId } : {}) }), [route, envId]);
    const listRoute = useCallback((env?: string) => ({ page: "tasks" as const, ...(env ?? envId ? { env: env ?? envId } : {}) }), [envId]);

    const reload = useCallback(async () => {
        const [a, e, t, d, s, r] = await Promise.all([api.accounts(), api.envs(), api.tasks(), api.configDirs(), api.settings().catch(() => null), api.readiness().catch(() => [] as Readiness[])]);
        setAccounts(a);
        setEnvs(e);
        setTasks(t);
        setConfigDirs(d);
        setReadiness(r);
        if (s) setSettings(s);
        if (!envId && e[0]) setRememberedEnv(e[0].id);
    }, [envId]);

    // The open task, read by async callbacks at the moment they finish. A detail fetched for a task that is no longer
    // the open one is dropped: responses arrive out of order, and an update of a busy task (INV-155) fetched just
    // after the human switched to another (INV-149) used to replace the open task on screen.
    const selectedRef = useRef<string | null>(selected);
    selectedRef.current = selected;
    const loadDetail = useCallback(async (id: string) => {
        const d = await api.task(id);
        if (selectedRef.current === id) setDetail(d);
    }, []);

    // A task named by the URL that no longer exists (deleted) sends the view back to its list.
    useEffect(() => {
        if (!selected || !tasks.length) return;
        if (!tasks.some((x) => x.id === selected)) closeTask();
    }, [selected, tasks, closeTask]);
    useEffect(() => {
        if (page !== "tasks") void reload();
    }, [page, reload]);

    useEffect(() => {
        void reload();
    }, [reload]);

    // Live updates. The socket reconnects on its own after a drop (a server restart): the lists are re-read and the
    // Prompter widget re-attaches to its session, so nobody has to reload the page.
    useEffect(() => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        let ws: WebSocket | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        let dropped = false;
        let closed = false;
        const connect = () => {
            ws = new WebSocket(`${proto}://${location.host}/ws/events`);
            ws.onopen = () => {
                setConnected(true);
                if (!dropped) return;
                dropped = false;
                void reload();
                prompterBus.reconnected();
            };
            ws.onclose = () => {
                if (closed) return;
                setConnected(false);
                dropped = true;
                retry = setTimeout(connect, 3_000);
            };
            ws.onmessage = (e) => {
                const msg = JSON.parse(e.data as string) as { kind: string; payload: unknown };
                if (msg.kind === "task") {
                    const t = msg.payload as Task | null;
                    if (!t) return;
                    setTasks((prev) => (prev.some((p) => p.id === t.id) ? prev.map((p) => (p.id === t.id ? t : p)) : [t, ...prev]));
                    if (t.id === selectedRef.current) void loadDetail(t.id);
                }
                if (msg.kind === "activity") {
                    const a = msg.payload as { taskId: string; event: { kind: string; summary: string } };
                    setFeed((f) => ({ ...f, [a.taskId]: [...(f[a.taskId] ?? []).slice(-199), `${a.event.kind}: ${a.event.summary}`] }));
                }
                if (msg.kind === "message") {
                    const m = msg.payload as { task_id: string };
                    if (m.task_id === selectedRef.current) void loadDetail(m.task_id);
                }
                if (msg.kind === "rate_limit" || msg.kind === "account") void Promise.all([api.accounts(), api.configDirs()]).then(([a, d]) => { setAccounts(a); setConfigDirs(d); });
                if (msg.kind === "prompter") prompterBus.emit(msg.payload as PrompterEvent);
                if (msg.kind === "po") poBus.emit(msg.payload as PoEvent);
            };
        };
        connect();
        return () => {
            closed = true;
            if (retry) clearTimeout(retry);
            ws?.close();
        };
    }, [loadDetail, reload]);

    useEffect(() => {
        if (selected) void loadDetail(selected);
        else setDetail(null);
    }, [selected, loadDetail]);

    const visible = useMemo(() => tasks.filter((t) => !envId || t.env_id === envId), [tasks, envId]);
    const attention = useMemo(() => tasks.filter((t) => taskState(t).group === "attention").length, [tasks]);
    const working = useMemo(() => tasks.filter((t) => taskState(t).group === "working").length, [tasks]);

    const run = async (fn: () => Promise<unknown>) => {
        try {
            setError(null);
            await fn();
            await reload();
            if (selected) await loadDetail(selected);
        } catch (e) {
            setError(String((e as Error).message ?? e));
        }
    };

    const env = envs.find((e) => e.id === envId);
    // The environment / config dir whose own page is open (#/envs/<id>, #/config-dirs/<id>); the list otherwise.
    const envPage = route.page === "envs" && route.env ? envs.find((e) => e.id === route.env) : undefined;
    const dir = route.page === "config-dirs" && route.dir ? configDirs.find((d) => d.id === route.dir) : undefined;
    const accountPage = route.page === "accounts" && route.account ? accounts.find((a) => a.id === route.account) : undefined;
    const integrationId = route.page === "integrations" ? route.integration : undefined;

    // The selected task's detail view — the same on the Tasks page.
    const taskDetailView = detail && detail.task.id === selected && (
        <ErrorBoundary key={detail.task.id} label="Task view">
            <TaskDetailView
                detail={detail}
                accounts={accountsFor(envs.find((e) => e.id === detail.task.env_id), accounts, configDirs)}
                env={envs.find((e) => e.id === detail.task.env_id)}
                onError={setError}
                feed={feed[detail.task.id] ?? []}
                terminal={terminal}
                onAction={run}
                view={taskView}
                onView={(v) => navigate(taskRoute(route, detail.task.id, v))}
                onOpenTerminal={async () => {
                    const r = await api.terminal(detail.task.id);
                    setTerminal(r.terminal);
                }}
                onCloseTerminal={() => setTerminal(null)}
                onClose={closeTask}
                listLabel="Tasks"
            />
        </ErrorBoundary>
    );

    // Bulk delete of the ticked tasks: same cleanup as a single Delete; tasks whose commits exist nowhere else are
    // refused first and offered a second, forced pass.
    const deletePicked = async (picked: string[]) => {
        const ids = picked.filter((id) => tasks.some((t) => t.id === id));
        if (ids.length === 0) return;
        const names = ids.map((id) => tasks.find((t) => t.id === id)?.ticket_id ?? id);
        if (!confirm(`Delete ${ids.length} task${ids.length === 1 ? "" : "s"} (${names.join(", ")})? Each is cleaned up (BE/FE, Chrome tabs, worktree, local branch) and then removed. PRs stay on GitHub.`)) return;
        const refused: Array<{ id: string; name: string; msg: string }> = [];
        for (const id of ids) {
            try {
                await api.deleteTask(id);
            } catch (e) {
                const msg = String((e as Error).message ?? e);
                if (/nowhere else/.test(msg)) refused.push({ id, name: tasks.find((t) => t.id === id)?.ticket_id ?? id, msg });
                else setError(msg);
            }
        }
        if (refused.length && confirm(`${refused.map((r) => `${r.name}: ${r.msg}`).join("\n\n")}\n\nDiscard their work and delete anyway?`)) {
            for (const r of refused) await api.deleteTask(r.id, false, true).catch((e: Error) => setError(e.message));
        }
        if (selected && ids.includes(selected)) closeTask();
        await reload();
    };

    // The drawer closes when the route changes (a link was followed); ⌘K / Ctrl+K opens the palette from anywhere.
    useEffect(() => { setDrawerOpen(false); }, [route]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setPaletteOpen((o) => !o);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const toggleCollapsed = (): void => setCollapsed((c) => { storage.set("vortex.sidebar.collapsed", c ? "0" : "1"); return !c; });

    const pageRoute = (id: Page) => (id === "tasks" ? listRoute() : ({ page: id } as const));
    const navGroups: NavGroup[] = NAV.map((g) => ({
        label: g.group,
        items: g.items.map((n) => ({
            id: n.id,
            label: n.label,
            icon: n.icon,
            hint: n.hint,
            href: formatRoute(pageRoute(n.id)),
            ...(n.id === "tasks" && attention > 0 ? { badge: { count: attention, tone: "warn" as const } } : n.id === "tasks" && working > 0 ? { badge: { count: working, tone: "info" as const } } : {}),
        })),
    }));
    const commands = useMemo<Command[]>(() => [
        ...NAV.flatMap((g) => g.items.map((n) => ({ id: `page-${n.id}`, label: n.label, group: "Pages", icon: n.icon, keywords: `${g.group} ${n.hint}`, run: () => navigate(n.id === "tasks" ? { page: "tasks" } : ({ page: n.id } as Route)) }))),
        { id: "page-tasks-completed", label: "Completed tasks", group: "Pages", icon: "tasks" as const, keywords: "finished stopped done", run: () => navigate({ page: "tasks", list: "completed" }) },
        ...envs.map((e) => ({ id: `env-${e.id}`, label: `${e.name} tasks`, group: "Environments", icon: "server" as const, note: e.base_branch, run: () => navigate({ page: "tasks", env: e.id }) })),
        ...[...tasks].sort((a, b) => taskState(a).rank - taskState(b).rank || b.updated_at.localeCompare(a.updated_at)).map((t) => ({
            id: `task-${t.id}`, label: `${t.ticket_id}${t.title ? ` ${t.title}` : ""}`, group: "Tasks", icon: "tasks" as const, note: taskState(t).label,
            keywords: envs.find((e) => e.id === t.env_id)?.name ?? "", run: () => navigate({ page: "tasks", task: t.id }),
        })),
    ], [envs, tasks]);

    const frame = (node: React.ReactNode, width: "narrow" | "default" | "wide" | "full" = "default") => <PageFrame width={width}>{node}</PageFrame>;
    const tasksDetailPane = selected ? (taskDetailView ?? <div className="empty">Loading…</div>) : <div className="empty">Select a task, or add one.</div>;

    return (
        <AppShell
            collapsed={collapsed}
            drawerOpen={drawerOpen}
            onCloseDrawer={() => setDrawerOpen(false)}
            sidebar={<Sidebar groups={navGroups} current={page} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} onNavigate={(n) => navigate(pageRoute(n.id as Page))} />}
            topbar={
                <Topbar onMenu={() => setDrawerOpen(true)} onSearch={() => setPaletteOpen(true)}>
                    <span className="live" title={connected ? "Receiving live updates" : "The connection to the Vortex server dropped; reconnecting"}>
                        <StatusDot tone={connected ? "ok" : "warn"} pulse={!connected} />
                        <span className="live-text">{connected ? "Live" : "Reconnecting…"}</span>
                    </span>
                    <UsageGauges accounts={accounts} onRefresh={(a) => void api.refreshLimits(a.id).then((r) => { if (!r.ok) setError(`limits refresh (${a.name}): ${r.detail}`); }).then(reload).catch((e: Error) => setError(e.message))} />
                </Topbar>
            }
            overlays={
                <>
                    {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
                    {creating && env && (
                        <Modal title={`New task in ${env.name}`} onClose={() => navigate(listRoute())}>
                            <TaskForm accounts={accountsFor(env, accounts, configDirs)} env={env} settings={settings} readiness={readiness.find((r) => r.envId === env.id)} onSubmit={async (body) => { await run(() => api.createTasks({ envId: env.id, ...body })); navigate(listRoute()); }} />
                        </Modal>
                    )}
                    {modal === "env" && (
                        <Modal title="Add environment" onClose={() => setModal(null)}>
                            <EnvForm accounts={accounts} configDirs={configDirs} onSubmit={async (b) => { await run(() => api.addEnv(b)); setModal(null); }} />
                        </Modal>
                    )}
                    {modal === "account" && (
                        <Modal title="Add AI account" onClose={() => setModal(null)}>
                            <AccountForm onSubmit={async (name, email) => {
                                try {
                                    const r = await api.addAccount(name, email);
                                    setModal(null);
                                    setTerminal(r.terminal);
                                    await reload();
                                } catch (e) {
                                    setError(String((e as Error).message ?? e));
                                }
                            }} />
                        </Modal>
                    )}
                    {terminal && !detail && (
                        <Modal title={`Terminal · ${terminal}`} onClose={() => setTerminal(null)} wide>
                            <LazyTerminal session={terminal} />
                        </Modal>
                    )}
                    <ErrorBoundary label="Prompter"><Prompter route={route} settings={settings} /></ErrorBoundary>
                </>
            }
        >
            {error && (
                <div className="page-notice">
                    <Notice tone="bad">
                        <span>{error}</span>
                        <Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>
                    </Notice>
                </div>
            )}
            {page === "analytics" && frame(<ErrorBoundary label="Usage"><Analytics days={route.page === "analytics" ? route.days : undefined} onDays={(d) => navigate({ page: "analytics", days: d })} onError={setError} /></ErrorBoundary>)}
            {page === "product" && frame(
                <ErrorBoundary label="Product">
                    {route.page === "product" && <ProductPage route={route} onError={setError} />}
                </ErrorBoundary>,
                "wide",
            )}
            {page === "resources" && frame(<ErrorBoundary label="Resources"><ResourcesPage tab={route.page === "resources" ? route.tab : undefined} onTab={(t) => navigate({ page: "resources", tab: t })} onError={setError} /></ErrorBoundary>, "wide")}
            {page === "timing" && frame(<ErrorBoundary label="Timing"><Timing days={route.page === "timing" ? route.days : undefined} onDays={(d) => navigate({ page: "timing", days: d })} onError={setError} /></ErrorBoundary>)}
            {page === "sessions" && frame(
                <ErrorBoundary label="Sessions">
                    <SessionsPage
                        envs={envs}
                        accounts={accounts}
                        configDirs={configDirs}
                        settings={settings}
                        session={route.page === "sessions" ? route.session ?? null : null}
                        view={route.page === "sessions" ? route.view ?? "terminal" : "terminal"}
                        creating={route.page === "sessions" && !!route.create}
                        diff={route.page === "sessions" ? route.diff : undefined}
                        onNavigate={(session, view) => navigate({ page: "sessions", ...(session ? { session, view: view ?? "terminal" } : {}) })}
                        onCreating={(on) => navigate({ page: "sessions", ...(on ? { create: true } : {}) })}
                        onDiff={(d) => navigate((r) => (r.page === "sessions" ? { ...r, diff: d } : r))}
                        onError={setError}
                    />
                </ErrorBoundary>,
                "full",
            )}
            {page === "envs" && envPage && frame(<EnvPage key={envPage.id} env={envPage} tab={route.page === "envs" ? route.tab : undefined} onTab={(t) => navigate({ page: "envs", env: envPage.id, tab: t })} envs={envs} accounts={accounts} configDirs={configDirs} tasks={tasks} onBack={() => navigate({ page: "envs" })} onOpenDir={(id) => navigate({ page: "config-dirs", dir: id })} onChanged={reload} onError={setError} />)}
            {page === "config-dirs" && dir && frame(<ConfigDirPage key={dir.id} dir={dir} tab={route.page === "config-dirs" ? route.tab : undefined} onTab={(t) => navigate({ page: "config-dirs", dir: dir.id, tab: t })} onBack={() => navigate({ page: "config-dirs" })} onChanged={reload} onError={setError} />)}
            {page === "accounts" && accountPage && frame(<AccountPage key={accountPage.id} a={accountPage} tab={route.page === "accounts" ? route.tab : undefined} onTab={(t) => navigate({ page: "accounts", account: accountPage.id, tab: t })} envs={envs} tasks={tasks} settings={settings} onBack={() => navigate({ page: "accounts" })} onChanged={reload} onError={setError} onTerminal={setTerminal} />)}
            {page === "integrations" && integrationId && frame(<IntegrationPage key={integrationId} id={integrationId} tab={route.page === "integrations" ? route.tab : undefined} onTab={(t) => navigate({ page: "integrations", integration: integrationId, tab: t })} settings={settings} onBack={() => navigate({ page: "integrations" })} onChanged={reload} onError={setError} />)}
            {MANAGE_TAB[page] && !envPage && !dir && !accountPage && !integrationId && frame(
                <ManagePage
                    tab={MANAGE_TAB[page]!}
                    route={route}
                    envs={envs}
                    configDirs={configDirs}
                    accounts={accounts}
                    tasks={tasks}
                    settings={settings}
                    onConfigureEnv={(id) => navigate({ page: "envs", env: id })}
                    onOpenDir={(id) => navigate({ page: "config-dirs", dir: id })}
                    onAddEnv={() => setModal("env")}
                    onAddAccount={() => setModal("account")}
                    onOpenAccount={(id) => navigate({ page: "accounts", account: id })}
                    onOpenIntegration={(id) => navigate({ page: "integrations", integration: id })}
                    onChanged={reload}
                    onError={setError}
                />,
                "wide",
            )}
            {page === "tasks" && (
                <TasksPage
                    envs={envs}
                    envId={envId}
                    env={env}
                    tasks={tasks}
                    visible={visible}
                    list={route.page === "tasks" ? route.list : undefined}
                    onList={(list) => navigate({ page: "tasks", ...(list ? { list } : {}), ...(envId ? { env: envId } : {}) })}
                    selected={selected}
                    detailPane={tasksDetailPane}
                    onDeleteTasks={(ids) => void deletePicked(ids)}
                    onSelectEnv={(id) => navigate(listRoute(id))}
                    onNewTask={() => navigate({ ...listRoute(), create: true })}
                    onOpen={(id) => navigate(taskRoute(route, id))}
                />
            )}
        </AppShell>
    );
};

export { STAGE_ORDER };
