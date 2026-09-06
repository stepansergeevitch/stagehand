import { useCallback, useEffect, useMemo, useState } from "react";
import { api, STAGE_LABEL, STAGE_ORDER, type Account, type Env, type Task, type TaskDetail } from "./api";
import { TaskDetailView } from "./TaskDetail";

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

const Gauge = ({ a }: { a: Account }) => {
    const five = a.limits.find((l) => l.window === "five_hour");
    const week = a.limits.find((l) => l.window === "seven_day");
    const cls = (u: number) => (u >= 0.9 ? "bad" : u >= 0.6 ? "warn" : "");
    return (
        <span className="gauge" title={`${a.email ?? "not logged in"} · ${a.org ?? ""} · ${a.plan ?? ""}`}>
            <span>{a.name}</span>
            <span className="bar"><i className={cls(five?.utilization ?? 0)} style={{ width: `${Math.round((five?.utilization ?? 0) * 100)}%` }} /></span>
            <span>{five ? `${Math.round(five.utilization * 100)}%` : "—"}</span>
            <span className="bar"><i className={cls(week?.utilization ?? 0)} style={{ width: `${Math.round((week?.utilization ?? 0) * 100)}%` }} /></span>
            <span>{week ? `${Math.round(week.utilization * 100)}%` : "—"}</span>
            {a.chrome_capable === 1 && <span className="chip ok">chrome</span>}
            {!a.logged_in && <span className="chip bad">login</span>}
        </span>
    );
};

export const App = () => {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [envs, setEnvs] = useState<Env[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [envId, setEnvId] = useState<string>(() => localStorage.getItem("stagehand.env") ?? "");
    const [selected, setSelected] = useState<string | null>(null);
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [feed, setFeed] = useState<Record<string, string[]>>({});
    const [modal, setModal] = useState<"task" | "env" | "env-edit" | "account" | null>(null);
    const [terminal, setTerminal] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        const [a, e, t] = await Promise.all([api.accounts(), api.envs(), api.tasks()]);
        setAccounts(a);
        setEnvs(e);
        setTasks(t);
        if (!envId && e[0]) setEnvId(e[0].id);
    }, [envId]);

    const loadDetail = useCallback(async (id: string) => setDetail(await api.task(id)), []);

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
            if (msg.kind === "rate_limit") void api.accounts().then(setAccounts);
        };
        return () => ws.close();
    }, [selected, loadDetail]);

    useEffect(() => {
        if (selected) void loadDetail(selected);
        else setDetail(null);
    }, [selected, loadDetail]);

    const visible = useMemo(() => tasks.filter((t) => !envId || t.env_id === envId), [tasks, envId]);
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

    return (
        <div className="app">
            <header className="topbar">
                <span className="brand">Stagehand</span>
                <label>
                    env
                    <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                        {envs.map((e) => (
                            <option key={e.id} value={e.id}>{e.name} · {e.path} ({e.base_branch})</option>
                        ))}
                    </select>
                </label>
                <button onClick={() => setModal("env")}>+ env</button>
                {env && <button onClick={() => setModal("env-edit")}>edit env</button>}
                <span className="spacer" />
                {accounts.map((a) => <Gauge key={a.id} a={a} />)}
                <button onClick={() => setModal("account")}>+ account</button>
                <button className="primary" disabled={!env} onClick={() => setModal("task")}>+ task</button>
            </header>
            <div className="main">
                <aside className="list">
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
                    {error && <div className="blocked-box">{error}</div>}
                    {!detail && <div className="empty">Select a task, or add one.</div>}
                    {detail && (
                        <TaskDetailView
                            detail={detail}
                            accounts={accounts}
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
            </div>
            {modal === "task" && env && (
                <Modal title={`New task in ${env.name}`} onClose={() => setModal(null)}>
                    <TaskForm accounts={accounts} env={env} onSubmit={async (ticket, acc) => { await run(() => api.createTask(env.id, ticket, acc)); setModal(null); }} />
                </Modal>
            )}
            {modal === "env" && (
                <Modal title="Add environment" onClose={() => setModal(null)}>
                    <EnvForm accounts={accounts} onSubmit={async (b) => { await run(() => api.addEnv(b)); setModal(null); }} />
                </Modal>
            )}
            {modal === "env-edit" && env && (
                <Modal title={`Edit ${env.name}`} onClose={() => setModal(null)} wide>
                    <EnvEditForm env={env} accounts={accounts} onSubmit={async (b) => { await run(() => api.patchEnv(env.id, b)); setModal(null); }} />
                </Modal>
            )}
            {modal === "account" && (
                <Modal title="Add account" onClose={() => setModal(null)}>
                    <AccountForm onSubmit={async (name, email) => {
                        const r = await api.addAccount(name, email);
                        setModal(null);
                        if (r.terminal) setTerminal(r.terminal);
                        await reload();
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

const Modal = ({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) => (
    <div className="modal" onClick={onClose}>
        <div className="box" style={wide ? { minWidth: 900 } : undefined} onClick={(e) => e.stopPropagation()}>
            <h2>{title}</h2>
            {children}
        </div>
    </div>
);

const TaskForm = ({ accounts, env, onSubmit }: { accounts: Account[]; env: Env; onSubmit: (ticket: string, accountId?: string) => Promise<void> }) => {
    const [ticket, setTicket] = useState("");
    const [acc, setAcc] = useState(env.default_account_id ?? accounts.find((a) => a.logged_in)?.id ?? "");
    return (
        <>
            <label>Ticket id <input autoFocus value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="ENG-24201" /></label>
            <label>Account
                <select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.email ?? "not logged in"}</option>)}
                </select>
            </label>
            <button className="primary" disabled={!ticket.trim()} onClick={() => onSubmit(ticket.trim(), acc || undefined)}>Start research</button>
        </>
    );
};

const EnvForm = ({
    accounts,
    onSubmit,
}: {
    accounts: Account[];
    onSubmit: (b: { name: string; path: string; baseBranch: string; defaultAccountId?: string; appUrl?: string; qaScript?: string }) => Promise<void>;
}) => {
    const [name, setName] = useState("");
    const [path, setPath] = useState("");
    const [base, setBase] = useState("main");
    const [acc, setAcc] = useState("");
    const [appUrl, setAppUrl] = useState("");
    const [qaScript, setQaScript] = useState("");
    return (
        <>
            <label>Name <input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Path <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/code/repo" /></label>
            <label>Base branch <input value={base} onChange={(e) => setBase(e.target.value)} /></label>
            <label>App URL for QA <input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://localhost:3000" /></label>
            <label>QA bring-up command <input value={qaScript} onChange={(e) => setQaScript(e.target.value)} placeholder="optional, run from the worktree before QA" /></label>
            <label>Default account
                <select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    <option value="">— none —</option>
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
                        ...(acc ? { defaultAccountId: acc } : {}),
                        ...(appUrl ? { appUrl } : {}),
                        ...(qaScript ? { qaScript } : {}),
                    })
                }
            >
                Add
            </button>
        </>
    );
};

const HELP = "Placeholders: {{port}} (this service's port), {{url}}, {{bePort}}, {{beUrl}} (FE only), {{worktree}}, {{taskDir}}. Runs from the task's worktree in tmux; output goes to <taskDir>/logs/<kind>.log.";

const EnvEditForm = ({ env, accounts, onSubmit }: { env: Env; accounts: Account[]; onSubmit: (b: Parameters<typeof api.patchEnv>[1]) => Promise<void> }) => {
    const [f, setF] = useState({
        name: env.name,
        baseBranch: env.base_branch,
        defaultAccountId: env.default_account_id ?? "",
        appUrl: env.app_url ?? "",
        beCommand: env.be_command ?? "",
        feCommand: env.fe_command ?? "",
        beUrlTemplate: env.be_url_template ?? "",
        feUrlTemplate: env.fe_url_template ?? "",
        bePort: env.be_port ? String(env.be_port) : "",
        fePort: env.fe_port ? String(env.fe_port) : "",
    });
    const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
    const nul = (s: string) => (s.trim() === "" ? null : s);
    return (
        <>
            <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 12.5 }}>{HELP}</p>
            <div className="two">
                <label>Name <input value={f.name} onChange={set("name")} /></label>
                <label>Base branch <input value={f.baseBranch} onChange={set("baseBranch")} /></label>
                <label>Default account
                    <select value={f.defaultAccountId} onChange={set("defaultAccountId")}>
                        <option value="">— none —</option>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                </label>
                <label>QA app URL <input value={f.appUrl} onChange={set("appUrl")} placeholder="{{feUrl}} or {{beUrl}} or a fixed URL" /></label>
                <label>BE fixed port <input value={f.bePort} onChange={set("bePort")} placeholder="empty = pick free" /></label>
                <label>FE fixed port <input value={f.fePort} onChange={set("fePort")} placeholder="empty = pick free" /></label>
                <label>BE URL template <input value={f.beUrlTemplate} onChange={set("beUrlTemplate")} placeholder="http://localhost:{{port}}" /></label>
                <label>FE URL template <input value={f.feUrlTemplate} onChange={set("feUrlTemplate")} placeholder="http://localhost:{{port}}" /></label>
            </div>
            <label>BE command <textarea value={f.beCommand} onChange={set("beCommand")} placeholder="e.g. PORT={{port}} uv run manage run" /></label>
            <label>FE command <textarea value={f.feCommand} onChange={set("feCommand")} placeholder="e.g. PORT={{port}} REACT_APP_API_BASE_URL={{beUrl}}/api npm start" /></label>
            <button
                className="primary"
                onClick={() =>
                    onSubmit({
                        name: f.name,
                        baseBranch: f.baseBranch,
                        defaultAccountId: nul(f.defaultAccountId),
                        appUrl: nul(f.appUrl),
                        beCommand: nul(f.beCommand),
                        feCommand: nul(f.feCommand),
                        beUrlTemplate: nul(f.beUrlTemplate),
                        feUrlTemplate: nul(f.feUrlTemplate),
                        bePort: f.bePort.trim() ? Number(f.bePort) : null,
                        fePort: f.fePort.trim() ? Number(f.fePort) : null,
                    })
                }
            >
                Save
            </button>
        </>
    );
};

const AccountForm = ({ onSubmit }: { onSubmit: (name: string, email?: string) => Promise<void> }) => {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    return (
        <>
            <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13 }}>Opens the claude.ai login form in a terminal once; pick the right account on the page — the email is only a hint.</p>
            <label>Name <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="northspyre" /></label>
            <label>Email <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
            <button className="primary" disabled={!/^[a-z0-9-]+$/.test(name)} onClick={() => onSubmit(name, email || undefined)}>Log in</button>
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
