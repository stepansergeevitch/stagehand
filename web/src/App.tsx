import { useCallback, useEffect, useMemo, useState } from "react";
import { accountOrderOf, accountUsableWith, api, modelLabel, STAGE_LABEL, STAGE_ORDER, type Account, type ConfigDir, type Env, type MyTicket, type Settings, type Task, type TaskDetail } from "./api";
import { TaskDetailView } from "./TaskDetail";
import { EnvPage } from "./EnvPage";
import { ConfigDirPage } from "./ConfigDirPage";
import { ManagePage, type ManageTab } from "./ManagePage";
import { Dashboard, needsAttention } from "./Dashboard";
import { Analytics } from "./Analytics";

type Page = "dashboard" | "tasks" | "analytics" | "env" | "dir" | ManageTab;
const NAV: { id: Page; label: string; hint: string }[] = [
    { id: "dashboard", label: "Dashboard", hint: "Tasks needing your attention, per environment" },
    { id: "tasks", label: "Tasks", hint: "Tasks in the selected environment" },
    { id: "analytics", label: "Analytics", hint: "Token and cost usage by environment, task, account" },
    { id: "envs", label: "Environments", hint: "Repositories, services, which config dir and account they use" },
    { id: "dirs", label: "Config dirs", hint: "Claude config dirs: skills, hooks, rules, Chrome" },
    { id: "accounts", label: "AI accounts", hint: "Provider logins (tokens), usage, failover" },
    { id: "managers", label: "Task managers", hint: "ClickUp / Linear credentials" },
];

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
const Gauge = ({ a }: { a: Account }) => {
    const five = a.limits.find((l) => l.window === "five_hour");
    const week = a.limits.find((l) => l.window === "seven_day");
    const cls = (u: number) => (u >= 0.9 ? "bad" : u >= 0.6 ? "warn" : "");
    const enterprise = a.plan === "enterprise";
    const usage = a.usage ?? { today: { tokens: 0, cost: 0 }, week: { tokens: 0, cost: 0 } };
    const title = `${a.email ?? "no auth"} · ${a.org ?? ""} · ${a.plan ?? ""}${five ? ` · 5h window ${Math.round(five.utilization * 100)}%` : ""}${week ? ` · 7d window ${Math.round(week.utilization * 100)}%` : ""}${enterprise ? " · counts what Stagehand ran on this account (tasks, helpers, probes); usage elsewhere needs the Admin API" : ""}`;
    return (
        <span className={`gauge ${enterprise ? "enterprise" : ""}`} title={title}>
            <span className="gauge-name">{a.name}{!a.logged_in && <span className="chip bad">no auth</span>}{a.logged_in === 1 && !a.has_token && <span className="chip warn">legacy</span>}</span>
            {enterprise ? (
                <span className="gauge-usage">
                    <span><small>today</small> {fmtTokens(usage.today.tokens)} · {fmtMoney(usage.today.cost)}</span>
                    <span><small>week</small> {fmtTokens(usage.week.tokens)} · {fmtMoney(usage.week.cost)}</span>
                </span>
            ) : (
                <span className="gauge-bars">
                    <span className="gauge-row"><small>d</small><span className="bar"><i className={cls(five?.utilization ?? 0)} style={{ width: `${Math.round((five?.utilization ?? 0) * 100)}%` }} /></span><span>{five ? `${Math.round(five.utilization * 100)}%` : "—"}</span></span>
                    <span className="gauge-row"><small>w</small><span className="bar"><i className={cls(week?.utilization ?? 0)} style={{ width: `${Math.round((week?.utilization ?? 0) * 100)}%` }} /></span><span>{week ? `${Math.round(week.utilization * 100)}%` : "—"}</span></span>
                </span>
            )}
        </span>
    );
};

export const App = () => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [configDirs, setConfigDirs] = useState<ConfigDir[]>([]);
    const [dirId, setDirId] = useState<string | null>(null);
    const [envs, setEnvs] = useState<Env[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [envId, setEnvId] = useState<string>(() => localStorage.getItem("stagehand.env") ?? "");
    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [feed, setFeed] = useState<Record<string, string[]>>({});
    const [modal, setModal] = useState<"task" | "env" | "account" | "settings" | null>(null);
    const [settings, setSettings] = useState<Settings | null>(null);
    useEffect(() => {
        void api.settings().then(setSettings).catch(() => undefined);
    }, [modal]);
    const [terminal, setTerminal] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [moreOpen, setMoreOpen] = useState(false);
    const [page, setPage] = useState<Page>("dashboard");
    const navActive: Page = page === "env" ? "envs" : page === "dir" ? "dirs" : page;

    const reload = useCallback(async () => {
        const [a, e, t, d] = await Promise.all([api.accounts(), api.envs(), api.tasks(), api.configDirs()]);
        setAccounts(a);
        setEnvs(e);
        setTasks(t);
        setConfigDirs(d);
        if (!envId && e[0]) setEnvId(e[0].id);
    }, [envId]);

    const loadDetail = useCallback(async (id: string) => setDetail(await api.task(id)), []);

    // A task from another env must not stay open after switching env; the config pages re-fetch accounts/envs on entry.
    useEffect(() => {
        if (selected && tasks.length && tasks.find((t) => t.id === selected)?.env_id !== envId) setSelected(null);
    }, [envId, selected, tasks]);
    useEffect(() => {
        if (page !== "tasks") void reload();
    }, [page, reload]);

    useEffect(() => {
        void reload();
    }, [reload]);

    useEffect(() => {
        localStorage.setItem("stagehand.env", envId);
    }, [envId]);

    useEffect(() => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/ws/events`);
        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data as string) as { kind: string; payload: unknown };
            if (msg.kind === "task") {
                const t = msg.payload as Task;
                setTasks((prev) => (prev.some((p) => p.id === t.id) ? prev.map((p) => (p.id === t.id ? t : p)) : [t, ...prev]));
                if (t.id === selected) void loadDetail(t.id);
            }
            if (msg.kind === "activity") {
                const a = msg.payload as { taskId: string; event: { kind: string; summary: string } };
                setFeed((f) => ({ ...f, [a.taskId]: [...(f[a.taskId] ?? []).slice(-199), `${a.event.kind}: ${a.event.summary}`] }));
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
                <button className="more" onClick={() => setMoreOpen((v) => !v)} title="Accounts and settings">⋯</button>
                <span className="extra gauges">{accounts.map((a) => <Gauge key={a.id} a={a} />)}</span>
                <span className="extra">
                    <button onClick={() => setModal("settings")} title="Default model">⚙</button>
                </span>
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
                            <Dashboard envs={envs} tasks={tasks} onOpen={(t) => { setEnvId(t.env_id); setSelected(t.id); setPage("tasks"); }} />
                        </main>
                    </div>
                )}
                {page === "analytics" && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <Analytics onError={setError} />
                        </main>
                    </div>
                )}
                {page === "env" && env && (
                    <div className="main page">
                        <main className="detail">
                            {error && <div className="blocked-box">{error}</div>}
                            <EnvPage key={env.id} env={env} accounts={accounts} configDirs={configDirs} onBack={() => setPage("envs")} onOpenDir={(id) => { setDirId(id); setPage("dir"); }} onChanged={reload} onError={setError} />
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
                            <select value={envId} onChange={(e) => setEnvId(e.target.value)} title="Environment">
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
                                            <span className="name">{t.ticket_id}<small>{t.title ?? ""}</small></span>
                                            <span className="age">{age(t.updated_at)}</span>
                                            <span className="pr" />
                                            <span className="status">{t.status_line ?? STAGE_LABEL[t.stage]}</span>
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
                            <TaskDetailView
                                detail={detail}
                                accounts={accountsFor(envs.find((e) => e.id === detail.task.env_id), accounts, configDirs)}
                                env={envs.find((e) => e.id === detail.task.env_id)}
                                onError={setError}
                                feed={feed[detail.task.id] ?? []}
                                terminal={terminal}
                                onAction={run}
                                onOpenTerminal={async () => {
                                    const r = await api.terminal(detail.task.id);
                                    setTerminal(r.terminal);
                                }}
                                onCloseTerminal={() => setTerminal(null)}
                            />
                        )}
                    </main>
                </div>}
            </div>
            {modal === "task" && env && (
                <Modal title={`New task in ${env.name}`} onClose={() => setModal(null)}>
                    <TaskForm accounts={accountsFor(env, accounts, configDirs)} env={env} settings={settings} onSubmit={async (ticket, acc, model) => { await run(() => api.createTask(env.id, ticket, acc, model)); setModal(null); }} />
                </Modal>
            )}
            {modal === "env" && (
                <Modal title="Add environment" onClose={() => setModal(null)}>
                    <EnvForm accounts={accounts} configDirs={configDirs} onSubmit={async (b) => { await run(() => api.addEnv(b)); setModal(null); }} />
                </Modal>
            )}
            {modal === "settings" && settings && (
                <Modal title="Settings" onClose={() => setModal(null)}>
                    <SettingsForm settings={settings} accounts={accounts} onSubmit={async (b) => { await run(() => api.patchSettings(b)); setModal(null); }} />
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

const TaskForm = ({ accounts, env, settings, onSubmit }: { accounts: Account[]; env: Env; settings: Settings | null; onSubmit: (ticket: string, accountId?: string, model?: string) => Promise<void> }) => {
    const [ticket, setTicket] = useState("");
    const [acc, setAcc] = useState(accountOrderOf(env).find((id) => accounts.some((a) => a.id === id)) ?? accounts[0]?.id ?? "");
    const [model, setModel] = useState(settings?.defaultModel ?? "");
    const [mine, setMine] = useState<{ tickets: MyTicket[]; error?: string } | null>(null);
    useEffect(() => {
        setMine(null);
        void api.myTickets(env.id).then(setMine).catch((e: Error) => setMine({ tickets: [], error: e.message }));
    }, [env.id]);
    const groups = useMemo(() => {
        const m = new Map<string, MyTicket[]>();
        for (const t of mine?.tickets ?? []) m.set(t.group, [...(m.get(t.group) ?? []), t]);
        return [...m.entries()];
    }, [mine]);
    const parsed = (() => {
        const s = ticket.trim();
        if (/app\.clickup\.com\/t\//.test(s)) return "ClickUp link";
        if (/linear\.app\/.+\/issue\//.test(s)) return "Linear link";
        if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s)) return `${env.ticket_source} id`;
        return s ? "unrecognised" : "";
    })();
    return (
        <>
            <label>
                My tickets{" "}
                {mine === null ? <span className="chip">loading…</span> : mine.error ? <span className="chip bad" title={mine.error}>unavailable</span> : <span className="chip">{mine.tickets.length}{env.ticket_source === "clickup" ? " in current sprint" : " assigned"}</span>}
                <select value={mine?.tickets.some((t) => t.id === ticket) ? ticket : ""} onChange={(e) => setTicket(e.target.value)} disabled={!mine || mine.tickets.length === 0}>
                    <option value="">— pick one (sorted by priority) —</option>
                    {groups.map(([g, list]) => (
                        <optgroup key={g} label={g}>
                            {list.map((t) => (
                                <option key={t.id} value={t.id}>{PRIORITY_MARK[t.priority ?? 0] ?? "·"} {t.id} · {t.title.length > 70 ? `${t.title.slice(0, 70)}…` : t.title} [{t.status}]</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
                {mine?.error && <span className="hint-line">{mine.error}</span>}
            </label>
            <label>Ticket id or link <input autoFocus value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="PRODUCT-8704 · https://app.clickup.com/t/… · https://linear.app/…/issue/…" /></label>
            {parsed && <span className={`chip ${parsed === "unrecognised" ? "bad" : "accent"}`}>{parsed}</span>}
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
            <button className="primary" disabled={!ticket.trim() || parsed === "unrecognised" || accounts.length === 0} onClick={() => onSubmit(ticket.trim(), acc || undefined, model || undefined)}>Start task</button>
        </>
    );
};

const SettingsForm = ({ settings, accounts, onSubmit }: { settings: Settings; accounts: Account[]; onSubmit: (b: Partial<Omit<Settings, "models">>) => Promise<void> }) => {
    const [clickupToken, setClickupToken] = useState("");
    const [clickupTeamId, setClickupTeamId] = useState(settings.clickupTeamId ?? "");
    const [linearApiKey, setLinearApiKey] = useState("");
    const [adminKey, setAdminKey] = useState("");
    const [adminUserId, setAdminUserId] = useState(settings.anthropicUserId ?? "");
    const [defaultModel, setDefaultModel] = useState(settings.defaultModel ?? "");
    return (
        <>
            <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 12.5 }}>Tokens are optional: without them tickets are fetched through the account's ClickUp/Linear MCP by a short Claude run. Stored in ~/.stagehand/config.json.</p>
            <label>ClickUp personal API token (pk_…) <input value={clickupToken} onChange={(e) => setClickupToken(e.target.value)} placeholder={settings.clickupToken ?? "not set"} /></label>
            <label>ClickUp team id <input value={clickupTeamId} onChange={(e) => setClickupTeamId(e.target.value)} /></label>
            <label>Linear API key <input value={linearApiKey} onChange={(e) => setLinearApiKey(e.target.value)} placeholder={settings.linearApiKey ?? "not set"} /></label>
            <label>Anthropic Admin API key (enterprise org, read:analytics scope — adds an organization section to Analytics) <input value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder={settings.anthropicAdminKey ?? "not set"} /></label>
            <label>Anthropic user id to filter the organization report to (optional, user_…) <input value={adminUserId} onChange={(e) => setAdminUserId(e.target.value)} placeholder="whole organization" /></label>
            <label>Default Claude model
                <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
                    {settings.models.map((m) => (
                        <option key={m.value} value={m.value}>
                            {m.value === ""
                                ? `Account default · ${accounts.filter((a) => a.logged_in).map((a) => `${a.name}: ${modelLabel(a.default_model, settings.models) ?? "?"}`).join(", ") || "no logged-in account"}`
                                : m.label}
                        </option>
                    ))}
                </select>
            </label>
            <button className="primary" onClick={() => onSubmit({
                ...(clickupToken ? { clickupToken } : {}),
                clickupTeamId: clickupTeamId || null,
                ...(linearApiKey ? { linearApiKey } : {}),
                ...(adminKey ? { anthropicAdminKey: adminKey } : {}),
                anthropicUserId: adminUserId || null,
                defaultModel: defaultModel || null,
            })}>Save</button>
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
            <label>Branch prefix <input value={branchPrefix} onChange={(e) => setBranchPrefix(e.target.value)} placeholder="e.g. stepanb/ — prepended to the branch research proposes" /></label>
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
            <label>Name <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="northspyre" /></label>
            <label>Email (label) <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
            <button className="primary" disabled={!/^[a-z0-9-]+$/.test(name)} onClick={() => onSubmit(name, email || undefined)}>Set up token</button>
        </>
    );
};

const LazyTerminal = ({ session }: { session: string }) => {
    const [T, setT] = useState<null | (typeof import("./Terminal"))["Terminal"]>(null);
    useEffect(() => {
        void import("./Terminal").then((m) => setT(() => m.Terminal));
    }, []);
    return T ? <T session={session} /> : <div className="term" />;
};

export { STAGE_ORDER };
