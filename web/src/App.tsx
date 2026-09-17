import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LabelChips } from "./Labels";
import { accountOrderOf, accountUsableWith, api, labelsOf, modelLabel, STAGE_LABEL, STAGE_ORDER, taskLabel, type Account, type ConfigDir, type Env, type MyTicket, type Readiness, type Settings, type Task, type TaskDetail } from "./api";
import { TASK_TABS, TaskDetailView, type Tab as TaskTab } from "./TaskDetail";
import { EnvPage } from "./EnvPage";
import { ConfigDirPage } from "./ConfigDirPage";
import { ManagePage, type ManageTab } from "./ManagePage";
import { Dashboard, needsAttention } from "./Dashboard";
import { Analytics } from "./Analytics";
import { SessionsPage } from "./SessionsPage";
import { storage } from "./storage";
import { ErrorBoundary } from "./ErrorBoundary";
import { LazyTerminal } from "./LazyTerminal";

type Page = "dashboard" | "tasks" | "sessions" | "analytics" | "env" | "dir" | ManageTab;
const NAV: { id: Page; label: string; hint: string }[] = [
    { id: "dashboard", label: "Dashboard", hint: "Tasks needing your attention, per environment" },
    { id: "tasks", label: "Tasks", hint: "Tasks in the selected environment" },
    { id: "sessions", label: "Sessions", hint: "Free-form claude sessions in an environment, with the account and worktree of your choice" },
    { id: "analytics", label: "Analytics", hint: "Token and cost usage by environment, task, account" },
    { id: "envs", label: "Environments", hint: "Repositories, services, which config dir and account they use" },
    { id: "dirs", label: "Config dirs", hint: "Claude config dirs: skills, hooks, rules, Chrome" },
    { id: "accounts", label: "AI accounts", hint: "Provider logins (tokens), usage, failover" },
    { id: "managers", label: "Task managers", hint: "ClickUp / Linear credentials" },
];

// Where the user is, as a URL hash: #/dashboard, #/tasks, #/tasks/<taskId>/<tab>, #/sessions, #/analytics, #/envs,
// #/env/<envId>, #/dirs, #/dir/<dirId>, #/accounts, #/managers. Reloads and back/forward restore it.
interface Route {
    page: Page;
    selected: string | null;
    taskTab: TaskTab;
    envId: string | null;
    dirId: string | null;
}
const PAGES: readonly Page[] = ["dashboard", "tasks", "sessions", "analytics", "envs", "dirs", "accounts", "managers"];
const parseHash = (hash: string): Route => {
    const [head = "", a = "", b = ""] = hash.replace(/^#\/?/, "").split("/");
    const r: Route = { page: "dashboard", selected: null, taskTab: "work", envId: null, dirId: null };
    if (head === "tasks") {
        r.page = "tasks";
        if (a) r.selected = decodeURIComponent(a);
        if (b && (TASK_TABS as readonly string[]).includes(b)) r.taskTab = b as TaskTab;
    } else if (head === "env" && a) {
        r.page = "env";
        r.envId = decodeURIComponent(a);
    } else if (head === "dir" && a) {
        r.page = "dir";
        r.dirId = decodeURIComponent(a);
    } else if ((PAGES as readonly string[]).includes(head)) r.page = head as Page;
    return r;
};
const buildHash = (page: Page, selected: string | null, taskTab: TaskTab, envId: string, dirId: string | null): string => {
    if (page === "tasks") return selected ? `#/tasks/${encodeURIComponent(selected)}/${taskTab}` : "#/tasks";
    if (page === "env") return `#/env/${encodeURIComponent(envId)}`;
    if (page === "dir" && dirId) return `#/dir/${encodeURIComponent(dirId)}`;
    return `#/${page}`;
};

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
                {a.name}{!a.logged_in && <span className="chip bad">no auth</span>}{a.logged_in === 1 && !a.has_token && <span className="chip warn">legacy</span>}
                {!enterprise && a.logged_in === 1 && <button className="refresh" disabled={a.refreshing_limits} onClick={onRefresh} title="Refresh the windows now (one tiny Sonnet turn)">{a.refreshing_limits ? "…" : "↻"}</button>}
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
    const [initial] = useState(() => parseHash(location.hash));
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [configDirs, setConfigDirs] = useState<ConfigDir[]>([]);
    const [dirId, setDirId] = useState<string | null>(initial.dirId);
    const [envs, setEnvs] = useState<Env[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [envId, setEnvId] = useState<string>(() => initial.envId ?? storage.get("stagehand.env") ?? "");
    const [selected, setSelectedRaw] = useState<string | null>(initial.selected);
    const [taskTab, setTaskTab] = useState<TaskTab>(initial.taskTab);
    // Opening a different task starts on its Work tab; a hash-driven change keeps the tab it names.
    const setSelected = useCallback((id: string | null) => {
        setSelectedRaw(id);
        setTaskTab("work");
    }, []);
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [feed, setFeed] = useState<Record<string, string[]>>({});
    const [modal, setModal] = useState<"task" | "env" | "account" | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);
    const [readiness, setReadiness] = useState<Readiness[]>([]);
    useEffect(() => {
        void api.settings().then(setSettings).catch(() => undefined);
    }, [modal]);
    const [terminal, setTerminal] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [moreOpen, setMoreOpen] = useState(false);
    const [page, setPage] = useState<Page>(initial.page);
    const navActive: Page = page === "env" ? "envs" : page === "dir" ? "dirs" : page;

    // State → hash (so a reload lands here) and hash → state (back/forward, pasted links).
    useEffect(() => {
        const h = buildHash(page, selected, taskTab, envId, dirId);
        if (location.hash !== h) history.pushState(null, "", h);
    }, [page, selected, taskTab, envId, dirId]);
    useEffect(() => {
        const apply = () => {
            const r = parseHash(location.hash);
            setPage(r.page);
            setSelectedRaw(r.selected);
            setTaskTab(r.taskTab);
            if (r.envId) setEnvId(r.envId);
            if (r.dirId) setDirId(r.dirId);
        };
        window.addEventListener("popstate", apply);
        window.addEventListener("hashchange", apply);
        return () => {
            window.removeEventListener("popstate", apply);
            window.removeEventListener("hashchange", apply);
        };
    }, []);

    const reload = useCallback(async () => {
        const [a, e, t, d, s, r] = await Promise.all([api.accounts(), api.envs(), api.tasks(), api.configDirs(), api.settings().catch(() => null), api.readiness().catch(() => [] as Readiness[])]);
        setAccounts(a);
        setEnvs(e);
        setTasks(t);
        setConfigDirs(d);
        setReadiness(r);
        if (s) setSettings(s);
        if (!envId && e[0]) setEnvId(e[0].id);
    }, [envId]);

    const loadDetail = useCallback(async (id: string) => setDetail(await api.task(id)), []);

    // A task from another env must not stay open after switching env — but a task named by the URL wins over the remembered env.
    useEffect(() => {
        if (!selected || !tasks.length) return;
        const t = tasks.find((x) => x.id === selected);
        if (!t) setSelected(null);
        else if (t.env_id !== envId) setEnvId(t.env_id);
    }, [selected, tasks, envId, setSelected]);
    useEffect(() => {
        if (page !== "tasks") void reload();
    }, [page, reload]);

    useEffect(() => {
        void reload();
    }, [reload]);

    useEffect(() => {
        storage.set("stagehand.env", envId);
    }, [envId]);

    useEffect(() => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/ws/events`);
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data as string) as { kind: string; payload: unknown };
            if (msg.kind === "task") {
                const t = msg.payload as Task | null;
                if (!t) return;
                setTasks((prev) => (prev.some((p) => p.id === t.id) ? prev.map((p) => (p.id === t.id ? t : p)) : [t, ...prev]));
                if (t.id === selected) void loadDetail(t.id);
            }
            if (msg.kind === "activity") {
                const a = msg.payload as { taskId: string; event: { kind: string; summary: string } };
                setFeed((f) => ({ ...f, [a.taskId]: [...(f[a.taskId] ?? []).slice(-199), `${a.event.kind}: ${a.event.summary}`] }));
            }
            if (msg.kind === "message") {
                const m = msg.payload as { task_id: string };
                if (m.task_id === selected) void loadDetail(m.task_id);
            }
            if (msg.kind === "rate_limit" || msg.kind === "account") void Promise.all([api.accounts(), api.configDirs()]).then(([a, d]) => { setAccounts(a); setConfigDirs(d); });
        };
        return () => ws.close();
    }, [selected, loadDetail]);

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
    const dir = dirId ? configDirs.find((d) => d.id === dirId) : undefined;

    return (
        <div className="app">
            <header className={`topbar ${moreOpen ? "more-open" : ""}`}>
                <span className="brand">Stagehand</span>
                <span className="spacer" />
                <button className="more" onClick={() => setMoreOpen((v) => !v)} title="Account usage">⋯</button>
                <span className="extra gauges">{accounts.map((a) => <Gauge key={a.id} a={a} onRefresh={() => void api.refreshLimits(a.id).then((r) => { if (!r.ok) setError(`limits refresh (${a.name}): ${r.detail}`); }).then(reload).catch((e: Error) => setError(e.message))} />)}</span>
            </header>
            <div className="body">
                <nav className="sidebar" aria-label="Sections">
                    {NAV.map((n) => (
                        <button key={n.id} className={navActive === n.id ? "active" : ""} title={n.hint} onClick={() => setPage(n.id)}>
                            {n.label}
                            {n.id === "dashboard" && attention > 0 && <span className="count alert">{attention}</span>}
                            {n.id === "tasks" && visible.length > 0 && <span className="count">{visible.length}</span>}
                            {n.id === "envs" && envs.length > 0 && <span className="count">{envs.length}</span>}
                            {n.id === "accounts" && accounts.length > 0 && <span className="count">{accounts.length}</span>}
                        </button>
                    ))}
                </nav>
                {page === "dashboard" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ErrorBoundary label="Dashboard"><Dashboard envs={envs} tasks={tasks} readiness={readiness} onOpen={(t) => { setEnvId(t.env_id); setSelected(t.id); setPage("tasks"); }} /></ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "analytics" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ErrorBoundary label="Analytics"><Analytics onError={setError} /></ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "sessions" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ErrorBoundary label="Sessions"><SessionsPage envs={envs} accounts={accounts} configDirs={configDirs} settings={settings} onError={setError} /></ErrorBoundary>
                        </main>
                    </div>
                )}
                {page === "env" && env && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <EnvPage key={env.id} env={env} envs={envs} accounts={accounts} configDirs={configDirs} onBack={() => setPage("envs")} onOpenDir={(id) => { setDirId(id); setPage("dir"); }} onChanged={reload} onError={setError} />
                        </main>
                    </div>
                )}
                {page === "dir" && dir && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ConfigDirPage key={dir.id} dir={dir} onBack={() => setPage("dirs")} onChanged={reload} onError={setError} />
                        </main>
                    </div>
                )}
                {(page === "envs" || page === "dirs" || page === "accounts" || page === "managers") && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <ManagePage
                                tab={page}
                                envs={envs}
                                configDirs={configDirs}
                                accounts={accounts}
                                tasks={tasks}
                                settings={settings}
                                onConfigureEnv={(id) => { setEnvId(id); setPage("env"); }}
                                onOpenDir={(id) => { setDirId(id); setPage("dir"); }}
                                onAddEnv={() => setModal("env")}
                                onAddAccount={() => setModal("account")}
                                onChanged={reload}
                                onError={setError}
                                onTerminal={setTerminal}
                            />
                        </main>
                    </div>
                )}
                {page === "tasks" && <div className={`main ${selected ? "has-selection" : ""}`}>
                    <aside className="list">
                        <div className="list-head">
                            <select value={envId} onChange={(e) => { setSelected(null); setEnvId(e.target.value); }} title="Environment">
                                {envs.map((e) => (
                                    <option key={e.id} value={e.id}>{e.name} ({e.base_branch})</option>
                                ))}
                            </select>
                            <button className="new-task" disabled={!env} onClick={() => setModal("task")}>
                                <span className="icon">+</span>
                                <span className="name">New task</span>
                            </button>
                        </div>
                        {visible.length === 0 && <div className="empty">No tasks in this env yet.</div>}
                        {grouped.map(([g, list]) => (
                            <div key={g}>
                                <div className="group">{g}</div>
                                {list.map((t) => {
                                    const [glyph, cls] = ICON[g];
                                    return (
                                        <div key={t.id} className={`row ${selected === t.id ? "selected" : ""}`} onClick={() => setSelected(t.id)}>
                                            <span className={`icon ${cls}`}>{glyph}</span>
                                            <span className="name">{taskLabel(t)}<small>{t.title ?? ""}</small></span>
                                            <span className="age">{age(t.updated_at)}</span>
                                            <span className="pr" />
                                            <span className="status"><LabelChips labels={labelsOf(t)} /><span className="status-text">{t.status_line ?? STAGE_LABEL[t.stage]}</span></span>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </aside>
                    <main className="detail">
                        {selected && <button className="back" onClick={() => setSelected(null)}>← tasks</button>}
                        {error && <div className="blocked-box">{error}</div>}
                        {!detail && <div className="empty">Select a task, or add one.</div>}
                        {detail && (
                            <ErrorBoundary key={detail.task.id} label="Task view">
                            <TaskDetailView
                                detail={detail}
                                accounts={accountsFor(envs.find((e) => e.id === detail.task.env_id), accounts, configDirs)}
                                env={envs.find((e) => e.id === detail.task.env_id)}
                                onError={setError}
                                feed={feed[detail.task.id] ?? []}
                                terminal={terminal}
                                onAction={run}
                                tab={taskTab}
                                setTab={setTaskTab}
                                onOpenTerminal={async () => {
                                    const r = await api.terminal(detail.task.id);
                                    setTerminal(r.terminal);
                                }}
                                onCloseTerminal={() => setTerminal(null)}
                            />
                            </ErrorBoundary>
                        )}
                    </main>
                </div>}
            </div>
            {modal === "task" && env && (
                <Modal title={`New task in ${env.name}`} onClose={() => setModal(null)}>
                    <TaskForm accounts={accountsFor(env, accounts, configDirs)} env={env} settings={settings} readiness={readiness.find((r) => r.envId === env.id)} onSubmit={async (body) => { await run(() => api.createTasks({ envId: env.id, ...body })); setModal(null); }} />
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
        </div>
    );
};

const Modal = ({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) => {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="modal" onClick={onClose}>
            <div className="box" style={wide ? { minWidth: "min(900px, 100vw - 24px)" } : undefined} onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>{title}</h2>
                    <button className="close" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
                </div>
                {children}
            </div>
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
            <button type="button" className="ticket-dropdown-toggle" onClick={() => setOpen((v) => !v)}>
                {picked.length ? `${picked.length} picked` : "Pick from my tickets"} <span className="caret">{open ? "▴" : "▾"}</span>
            </button>
            {picked.length > 0 && (
                <span className="ticket-chips">
                    {picked.map((t) => <span key={t.id} className="chip accent" title={t.title}>{t.id} <button type="button" className="chip-x" onClick={() => onToggle(t.id)} aria-label={`remove ${t.id}`}>×</button></span>)}
                </span>
            )}
            {open && (
                <div className="ticket-menu">
                    <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by id or title…" />
                    <div className="ticket-menu-list">
                        {groups.map(([g, tl]) => {
                            const shown = tl.filter(match);
                            if (shown.length === 0) return null;
                            return (
                                <div key={g}>
                                    <div className="group">{g}</div>
                                    {shown.map((t) => (
                                        <label key={t.id} className={`inline ticket-option ${selected.includes(t.id) ? "picked" : ""}`}>
                                            <input type="checkbox" checked={selected.includes(t.id)} onChange={() => onToggle(t.id)} />
                                            <span>{PRIORITY_MARK[t.priority ?? 0] ?? "·"} <b>{t.id}</b> {t.title.length > 70 ? `${t.title.slice(0, 70)}…` : t.title} <span className="chip">{t.status}</span></span>
                                        </label>
                                    ))}
                                </div>
                            );
                        })}
                        {all.filter(match).length === 0 && <div className="quiet">nothing matches</div>}
                    </div>
                    <div className="actions" style={{ margin: "6px 0 0" }}><button type="button" className="primary" onClick={() => setOpen(false)}>Done{picked.length ? ` (${picked.length})` : ""}</button></div>
                </div>
            )}
        </div>
    );
};

const TaskForm = ({ accounts, env, settings, readiness, onSubmit }: {
    accounts: Account[]; env: Env; settings: Settings | null; readiness: Readiness | undefined;
    onSubmit: (body: { tickets: string[]; mode: "each" | "batch"; accountId?: string; model?: string; notes?: string; baseBranch?: string }) => Promise<void>;
}) => {
    const [ticket, setTicket] = useState("");
    const [mode, setMode] = useState<"each" | "batch">("each");
    const [notes, setNotes] = useState("");
    const [base, setBase] = useState("");
    const [acc, setAcc] = useState(accountOrderOf(env).find((id) => accounts.some((a) => a.id === id)) ?? accounts[0]?.id ?? "");
    const [model, setModel] = useState(settings?.defaultModel ?? "");
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
                    {mine === null ? <span className="chip">loading…</span> : mine.error ? <span className="chip bad" title={mine.error}>unavailable</span> : <span className="chip">{mine.tickets.length}{env.ticket_source === "clickup" ? " in current sprint" : " assigned"}</span>}
                </span>
                {mine && mine.tickets.length > 0 && <TicketPicker groups={groups} selected={list} onToggle={toggle} />}
                {mine?.error && <span className="hint-line">{mine.error}</span>}
            </div>
            <label>Ticket ids or links (one per line for several) <textarea autoFocus value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder={"PRODUCT-8704\nhttps://app.clickup.com/t/…\nhttps://linear.app/…/issue/…"} style={{ minHeight: 60 }} /></label>
            {list.length > 0 && <span className={`chip ${bad.length ? "bad" : "accent"}`}>{bad.length ? `unrecognised: ${bad.join(", ")}` : `${list.length} ticket${list.length === 1 ? "" : "s"}`}</span>}
            {list.length > 1 && (
                <label>Dispatch
                    <select value={mode} onChange={(e) => setMode(e.target.value as "each" | "batch")}>
                        <option value="each">One task per ticket — each gets its own branch and PR ({list.length} tasks)</option>
                        <option value="batch">One task for all — one branch, one PR per repository</option>
                    </select>
                </label>
            )}
            <label>Extra instructions for the agents (optional; every stage sees them) <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Constraints, where the code lives, what to skip, how to test…" style={{ minHeight: 60 }} /></label>
            <label>Base branch
                <input value={base} onChange={(e) => setBase(e.target.value)} placeholder={env.base_branch} />
                <span className="field-hint">The branch the work starts from and the PR targets — default {env.base_branch}. For a stacked PR, another task's branch; when that branch's PR merges and GitHub retargets this PR, the task follows.</span>
            </label>
            <label>AI account
                <select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    {accounts.length === 0 && <option value="">— no account can run in this environment's config dir —</option>}
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ""}</option>)}
                </select>
            </label>
            <label>Claude model
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                    {(settings?.models ?? [{ value: "", label: "Account default" }]).map((m) => (
                        <option key={m.value} value={m.value}>
                            {m.value === "" ? `Account default${(() => { const d = modelLabel(accounts.find((a) => a.id === acc)?.default_model, settings?.models); return d ? ` · ${d}` : " · not resolved yet (refresh the account)"; })()}` : m.label}
                        </option>
                    ))}
                </select>
                <span className="field-hint">Applies to Design, Implementation and PR fixes; Research, QA and the PR draft run on Sonnet.</span>
            </label>
            <button className="primary" disabled={list.length === 0 || bad.length > 0 || accounts.length === 0} onClick={() => onSubmit({ tickets: list, mode, ...(acc ? { accountId: acc } : {}), ...(model ? { model } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(base.trim() && base.trim() !== env.base_branch ? { baseBranch: base.trim() } : {}) })}>
                {list.length > 1 ? (mode === "each" ? `Start ${list.length} tasks` : `Start 1 task for ${list.length} tickets`) : "Start task"}
            </button>
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
    const [qaScript, setQaScript] = useState("");
    const [repos, setRepos] = useState("");
    const [branchPrefix, setBranchPrefix] = useState("");
    const [ticketSource, setTicketSource] = useState<"clickup" | "linear">("clickup");
    const repoList = splitRepos(repos);
    return (
        <>
            <label>Name <input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Path <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/code/repo — or a workspace folder holding several repos" /></label>
            <label>Sub-repositories (comma-separated; empty = the path itself is the git repo) <input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="backend, frontend" /></label>
            <label>Base branch <input value={base} onChange={(e) => setBase(e.target.value)} /></label>
            <label>Branch prefix <input value={branchPrefix} onChange={(e) => setBranchPrefix(e.target.value)} placeholder="e.g. yourname/ — prepended to the branch research proposes" /></label>
            <label>Task system (how bare ids like ABC-123 are resolved)
                <select value={ticketSource} onChange={(e) => setTicketSource(e.target.value as "clickup" | "linear")}>
                    <option value="clickup">ClickUp</option><option value="linear">Linear</option>
                </select>
            </label>
            <label>App URL for QA <input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://localhost:3000" /></label>
            <label>QA bring-up command <input value={qaScript} onChange={(e) => setQaScript(e.target.value)} placeholder="optional, run from the worktree before QA" /></label>
            <label>Claude config dir
                <select value={dirId} onChange={(e) => setDirId(e.target.value)}>
                    <option value="">— auto: {"<path>"}/.claude if registered, else the first dir —</option>
                    {configDirs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.path}</option>)}
                </select>
            </label>
            <label>First AI account (the environment page lets you list more, in priority order)
                <select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    <option value="">— any account that can run in the dir —</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
            </label>
            <button
                className="primary"
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
                        ...(qaScript ? { qaScript } : {}),
                        ...(repoList.length ? { repos: repoList } : {}),
                        ...(branchPrefix.trim() ? { branchPrefix: branchPrefix.trim() } : {}),
                    })
                }
            >
                Add
            </button>
        </>
    );
};

const AccountForm = ({ onSubmit }: { onSubmit: (name: string, email?: string) => Promise<void> }) => {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    return (
        <>
            <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13 }}>Opens a terminal running <code>claude setup-token</code>: finish the claude.ai login in the browser (pick the right account there — the email below is only a label), paste the code back if asked. Stagehand stores the resulting long-lived token and closes the terminal; the account then works in any config dir.</p>
            <label>Name <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="work" /></label>
            <label>Email (label) <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
            <button className="primary" disabled={!/^[a-z0-9-]+$/.test(name)} onClick={() => onSubmit(name, email || undefined)}>Set up token</button>
        </>
    );
};

export { STAGE_ORDER };
