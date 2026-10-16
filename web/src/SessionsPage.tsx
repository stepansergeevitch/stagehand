import { useCallback, useEffect, useMemo, useState } from "react";
import { accountUsableWith, api, envRepos, modelLabel, type Account, type ConfigDir, type Env, type Session, type Settings } from "./api";
import { DiffView, sessionSource } from "./DiffView";
import { LazyTerminal } from "./LazyTerminal";
import type { DiffRoute } from "./routes";
import { Button, Checkbox, Chip, EmptyState, Hint, Icon, Input, MenuItem, MoreMenu, Select, Skeleton } from "@vortex/ds";
import { DataTable, type DataColumn } from "./components/DataTable";
import { EntityView } from "./components/EntityView";
import { KeyValue } from "./components/KeyValue";
import { Modal } from "./components/Modal";
import { Panel } from "./components/Panel";
import { Toolbar } from "./components/Toolbar";
import { age } from "./components/status";
import "./sessions.css";

// Free-form claude sessions: pick an environment (its config dir, env vars and checkout) and an AI account, optionally
// a fresh worktree on a branch, and get an interactive `claude` in a terminal — plus the same diff view tasks have,
// for whatever the session changes. Sessions live in tmux, so closing the page keeps them; Open resumes the conversation.
type View = "terminal" | "changes";
type Act = (label: string, fn: () => Promise<unknown>) => Promise<void>;

export const SessionsPage = ({ envs, accounts, configDirs, settings, session, view, creating, diff, onNavigate, onCreating, onDiff, onError }: {
    envs: Env[]; accounts: Account[]; configDirs: ConfigDir[]; settings: Settings | null;
    // The open session and its sub-view are routed (#/sessions/<id>/<terminal|changes>).
    session: string | null; view: View; onNavigate: (session: string | null, view?: View) => void;
    // The New session dialog (#/sessions/new) and the Changes tab's diff view (repository, changes, files/tests).
    creating: boolean; onCreating: (on: boolean) => void;
    diff: DiffRoute | undefined; onDiff: (d: DiffRoute) => void;
    onError: (m: string) => void;
}) => {
    const [sessions, setSessions] = useState<Session[] | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const refresh = useCallback(() => api.sessions().then(setSessions).catch((e: Error) => onError(e.message)), [onError]);
    useEffect(() => {
        void refresh();
        const t = setInterval(() => void refresh(), 10_000);
        return () => clearInterval(t);
    }, [refresh]);

    const act: Act = async (label, fn) => {
        setBusy(label);
        try {
            await fn();
            await refresh();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };
    const open = (s: Session): Promise<void> => act(`open:${s.id}`, async () => { await api.openSession(s.id); onNavigate(s.id, "terminal"); });

    const dialog = creating && (
        <NewSession
            envs={envs}
            accounts={accounts}
            configDirs={configDirs}
            settings={settings}
            onClose={() => onCreating(false)}
            onCreate={(body) => act("create", async () => {
                const s = await api.createSession(body);
                onNavigate(s.id, "terminal");
            })}
        />
    );

    if (!sessions) return <div className="sessions-loading" aria-busy="true"><Skeleton height={36} /><Skeleton height={240} /></div>;

    const current = session ? sessions.find((s) => s.id === session) : undefined;
    if (session) {
        return current ? (
            <>
                <SessionView
                    s={current}
                    env={envs.find((e) => e.id === current.env_id)}
                    settings={settings}
                    view={view}
                    diff={diff}
                    busy={busy}
                    onNavigate={onNavigate}
                    onDiff={onDiff}
                    onOpen={() => open(current)}
                    onClose={() => act(`close:${current.id}`, async () => { await api.closeSession(current.id); })}
                    onRename={(name) => act(`rename:${current.id}`, () => api.renameSession(current.id, name))}
                    onRecreateDb={() => act(`db:${current.id}`, () => api.recreateSessionDb(current.id))}
                    onDelete={(removeWorktree) =>
                        act(`delete:${current.id}`, async () => {
                            try {
                                await api.deleteSession(current.id, removeWorktree);
                            } catch (e) {
                                const msg = String((e as Error).message ?? e);
                                if (/push or discard/.test(msg) && confirm(`${msg}\n\nDiscard them and delete anyway?`)) await api.deleteSession(current.id, removeWorktree, true);
                                else throw e;
                            }
                            onNavigate(null);
                        })
                    }
                />
                {dialog}
            </>
        ) : (
            <EmptyState icon="terminal" title="Session not found" action={<Button onClick={() => onNavigate(null)}>Back to sessions</Button>}>
                It may have been deleted.
            </EmptyState>
        );
    }

    return (
        <>
            <SessionList sessions={sessions} settings={settings} busy={busy} onCreate={() => onCreating(true)} onOpen={(s) => void open(s)} onClosePanes={(list) => act("close", async () => { for (const s of list) await api.closeSession(s.id); })} />
            {dialog}
        </>
    );
};

const SessionList = ({ sessions, settings, busy, onCreate, onOpen, onClosePanes }: {
    sessions: Session[]; settings: Settings | null; busy: string | null;
    onCreate: () => void; onOpen: (s: Session) => void; onClosePanes: (list: Session[]) => Promise<void>;
}) => {
    const columns = useMemo<DataColumn<Session>[]>(() => [
        { key: "state", label: "State", value: (s) => (s.alive ? "Open" : "Closed"), render: (s) => <Chip tone={s.alive ? "info" : "neutral"}>{s.alive ? "Open" : "Closed"}</Chip> },
        { key: "name", label: "Name", kind: "label", value: (s) => s.name, filter: false },
        { key: "env", label: "Environment", value: (s) => s.env_name },
        { key: "account", label: "AI account", value: (s) => s.account_name ?? "" },
        { key: "model", label: "Model", value: (s) => (s.model ? modelLabel(s.model, settings?.models) ?? s.model : "") },
        { key: "branch", label: "Branch", value: (s) => s.branch ?? "", render: (s) => (s.branch ? <code>{s.branch}</code> : <span className="ses-quiet">main checkout</span>), filter: false },
        { key: "opened", label: "Last opened", value: (s) => s.opened_at ?? "", render: (s) => (s.opened_at ? `${age(s.opened_at)} ago` : <span className="ses-quiet">never</span>), filter: false },
        { key: "created", label: "Created", value: (s) => s.created_at, render: (s) => `${age(s.created_at)} ago`, filter: false, defaultHidden: true },
        { key: "dir", label: "Directory", value: (s) => s.cwd, render: (s) => <code>{s.cwd}</code>, filter: false, defaultHidden: true },
    ], [settings]);
    return (
        <DataTable
            title="Sessions"
            entity="session"
            onCreate={onCreate}
            columns={columns}
            rows={sessions}
            rowKey={(s) => s.id}
            onRowClick={(s) => { if (busy === null) onOpen(s); }}
            defaultSort={{ key: "opened", desc: true }}
            storageKey="sessions"
            bulkActions={(selected, clear) => {
                const alive = selected.filter((s) => s.alive);
                return <Button size="sm" disabled={busy !== null || alive.length === 0} onClick={() => void onClosePanes(alive).then(clear)}>Close {alive.length} pane{alive.length === 1 ? "" : "s"}</Button>;
            }}
            empty={<EmptyState icon="terminal" title="No sessions yet" action={<Button variant="primary" onClick={onCreate}><Icon name="plus" />Create new session</Button>}>A session is an interactive claude in an environment's checkout, kept in tmux.</EmptyState>}
        />
    );
};

const SessionView = ({ s, env, settings, view, diff, busy, onNavigate, onDiff, onOpen, onClose, onRename, onDelete, onRecreateDb }: {
    s: Session; env: Env | undefined; settings: Settings | null; view: View; diff: DiffRoute | undefined; busy: string | null;
    onNavigate: (session: string | null, view?: View) => void; onDiff: (d: DiffRoute) => void;
    onOpen: () => Promise<void>; onClose: () => Promise<void>; onRename: (name: string) => Promise<void>; onDelete: (removeWorktree: boolean) => Promise<void>; onRecreateDb: () => Promise<void>;
}) => {
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(s.name);
    const [details, setDetails] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const mine = (label: string) => busy === `${label}:${s.id}`;
    const save = () => {
        if (name.trim()) void onRename(name.trim());
        setRenaming(false);
    };
    const remove = () => {
        if (s.worktree_path) {
            const rm = confirm(`Delete session "${s.name}" AND remove its worktree + local branch ${s.branch}?\n\nOK = remove the worktree too · Cancel = keep the worktree, forget only the session`);
            if (!rm && !confirm(`Forget session "${s.name}" and keep the worktree at ${s.worktree_path}?`)) return;
            void onDelete(rm);
        } else if (confirm(`Delete session "${s.name}"? The conversation cannot be resumed from Vortex afterwards.`)) void onDelete(false);
    };
    const dbCell = s.db?.status === "ready" ? <code>{s.db.name}</code> : s.db ? <Chip tone="bad" title={s.db.error ?? ""}>{s.db.status}{s.db.error ? `: ${s.db.error.slice(0, 120)}` : ""}</Chip> : <span className="ses-quiet">The environment&apos;s shared database</span>;

    const facts = details && (
        <Panel title="Details">
            <KeyValue
                columns={2}
                items={[
                    { label: "Directory", value: s.cwd, mono: true },
                    { label: "Branch", value: s.branch ? `${s.branch} (own worktree${env ? ` from ${env.base_branch}` : ""})` : "None, works in the main checkout", mono: !!s.branch },
                    { label: "AI account", value: s.account_name ?? "—" },
                    { label: "Model", value: s.model ? modelLabel(s.model, settings?.models) ?? s.model : "Account default" },
                    ...(s.db || s.dbAvailable ? [{ label: "Database", value: dbCell }] : []),
                    { label: "Created", value: new Date(s.created_at).toLocaleString() },
                    { label: "Last opened", value: s.opened_at ? new Date(s.opened_at).toLocaleString() : "Never" },
                ]}
            />
        </Panel>
    );

    const terminal = (
        <div className="session-body">
            {facts}
            {s.alive ? (
                <div className="session-term"><LazyTerminal key={s.tmux} session={s.tmux} /></div>
            ) : (
                <EmptyState icon="terminal" title="The pane is closed">Resume starts claude again and picks up this conversation.</EmptyState>
            )}
        </div>
    );
    const changes = (
        <div className="session-body">
            {facts}
            <Toolbar end={<Button size="sm" onClick={() => setRefreshKey((k) => k + 1)}><Icon name="refresh" />Refresh</Button>}>
                <span className="session-scope">
                    {s.worktree_path ? `Branch ${s.branch} against ${env?.base_branch ?? "the base branch"}` : "Uncommitted changes in the main checkout"}
                    <Hint text={s.worktree_path ? `Everything on ${s.branch} versus the environment's base branch, committed or not.` : "This session works in the environment's main checkout, so only uncommitted changes there are shown."} />
                </span>
            </Toolbar>
            <DiffView source={sessionSource(s.id)} refreshKey={`${s.id}:${refreshKey}`} repos={envRepos(env)} view={diff ?? {}} onView={onDiff} />
        </div>
    );

    return (
        <EntityView
            type="Session"
            onType={() => onNavigate(null)}
            id={renaming ? (
                <span className="session-rename">
                    <Input autoFocus aria-label="Session name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setRenaming(false); }} />
                    <Button size="sm" variant="primary" disabled={!name.trim()} onClick={save}>Save</Button>
                    <Button size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
                </span>
            ) : s.name}
            meta={
                <>
                    <Chip tone={s.alive ? "info" : "neutral"}>{s.alive ? "Open" : "Closed"}</Chip>
                    <Chip>{s.env_name}</Chip>
                    {s.branch && <Chip mono>{s.branch}</Chip>}
                </>
            }
            actions={
                <>
                    {!s.alive && <Button variant="primary" disabled={busy !== null} onClick={() => void onOpen()}>{mine("open") ? "Opening…" : s.opened_at ? "Resume" : "Open"}</Button>}
                    <Button on={details} aria-expanded={details} onClick={() => setDetails((d) => !d)}>Details</Button>
                    <MoreMenu>
                        <MenuItem onClick={() => { setName(s.name); setRenaming(true); }}>Rename</MenuItem>
                        {s.dbAvailable && (
                            <MenuItem disabled={busy !== null} title={s.db?.status === "ready" ? "Close the pane, copy the template again (this session's data is lost), point the worktree at the copy" : "Close the pane, copy the template for this session, point the worktree at the copy"} onClick={() => void onRecreateDb()}>
                                {mine("db") ? "Copying the database…" : s.db?.status === "ready" ? "Recreate database" : "Use its own database"}
                            </MenuItem>
                        )}
                        {s.alive && <MenuItem disabled={busy !== null} title="Kills the tmux pane; the conversation can be resumed" onClick={() => void onClose()}>{mine("close") ? "Closing…" : "Close pane"}</MenuItem>}
                        <hr />
                        <MenuItem danger disabled={busy !== null} onClick={remove}>{mine("delete") ? "Deleting…" : "Delete session"}</MenuItem>
                    </MoreMenu>
                </>
            }
            tabs={[
                { key: "terminal", label: "Terminal", content: terminal },
                { key: "changes", label: "Changes", content: changes },
            ]}
            tab={view}
            onTab={(k) => {
                if (k === "changes") setRefreshKey((n) => n + 1);
                onNavigate(s.id, k === "changes" ? "changes" : "terminal");
            }}
        />
    );
};

const NewSession = ({ envs, accounts, configDirs, settings, onCreate, onClose }: {
    envs: Env[]; accounts: Account[]; configDirs: ConfigDir[]; settings: Settings | null;
    onCreate: (body: { envId: string; accountId?: string | null; model?: string | null; name?: string; branch?: string | null }) => Promise<void>;
    onClose: () => void;
}) => {
    const [envId, setEnvId] = useState(envs[0]?.id ?? "");
    const env = envs.find((e) => e.id === envId);
    const dir = env?.config_dir_id ? configDirs.find((d) => d.id === env.config_dir_id) : undefined;
    const usable = accounts.filter((a) => !dir || accountUsableWith(a, dir.path));
    const [accountId, setAccountId] = useState("");
    const [model, setModel] = useState("");
    const [name, setName] = useState("");
    const [worktree, setWorktree] = useState(false);
    const [branch, setBranch] = useState("");
    const [submitting, setSubmitting] = useState(false);
    useEffect(() => {
        setAccountId(usable.find((a) => a.id === env?.default_account_id)?.id ?? usable[0]?.id ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [envId]);
    const prefix = env?.branch_prefix ?? "";
    const canSubmit = !!env && !!accountId && (!worktree || branch.trim().length > 0) && !submitting;
    const submit = () => {
        setSubmitting(true);
        void onCreate({ envId, accountId, model: model || null, ...(name.trim() ? { name: name.trim() } : {}), branch: worktree ? branch.trim() : null }).finally(() => setSubmitting(false));
    };
    return (
        <Modal
            title="New session"
            onClose={onClose}
            footer={
                <>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="primary" disabled={!canSubmit} onClick={submit}>{submitting ? "Creating…" : "Create and open"}</Button>
                </>
            }
        >
            <label>
                <span className="ns-label">Environment<Hint text={`Fixes the config dir (${dir?.name ?? "server default"}), env vars and the checkout at ${env?.path ?? ""}.`} /></span>
                <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                    {envs.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.base_branch})</option>)}
                </Select>
            </label>
            <label>
                AI account
                <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} invalid={usable.length === 0}>
                    {usable.length === 0 && <option value="">No account can run in this config dir</option>}
                    {usable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.plan ? ` · ${a.plan}` : ""}</option>)}
                </Select>
            </label>
            <label>
                Model
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                    {(settings?.models ?? [{ value: "", label: "Account default" }]).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
            </label>
            <label>
                Name (optional)
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={worktree && branch ? branch : `${env?.name ?? "session"} · date`} />
            </label>
            <div className="ns-check">
                <Checkbox label="Own worktree on a new branch" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                <Hint text="Without a worktree, claude works directly in the environment's main checkout, whatever branch it is on." />
            </div>
            {worktree && (
                <label>
                    <span className="ns-label">
                        Branch
                        <Hint text={`Created from origin/${env?.base_branch} under ${env?.path}/.claude/worktrees/; the environment's setup command runs in the terminal before claude starts.${prefix && !branch.startsWith(prefix) ? ` This environment's branches usually start with "${prefix}".` : ""}`} />
                    </span>
                    <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={`${prefix}my-experiment`} />
                </label>
            )}
        </Modal>
    );
};
