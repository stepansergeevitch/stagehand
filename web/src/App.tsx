import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LabelChips } from "./Labels";
import { BranchPicker } from "./BranchPicker";
import { accountOrderOf, accountUsableWith, api, envRepos, poEnvIds, labelsOf, modelLabel, STAGE_LABEL, STAGE_ORDER, taskLabel, type Account, type ConfigDir, type Env, type MyTicket, type PoEvent, type ProductOwner, type Readiness, type Settings, type Task, type TaskDetail } from "./api";
import { TaskDetailView } from "./TaskDetail";
import { formatRoute, navigate, taskRoute, useRoute, type Page, type TaskView } from "./routes";
import { Prompter } from "./Prompter";
import { prompterBus, type PrompterEvent } from "./prompterBus";
import { EnvPage } from "./EnvPage";
import { AccountPage, IntegrationPage } from "./ConfigEntities";
import { ConfigDirPage } from "./ConfigDirPage";
import { ManagePage, type ManageTab } from "./ManagePage";
import { Dashboard, needsAttention } from "./Dashboard";
import { Analytics } from "./Analytics";
import { ResourcesPage } from "./ResourcesPage";
import { Timing } from "./Timing";
import { SessionsPage } from "./SessionsPage";
import { ProductPage } from "./ProductPage";
import { poBus } from "./poBus";
import { storage } from "./storage";
import { ErrorBoundary } from "./ErrorBoundary";
import { LazyTerminal } from "./LazyTerminal";
import { AgentInput } from "./AgentInput";
import { Modal } from "./Modal";
import { BaseCheckChip } from "./components/BaseCheckChip";
import { Button, Chip, Input, Select, Textarea } from "@vortex/ds";

// Where the user is lives in the URL hash only (see routes.ts): reloads, back/forward, pasted links and anything that
// reads the path see the same screen.
// The sidebar in groups; a group without a title is a single top-level page.
const NAV: { group: string | null; items: { id: Page; label: string; hint: string }[] }[] = [
    {
        group: "Work",
        items: [
            { id: "dashboard", label: "Dashboard", hint: "Tasks needing your attention, per environment" },
            { id: "tasks", label: "Environments", hint: "The tasks of the selected environment" },
        ],
    },
    { group: null, items: [{ id: "product", label: "Product", hint: "The product context and the Product Owners — one per project: plan it, design it, split it into tickets" }] },
    { group: null, items: [{ id: "sessions", label: "Sessions", hint: "Free-form claude sessions in an environment, with the account and worktree of your choice" }] },
    {
        group: "Analytics",
        items: [
            { id: "analytics", label: "Usage", hint: "Token and cost usage by environment, task, account" },
            { id: "timing", label: "Timing", hint: "How long runs and tasks take: by stage, operation, task, day; working vs waiting" },
            { id: "resources", label: "Resources", hint: "Everything Stagehand runs on this host — dev servers, agent runs, browsers, terminals, worktrees — with memory, owner and the cleanup policy" },
        ],
    },
    {
        group: "Configuration",
        items: [
            { id: "envs", label: "Environments", hint: "Repositories, services, which config dir and account they use" },
            { id: "config-dirs", label: "Config dirs", hint: "Claude config dirs: skills, hooks, rules, Chrome" },
            { id: "accounts", label: "AI accounts", hint: "Provider logins (tokens), usage, failover" },
            { id: "integrations", label: "Integrations", hint: "External services, each tagged with its type: task managers (ClickUp, Linear), notifications, decision model (Jev)" },
            { id: "prompter", label: "Prompter", hint: "The in-app assistant: which account runs it, its model, idle and purge times, its palace" },
        ],
    },
];
type NavItem = (typeof NAV)[number]["items"][number];
// The sidebar as a tree: a group is a node like a page, collapsible (remembered per browser); a collapsed group whose
// page is open shows as active.
const SidebarTree = ({ page, renderItem }: { page: Page; renderItem: (n: NavItem, child: boolean) => React.ReactNode }) => {
    const [closed, setClosed] = useState<Set<string>>(() => {
        try {
            return new Set(JSON.parse(localStorage.getItem("stagehand.sidebar.closed") ?? "[]") as string[]);
        } catch {
            return new Set();
        }
    });
    const toggle = (g: string): void =>
        setClosed((cur) => {
            const next = new Set(cur);
            if (next.has(g)) next.delete(g);
            else next.add(g);
            try {
                localStorage.setItem("stagehand.sidebar.closed", JSON.stringify([...next]));
            } catch {
                /* the tree still works, unremembered */
            }
            return next;
        });
    return (
        <>
            {NAV.map((g) => {
                if (!g.group) return g.items.map((n) => renderItem(n, false));
                const open = !closed.has(g.group);
                const within = g.items.some((n) => n.id === page);
                return [
                    <Button key={`group-${g.group}`} className={`sidebar-node${!open && within ? " active" : ""}`} aria-expanded={open} onClick={() => toggle(g.group!)}>
                        {g.group}
                        <span className="caret">{open ? "▾" : "▸"}</span>
                    </Button>,
                    ...(open ? g.items.map((n) => renderItem(n, true)) : []),
                ];
            })}
        </>
    );
};

// The list pages ManagePage renders, by route page.
const MANAGE_TAB: Partial<Record<Page, ManageTab>> = { envs: "envs", "config-dirs": "dirs", accounts: "accounts", integrations: "integrations", prompter: "prompter" };

// Accounts that can drive runs in this env: any with a token, or a legacy login living in the env's config dir.
const accountsFor = (env: Env | undefined, accounts: Account[], dirs: ConfigDir[]): Account[] => {
    const dir = env?.config_dir_id ? dirs.find((d) => d.id === env.config_dir_id) : undefined;
    return dir ? accounts.filter((a) => accountUsableWith(a, dir.path)) : accounts.filter((a) => a.logged_in === 1);
};

type Group = "Pinned" | "Needs input" | "Working" | "Idle" | "Failed" | "Completed" | "Stopped";

const groupOf = (t: Task): Group => {
    if (t.pinned) return "Pinned";
    switch (t.status) {
        case "waiting_user":
        case "blocked":
            return "Needs input";
        case "running":
        case "queued":
            return "Working";
        case "failed":
            return "Failed";
        case "done":
            return "Completed";
        case "stopped":
            return "Stopped";
        default:
            return "Idle";
    }
};
const GROUP_ORDER: Group[] = ["Pinned", "Needs input", "Working", "Idle", "Failed", "Completed", "Stopped"];
const ICON: Record<Group, [string, string]> = {
    Pinned: ["✻", "needs"], "Needs input": ["✻", "needs"], Working: ["✽", "working"], Idle: ["∙", "idle"],
    Failed: ["∙", "failed"], Completed: ["∙", "done"], Stopped: ["∙", "stopped"],
};

const age = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
};

const fmtTokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const fmtMoney = (n: number): string => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

// Subscription accounts: the two rate-limit windows as stacked bars (d = the rolling 5-hour window, w = the 7-day one).
// Enterprise accounts have no windows to show; they get what was consumed today and this week instead.
const Gauge = ({ a, onRefresh }: { a: Account; onRefresh: () => void }) => {
    const five = a.limits.find((l) => l.window === "five_hour");
    const week = a.limits.find((l) => l.window === "seven_day");
    const cls = (u: number) => (u >= 0.9 ? "bad" : u >= 0.6 ? "warn" : "");
    const enterprise = a.plan === "enterprise";
    const usage = a.usage ?? { today: { tokens: 0, cost: 0 }, week: { tokens: 0, cost: 0 } };
    // A window past its reset instant says nothing about now; show it as unknown until a run or a refresh reports it.
    const val = (l: typeof five) => (!l ? "—" : l.expired ? "?" : `${Math.round(l.utilization * 100)}%`);
    const fill = (l: typeof five) => (!l || l.expired ? 0 : l.utilization);
    const stale = !!five?.expired || !!week?.expired;
    const asOf = five?.updatedAt ? new Date(five.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
    const title = `${a.email ?? "no auth"} · ${a.org ?? ""} · ${a.plan ?? ""}${five ? ` · 5h window ${val(five)}` : ""}${week ? ` · 7d window ${val(week)}` : ""}${asOf ? ` · as of ${asOf}` : ""}${stale ? " · window reset since — click ↻ to refresh (one tiny Sonnet turn)" : ""}${enterprise ? " · what Stagehand ran on this account (tasks, helpers, probes)" : ""}`;
    return (
        <span className={`gauge ${enterprise ? "enterprise" : ""} ${stale ? "stale" : ""}`} title={title}>
            <span className="gauge-name">
                {a.name}{!a.logged_in && <Chip tone="bad">no auth</Chip>}{a.logged_in === 1 && !a.has_token && <Chip tone="warn">legacy</Chip>}
                {!enterprise && a.logged_in === 1 && <Button variant="ghost" className="refresh" disabled={a.refreshing_limits} onClick={onRefresh} title="Refresh the windows now (one tiny Sonnet turn)">{a.refreshing_limits ? "…" : "↻"}</Button>}
            </span>
            {enterprise ? (
                <span className="gauge-usage">
                    <span><small>today</small> {fmtTokens(usage.today.tokens)} · {fmtMoney(usage.today.cost)}</span>
                    <span><small>week</small> {fmtTokens(usage.week.tokens)} · {fmtMoney(usage.week.cost)}</span>
                </span>
            ) : (
                <span className="gauge-bars">
                    <span className="gauge-row"><small>d</small><span className="bar"><i className={cls(fill(five))} style={{ width: `${Math.round(fill(five) * 100)}%` }} /></span><span>{val(five)}</span></span>
                    <span className="gauge-row"><small>w</small><span className="bar"><i className={cls(fill(week))} style={{ width: `${Math.round(fill(week) * 100)}%` }} /></span><span>{val(week)}</span></span>
                </span>
            )}
        </span>
    );
};

export const App = () => {
    const route = useRoute();
    const page = route.page;
    // The open task and its view come from the route: the Dashboard keeps a task in place, Tasks opens it beside the list.
    const selected = (route.page === "tasks" || route.page === "dashboard") && route.task ? route.task : null;
    const taskView: TaskView = ((route.page === "tasks" || route.page === "dashboard") && route.view) || { tab: "work" };
    const creating = route.page === "tasks" && !!route.create;
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [configDirs, setConfigDirs] = useState<ConfigDir[]>([]);
    const [envs, setEnvs] = useState<Env[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    // The environment whose tasks the list shows: the route's, else the open task's, else the one used last.
    const [rememberedEnv, setRememberedEnv] = useState<string>(() => storage.get("stagehand.env") ?? "");
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
    const [moreOpen, setMoreOpen] = useState(false);
    // Tasks ticked in the list for a bulk delete.
    const [picked, setPicked] = useState<Set<string>>(() => new Set());

    // An old-shaped link (#/env/<id>, #/dir/<id>, #/managers, a task without a tab) is rewritten to its current form once.
    useEffect(() => {
        const h = formatRoute(route);
        if (location.hash !== h) navigate(route, { replace: true });
    }, [route]);
    useEffect(() => {
        if (!envId) return;
        storage.set("stagehand.env", envId);
        setRememberedEnv(envId);
    }, [envId]);
    // Back to the list the task was opened from.
    const closeTask = useCallback(() => navigate(route.page === "dashboard" ? { page: "dashboard" } : { page: "tasks", ...(envId ? { env: envId } : {}) }), [route.page, envId]);
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
                if (!dropped) return;
                dropped = false;
                void reload();
                prompterBus.reconnected();
            };
            ws.onclose = () => {
                if (closed) return;
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
    const attention = useMemo(() => tasks.filter(needsAttention).length, [tasks]);
    const grouped = useMemo(() => {
        const m = new Map<Group, Task[]>();
        for (const t of visible) m.set(groupOf(t), [...(m.get(groupOf(t)) ?? []), t]);
        return GROUP_ORDER.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
    }, [visible]);

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

    // The selected task's detail view — the same on the Tasks page and when a task is opened from the Dashboard.
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
            />
        </ErrorBoundary>
    );

    // Bulk delete of the ticked tasks: same cleanup as a single Delete; tasks whose commits exist nowhere else are
    // refused first and offered a second, forced pass.
    const deletePicked = async () => {
        const ids = [...picked].filter((id) => tasks.some((t) => t.id === id));
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
        setPicked(new Set());
        if (selected && ids.includes(selected)) closeTask();
        await reload();
    };

    return (
        <div className="app">
            <header className={`topbar ${moreOpen ? "more-open" : ""}`}>
                <span className="brand">Stagehand</span>
                <span className="spacer" />
                <Button variant="ghost" className="more" onClick={() => setMoreOpen((v) => !v)} title="Account usage">⋯</Button>
                <span className="extra gauges">{accounts.map((a) => <Gauge key={a.id} a={a} onRefresh={() => void api.refreshLimits(a.id).then((r) => { if (!r.ok) setError(`limits refresh (${a.name}): ${r.detail}`); }).then(reload).catch((e: Error) => setError(e.message))} />)}</span>
            </header>
            <div className="body">
                <nav className="sidebar" aria-label="Sections">
                    <SidebarTree page={page} renderItem={(n, child) => (
                        <Button variant="ghost" key={n.id} className={`${page === n.id ? "active" : ""}${child ? " child" : ""}`} title={n.hint} onClick={() => navigate(n.id === "tasks" ? listRoute() : { page: n.id })}>
                            {n.label}
                            {n.id === "dashboard" && attention > 0 && <span className="count alert">{attention}</span>}
                            {n.id === "tasks" && visible.length > 0 && <span className="count">{visible.length}</span>}
                            {n.id === "envs" && envs.length > 0 && <span className="count">{envs.length}</span>}
                            {n.id === "accounts" && accounts.length > 0 && <span className="count">{accounts.length}</span>}
                        </Button>
                    )} />
                </nav>
                {page === "dashboard" && (
                    <div className="main page">
                        <main className="detail">
                            {selected && <Button variant="ghost" className="back" onClick={closeTask}>← dashboard</Button>}
                            {error && <div className="blocked-box">{error}</div>}
                            {/* A task opened from the Dashboard shows here, in place; back returns to the cards. */}
                            {selected ? (taskDetailView ?? <div className="empty">Loading…</div>) : <ErrorBoundary label="Dashboard"><Dashboard envs={envs} tasks={tasks} readiness={readiness} onOpen={(t) => navigate({ page: "dashboard", task: t.id })} /></ErrorBoundary>}
                        </main>
                    </div>
                )}
                {page === "analytics" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ErrorBoundary label="Analytics"><Analytics days={route.page === "analytics" ? route.days : undefined} onDays={(d) => navigate({ page: "analytics", days: d })} onError={setError} /></ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "product" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ErrorBoundary label="Product">
                                {route.page === "product" && <ProductPage route={route} onError={setError} />}
                            </ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "resources" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ErrorBoundary label="Resources"><ResourcesPage tab={route.page === "resources" ? route.tab : undefined} onTab={(t) => navigate({ page: "resources", tab: t })} onError={setError} /></ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "timing" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ErrorBoundary label="Timing"><Timing days={route.page === "timing" ? route.days : undefined} onDays={(d) => navigate({ page: "timing", days: d })} onError={setError} /></ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "sessions" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
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
                            </ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "envs" && envPage && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <EnvPage key={envPage.id} env={envPage} tab={route.page === "envs" ? route.tab : undefined} onTab={(t) => navigate({ page: "envs", env: envPage.id, tab: t })} envs={envs} accounts={accounts} configDirs={configDirs} onBack={() => navigate({ page: "envs" })} onOpenDir={(id) => navigate({ page: "config-dirs", dir: id })} onChanged={reload} onError={setError} />
                        </main>
                    </div>
                )}
                {page === "config-dirs" && dir && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ConfigDirPage key={dir.id} dir={dir} tab={route.page === "config-dirs" ? route.tab : undefined} onTab={(t) => navigate({ page: "config-dirs", dir: dir.id, tab: t })} onBack={() => navigate({ page: "config-dirs" })} onChanged={reload} onError={setError} />
                        </main>
                    </div>
                )}
                {page === "accounts" && accountPage && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <AccountPage key={accountPage.id} a={accountPage} tab={route.page === "accounts" ? route.tab : undefined} onTab={(t) => navigate({ page: "accounts", account: accountPage.id, tab: t })} envs={envs} tasks={tasks} settings={settings} onBack={() => navigate({ page: "accounts" })} onChanged={reload} onError={setError} onTerminal={setTerminal} />
                        </main>
                    </div>
                )}
                {page === "integrations" && integrationId && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <IntegrationPage key={integrationId} id={integrationId} tab={route.page === "integrations" ? route.tab : undefined} onTab={(t) => navigate({ page: "integrations", integration: integrationId, tab: t })} settings={settings} onBack={() => navigate({ page: "integrations" })} onChanged={reload} onError={setError} />
                        </main>
                    </div>
                )}
                {MANAGE_TAB[page] && !envPage && !dir && !accountPage && !integrationId && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
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
                            />
                        </main>
                    </div>
                )}
                {page === "tasks" && <div className={`main ${selected ? "has-selection" : ""}`}>
                    <aside className="list">
                        <div className="list-head">
                            <Select value={envId} onChange={(e) => navigate(listRoute(e.target.value))} title="Environment">
                                {envs.map((e) => (
                                    <option key={e.id} value={e.id}>{e.name} ({e.base_branch})</option>
                                ))}
                            </Select>
                            <Button className="new-task" disabled={!env} onClick={() => navigate({ ...listRoute(), create: true })}>
                                <span className="icon">+</span>
                                <span className="name">New task</span>
                            </Button>
                            {picked.size > 0 && (
                                <div className="bulk-bar">
                                    <span>{picked.size} selected</span>
                                    <Button size="sm" variant="danger" onClick={() => void deletePicked()}>Delete selected</Button>
                                    <Button size="sm" onClick={() => setPicked(new Set())}>Clear</Button>
                                </div>
                            )}
                        </div>
                        {visible.length === 0 && <div className="empty">No tasks in this env yet.</div>}
                        {grouped.map(([g, list]) => (
                            <div key={g}>
                                <div className="group">{g}</div>
                                {list.map((t) => {
                                    const [glyph, cls] = ICON[g];
                                    return (
                                        <div key={t.id} className={`row ${selected === t.id ? "selected" : ""} ${picked.has(t.id) ? "picked" : ""}`} onClick={() => navigate(taskRoute(route, t.id))}>
                                            <Input
                                                type="checkbox"
                                                className="pick"
                                                title="Select for bulk delete"
                                                checked={picked.has(t.id)}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })}
                                            />
                                            <span className={`icon ${cls}`}>{glyph}</span>
                                            <span className="name">{taskLabel(t)}<small>{t.title ?? ""}</small></span>
                                            <span className="age">{age(t.updated_at)}</span>
                                            <span className="pr"><BaseCheckChip state={t.base_check_state} detail={t.base_check_detail} compact /></span>
                                            <span className="status"><LabelChips labels={labelsOf(t)} /><span className="status-text">{t.status_line ?? STAGE_LABEL[t.stage]}</span></span>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </aside>
                    <main className="detail">
                        {selected && <Button variant="ghost" className="back" onClick={closeTask}>← tasks</Button>}
                        {error && <div className="blocked-box">{error}</div>}
                        {!detail && <div className="empty">Select a task, or add one.</div>}
                        {taskDetailView}
                    </main>
                </div>}
            </div>
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
        </div>
    );
};


// ClickUp and Linear both use 1 = urgent … 4 = low; 0/null = unset.
const PRIORITY_MARK: Record<number, string> = { 0: "·", 1: "🔴", 2: "🟠", 3: "🟡", 4: "🔵" };

// Splits pasted ticket ids/links (one per line, or separated by commas/spaces).
const splitTickets = (s: string): string[] => [...new Set(s.split(/[\n,;]+|\s+(?=[A-Za-z]|https?:)/).map((x) => x.trim()).filter(Boolean))];
const looksLikeTicket = (s: string): boolean => /app\.clickup\.com\/t\//.test(s) || /linear\.app\/.+\/issue\//.test(s) || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s) || /^[a-z0-9]{6,12}$/i.test(s);

// The sprint's tickets in a dropdown (closed by default, so the form stays short): search box, checkboxes, picked ones as chips.
const TicketPicker = ({ groups, selected, onToggle }: { groups: Array<[string, MyTicket[]]>; selected: string[]; onToggle: (id: string) => void }) => {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey, true);
        return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
    }, [open]);
    const all = groups.flatMap(([, tl]) => tl);
    const picked = all.filter((t) => selected.includes(t.id));
    const needle = q.trim().toLowerCase();
    const match = (t: MyTicket) => !needle || t.id.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle);
    return (
        <div className="ticket-dropdown" ref={ref}>
            <Button type="button" className="ticket-dropdown-toggle" onClick={() => setOpen((v) => !v)}>
                {picked.length ? `${picked.length} picked` : "Pick from my tickets"} <span className="caret">{open ? "▴" : "▾"}</span>
            </Button>
            {picked.length > 0 && (
                <span className="ticket-chips">
                    {picked.map((t) => <Chip key={t.id} tone="accent" title={t.title}>{t.id} <Button variant="ghost" type="button" className="chip-x" onClick={() => onToggle(t.id)} aria-label={`remove ${t.id}`}>×</Button></Chip>)}
                </span>
            )}
            {open && (
                <div className="ticket-menu">
                    <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by id or title…" />
                    <div className="ticket-menu-list">
                        {groups.map(([g, tl]) => {
                            const shown = tl.filter(match);
                            if (shown.length === 0) return null;
                            return (
                                <div key={g}>
                                    <div className="group">{g}</div>
                                    {shown.map((t) => (
                                        <label key={t.id} className={`inline ticket-option ${selected.includes(t.id) ? "picked" : ""}`}>
                                            <Input type="checkbox" checked={selected.includes(t.id)} onChange={() => onToggle(t.id)} />
                                            <span>{PRIORITY_MARK[t.priority ?? 0] ?? "·"} <b>{t.id}</b> {t.title.length > 70 ? `${t.title.slice(0, 70)}…` : t.title} <Chip>{t.status}</Chip></span>
                                        </label>
                                    ))}
                                </div>
                            );
                        })}
                        {all.filter(match).length === 0 && <div className="quiet">nothing matches</div>}
                    </div>
                    <div className="actions" style={{ margin: "6px 0 0" }}><Button variant="primary" type="button" onClick={() => setOpen(false)}>Done{picked.length ? ` (${picked.length})` : ""}</Button></div>
                </div>
            )}
        </div>
    );
};

const TaskForm = ({ accounts, env, settings, readiness, onSubmit }: {
    accounts: Account[]; env: Env; settings: Settings | null; readiness: Readiness | undefined;
    onSubmit: (body: { tickets: string[]; mode: "each" | "batch"; accountId?: string; model?: string; notes?: string; baseBranch?: string | Record<string, string>; productOwnerId?: string | null }) => Promise<void>;
}) => {
    const [ticket, setTicket] = useState("");
    // "" = automatic (the PO whose project the ticket belongs to), "none" = no PO, else a PO id.
    const [owner, setOwner] = useState("");
    const [owners, setOwners] = useState<ProductOwner[]>([]);
    useEffect(() => { void api.productOwners().then(setOwners).catch(() => setOwners([])); }, []);
    const [mode, setMode] = useState<"each" | "batch">("each");
    const [notes, setNotes] = useState("");
    // One base branch per repository ("" = the single repo); empty = the env default.
    const repoKeys = useMemo(() => { const r = envRepos(env); return r.length ? r : [""]; }, [env]);
    const [bases, setBases] = useState<Record<string, string>>({});
    const baseBranch = ((): string | Record<string, string> | undefined => {
        const given: Record<string, string> = Object.fromEntries(repoKeys.map((k) => [k, (bases[k] ?? "").trim()] as const).filter(([, v]) => v && v !== env.base_branch));
        const values: string[] = [...new Set(Object.values(given))];
        if (values.length === 0) return undefined;
        return repoKeys.length === 1 || (values.length === 1 && Object.keys(given).length === repoKeys.length) ? values[0] : given;
    })();
    const [acc, setAcc] = useState(accountOrderOf(env).find((id) => accounts.some((a) => a.id === id)) ?? accounts[0]?.id ?? "");
    const [model, setModel] = useState("");
    const [mine, setMine] = useState<{ tickets: MyTicket[]; error?: string } | null>(null);
    const list = splitTickets(ticket);
    const bad = list.filter((t) => !looksLikeTicket(t));
    const toggle = (id: string) => setTicket(list.includes(id) ? list.filter((x) => x !== id).join("\n") : [...list, id].join("\n"));
    useEffect(() => {
        setMine(null);
        void api.myTickets(env.id).then(setMine).catch((e: Error) => setMine({ tickets: [], error: e.message }));
    }, [env.id]);
    const groups = useMemo(() => {
        const m = new Map<string, MyTicket[]>();
        for (const t of mine?.tickets ?? []) m.set(t.group, [...(m.get(t.group) ?? []), t]);
        return [...m.entries()];
    }, [mine]);
    return (
        <>
            {readiness && readiness.warnings.length > 0 && (
                <div className="blocked-box" style={{ marginBottom: 0 }}>
                    <b>Before you start:</b>
                    <ul className="plain">{readiness.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </div>
            )}
            {readiness && readiness.warnings.length === 0 && <span className="field-hint">Ready: agents run as {readiness.run.join(" → ")}; browser QA as {readiness.browser.join(" → ")}.</span>}
            <div className="ticket-field">
                <span className="ticket-field-label">My tickets{" "}
                    {mine === null ? <Chip>loading…</Chip> : mine.error ? <Chip tone="bad" title={mine.error}>unavailable</Chip> : <Chip>{mine.tickets.length}{env.ticket_source === "clickup" ? " in current sprint" : " assigned"}</Chip>}
                </span>
                {mine && mine.tickets.length > 0 && <TicketPicker groups={groups} selected={list} onToggle={toggle} />}
                {mine?.error && <span className="hint-line">{mine.error}</span>}
            </div>
            <label>Ticket ids or links (one per line for several) <Textarea autoFocus value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder={"PRODUCT-8704\nhttps://app.clickup.com/t/…\nhttps://linear.app/…/issue/…"} style={{ minHeight: 60 }} /></label>
            {list.length > 0 && <Chip className={`${bad.length ? "bad" : "accent"}`}>{bad.length ? `unrecognised: ${bad.join(", ")}` : `${list.length} ticket${list.length === 1 ? "" : "s"}`}</Chip>}
            {list.length > 1 && (
                <label>Dispatch
                    <Select value={mode} onChange={(e) => setMode(e.target.value as "each" | "batch")}>
                        <option value="each">One task per ticket — each gets its own branch and PR ({list.length} tasks)</option>
                        <option value="batch">One task for all — one branch, one PR per repository</option>
                    </Select>
                </label>
            )}
            {owners.length > 0 && (
                <label>Product owner
                    <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                        <option value="">automatic — the one whose project the ticket belongs to</option>
                        <option value="none">none</option>
                        {owners.filter((o) => poEnvIds(o).includes(env.id)).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                    </Select>
                </label>
            )}
            <label>Extra instructions for the agents (optional; every stage sees them) <AgentInput value={notes} onChange={setNotes} placeholder="Constraints, where the code lives, what to skip, how to test…" style={{ minHeight: 60 }} /></label>
            {repoKeys.map((repo) => (
                <label key={repo}>Base branch{repo ? ` · ${repo}` : ""}
                    <BranchPicker envId={env.id} repo={repo} value={bases[repo] ?? ""} onChange={(v) => setBases((b) => ({ ...b, [repo]: v }))} placeholder={env.base_branch} />
                </label>
            ))}
            <span className="field-hint">The branch the work starts from and the PR targets — default {env.base_branch}. For a stacked PR, another task's branch{repoKeys.length > 1 ? " (per repository: a parent that touched only one repo leaves the other on the default)" : ""}; when that branch's PR merges, the task is rebased onto the new base automatically.</span>
            <label>AI account
                <Select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    {accounts.length === 0 && <option value="">— no account can run in this environment's config dir —</option>}
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ""}</option>)}
                </Select>
            </label>
            <label>Claude model
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                    {(settings?.models ?? [{ value: "", label: "Account default" }]).map((m) => (
                        <option key={m.value} value={m.value}>
                            {m.value === "" ? `Account default${(() => { const d = modelLabel(accounts.find((a) => a.id === acc)?.default_model, settings?.models); return d ? ` · ${d}` : " · not resolved yet (refresh the account)"; })()}` : m.label}
                        </option>
                    ))}
                </Select>
                <span className="field-hint">Applies to Design, Implementation and PR fixes; Research, QA and the PR draft run on Sonnet.</span>
            </label>
            <Button variant="primary" disabled={list.length === 0 || bad.length> 0 || accounts.length === 0} onClick={() => onSubmit({ tickets: list, mode, ...(acc ? { accountId: acc } : {}), ...(model ? { model } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(baseBranch ? { baseBranch } : {}), ...(owner ? { productOwnerId: owner === "none" ? null : owner } : {}) })}>
                {list.length > 1 ? (mode === "each" ? `Start ${list.length} tasks` : `Start 1 task for ${list.length} tickets`) : "Start task"}
            </Button>
        </>
    );
};

const splitRepos = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

const EnvForm = ({
    accounts,
    configDirs,
    onSubmit,
}: {
    accounts: Account[];
    configDirs: ConfigDir[];
    onSubmit: (b: Parameters<typeof api.addEnv>[0]) => Promise<void>;
}) => {
    const [name, setName] = useState("");
    const [path, setPath] = useState("");
    const [base, setBase] = useState("main");
    const [acc, setAcc] = useState("");
    const [dirId, setDirId] = useState("");
    const [appUrl, setAppUrl] = useState("");
    const [repos, setRepos] = useState("");
    const [ticketSource, setTicketSource] = useState<"clickup" | "linear">("clickup");
    const repoList = splitRepos(repos);
    return (
        <>
            <label>Name <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Path <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/code/repo — or a workspace folder holding several repos" /></label>
            <label>Sub-repositories (comma-separated; empty = the path itself is the git repo) <Input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="backend, frontend" /></label>
            <label>Base branch <Input value={base} onChange={(e) => setBase(e.target.value)} /></label>
            <label>Task system (how bare ids like ABC-123 are resolved)
                <Select value={ticketSource} onChange={(e) => setTicketSource(e.target.value as "clickup" | "linear")}>
                    <option value="clickup">ClickUp</option><option value="linear">Linear</option>
                </Select>
            </label>
            <label>App URL for QA <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://localhost:3000" /></label>
            <label>Claude config dir
                <Select value={dirId} onChange={(e) => setDirId(e.target.value)}>
                    <option value="">— auto: {"<path>"}/.claude if registered, else the first dir —</option>
                    {configDirs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.path}</option>)}
                </Select>
            </label>
            <label>First AI account (the environment page lets you list more, in priority order)
                <Select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    <option value="">— any account that can run in the dir —</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
            </label>
            <Button variant="primary"
 
 disabled={!name || !path}
 onClick={() =>
 onSubmit({
 name,
 path,
 baseBranch: base,
 ticketSource,
 ...(acc ? { defaultAccountId: acc } : {}),
 ...(dirId ? { configDirId: dirId } : {}),
 ...(appUrl ? { appUrl } : {}),
 ...(repoList.length ? { repos: repoList } : {}),
 })
 }
>
                Add
            </Button>
        </>
    );
};

const AccountForm = ({ onSubmit }: { onSubmit: (name: string, email?: string) => Promise<void> }) => {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    return (
        <>
            <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13 }}>Opens a terminal running <code>claude setup-token</code>: finish the claude.ai login in the browser (pick the right account there — the email below is only a label), paste the code back if asked. Stagehand stores the resulting long-lived token and closes the terminal; the account then works in any config dir.</p>
            <label>Name <Input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="work" /></label>
            <label>Email (label) <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
            <Button variant="primary" disabled={!/^[a-z0-9-]+$/.test(name)} onClick={() => onSubmit(name, email || undefined)}>Set up token</Button>
        </>
    );
};

export { STAGE_ORDER };
