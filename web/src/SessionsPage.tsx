import { useCallback, useEffect, useState } from "react";
import { accountUsableWith, api, envRepos, modelLabel, type Account, type ConfigDir, type Env, type Session, type Settings } from "./api";
import { DiffView, sessionSource } from "./DiffView";
import { LazyTerminal } from "./LazyTerminal";
import type { DiffRoute } from "./routes";
import { Button, Card, Chip, Input, Select, Tab, TabList } from "@vortex/ds";

// Free-form claude sessions: pick an environment (its config dir, env vars and checkout) and an AI account, optionally
// a fresh worktree on a branch, and get an interactive `claude` in a terminal — plus the same diff view tasks have,
// for whatever the session changes. Sessions live in tmux, so closing the page keeps them; Open resumes the conversation.
export const SessionsPage = ({ envs, accounts, configDirs, settings, session, view, creating, diff, onNavigate, onCreating, onDiff, onError }: {
    envs: Env[]; accounts: Account[]; configDirs: ConfigDir[]; settings: Settings | null;
    // The open session and its sub-view are routed (#/sessions/<id>/<terminal|changes>).
    session: string | null; view: "terminal" | "changes"; onNavigate: (session: string | null, view?: "terminal" | "changes") => void;
    // The New session form (#/sessions/new) and the Changes tab's diff view (repository, changes, files/tests).
    creating: boolean; onCreating: (on: boolean) => void;
    diff: DiffRoute | undefined; onDiff: (d: DiffRoute) => void;
    onError: (m: string) => void;
}) => {
    const [sessions, setSessions] = useState<Session[]>([]);
    const active = session;
    const [busy, setBusy] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    const refresh = useCallback(() => api.sessions().then(setSessions).catch((e: Error) => onError(e.message)), [onError]);
    useEffect(() => {
        void refresh();
        const t = setInterval(() => void refresh(), 10_000);
        return () => clearInterval(t);
    }, [refresh]);

    const act = async (label: string, fn: () => Promise<unknown>) => {
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

    const current = sessions.find((s) => s.id === active) ?? null;
    const currentEnv = current ? envs.find((e) => e.id === current.env_id) : undefined;

    return (
        <div className="env-page sessions-page">
            <h1>Sessions</h1>
            <p className="field-hint" style={{ marginBottom: 10 }}>
                A plain interactive <code>claude</code> in an environment's checkout (or its own worktree), with the environment's config dir and the AI account you pick. It runs in tmux: leave the page and come back, or Open again after claude exited to resume the same conversation.
            </p>
            <div className="actions" style={{ marginTop: 0 }}>
                <Button variant="primary" onClick={() => onCreating(!creating)}>{creating ? "Cancel" : "+ Session"}</Button>
            </div>
            {creating && (
                <NewSession
                    envs={envs}
                    accounts={accounts}
                    configDirs={configDirs}
                    settings={settings}
                    onCreate={async (body) => {
                        await act("create", async () => {
                            const s = await api.createSession(body);
                            onNavigate(s.id, "terminal");
                        });
                    }}
                />
            )}
            {sessions.length === 0 && !creating && <div className="empty">No sessions yet.</div>}
            {sessions.map((s) => (
                <SessionCard
                    key={s.id}
                    s={s}
                    env={envs.find((e) => e.id === s.env_id)}
                    settings={settings}
                    selected={s.id === active}
                    busy={busy}
                    onOpen={() => act(`open:${s.id}`, async () => { await api.openSession(s.id); onNavigate(s.id, "terminal"); })}
                    onChanges={() => { onNavigate(s.id, "changes"); setRefreshKey((k) => k + 1); }}
                    onClose={() => act(`close:${s.id}`, async () => { await api.closeSession(s.id); if (active === s.id && view === "terminal") onNavigate(null); })}
                    onRename={(name) => act(`rename:${s.id}`, () => api.renameSession(s.id, name))}
                    onRecreateDb={() => act(`db:${s.id}`, () => api.recreateSessionDb(s.id))}
                    onDelete={(removeWorktree) =>
                        act(`delete:${s.id}`, async () => {
                            try {
                                await api.deleteSession(s.id, removeWorktree);
                            } catch (e) {
                                const msg = String((e as Error).message ?? e);
                                if (/push or discard/.test(msg) && confirm(`${msg}\n\nDiscard them and delete anyway?`)) await api.deleteSession(s.id, removeWorktree, true);
                                else throw e;
                            }
                            if (active === s.id) onNavigate(null);
                        })
                    }
                />
            ))}
            {current && (
                <Card className="session-view">
                    <h2>
                        {current.name}
                        <Chip>{current.env_name}</Chip>
                        {current.branch && <Chip tone="accent">{current.branch}</Chip>}
                    </h2>
                    <TabList variant="pill">
                        <Tab active={view === "terminal"} onClick={() => onNavigate(current.id, "terminal")}>Terminal</Tab>
                        <Tab active={view === "changes"} onClick={() => { onNavigate(current.id, "changes"); setRefreshKey((k) => k + 1); }}>Changes</Tab>
                    </TabList>
                    {view === "terminal" && (current.alive ? <LazyTerminal key={current.tmux} session={current.tmux} /> : <div className="empty">The pane is closed — Open starts claude again, resuming this conversation.</div>)}
                    {view === "changes" && (
                        <>
                            <p className="field-hint">
                                {current.worktree_path ? `Everything on ${current.branch} versus the environment's base branch, committed or not.` : `This session works in the environment's main checkout, so only uncommitted changes there are shown.`}
                                <Button size="sm" style={{ marginLeft: 8 }} onClick={() => setRefreshKey((k) => k + 1)}>Refresh</Button>
                            </p>
                            <DiffView source={sessionSource(current.id)} refreshKey={`${current.id}:${refreshKey}`} repos={envRepos(currentEnv)} view={diff ?? {}} onView={onDiff} />
                        </>
                    )}
                </Card>
            )}
        </div>
    );
};

const SessionCard = ({ s, env, settings, selected, busy, onOpen, onChanges, onClose, onRename, onDelete, onRecreateDb }: {
    s: Session; env: Env | undefined; settings: Settings | null; selected: boolean; busy: string | null;
    onOpen: () => Promise<void>; onChanges: () => void; onClose: () => Promise<void>; onRename: (name: string) => Promise<void>; onDelete: (removeWorktree: boolean) => Promise<void>; onRecreateDb: () => Promise<void>;
}) => {
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(s.name);
    const mine = (label: string) => busy === `${label}:${s.id}`;
    return (
        <section className={`card item session-card ${selected ? "selected" : ""}`}>
            <h2 onDoubleClick={() => { setName(s.name); setRenaming(true); }} title="double-click to rename">
                {renaming ? (
                    <span className="inline-edit">
                        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { void onRename(name.trim()); setRenaming(false); } if (e.key === "Escape") setRenaming(false); }} />
                        <Button size="sm" disabled={!name.trim()} onClick={() => { void onRename(name.trim()); setRenaming(false); }}>Save</Button>
                        <Button size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
                    </span>
                ) : s.name}
                <Chip className={`${s.alive ? "ok" : ""}`}>{s.alive ? "open" : "closed"}</Chip>
                <Chip>{s.env_name}</Chip>
                {s.account_name && <Chip>{s.account_name}</Chip>}
                {s.model && <Chip>{modelLabel(s.model, settings?.models) ?? s.model}</Chip>}
            </h2>
            <div className="kv">
                <b>Directory</b><code>{s.cwd}</code>
                {s.branch && <><b>Branch</b><span><code>{s.branch}</code> <small className="field-hint" style={{ display: "inline" }}>own worktree{env ? ` from ${env.base_branch}` : ""}</small></span></>}
                {(s.db || s.dbAvailable) && <><b>Database</b><span>{s.db?.status === "ready" ? <code>{s.db.name}</code> : s.db ? <Chip tone="bad" title={s.db.error ?? ""}>{s.db.status}{s.db.error ? `: ${s.db.error.slice(0, 120)}` : ""}</Chip> : <span className="field-hint" style={{ display: "inline" }}>the env&apos;s shared database</span>}</span></>}
                <b>Created</b><span>{new Date(s.created_at).toLocaleString()}{s.opened_at ? "" : " · never opened"}</span>
            </div>
            <div className="actions">
                <Button variant="primary" disabled={busy !== null} onClick={() => void onOpen()}>{mine("open") ? "Opening…" : s.alive ? "Show terminal" : s.opened_at ? "Open (resume)" : "Open"}</Button>
                <Button disabled={busy !== null} onClick={onChanges}>Changes</Button>
                {s.dbAvailable && <Button disabled={busy !== null} title={s.db?.status === "ready" ? "Close the pane, copy the template again (this session's data is lost), point the worktree at the copy" : "Close the pane, copy the template for this session, point the worktree at the copy"} onClick={() => void onRecreateDb()}>{mine("db") ? "Copying the database…" : s.db?.status === "ready" ? "Recreate database" : "Own database"}</Button>}
                {s.alive && <Button disabled={busy !== null} title="Kills the tmux pane; the conversation can be resumed with Open" onClick={() => void onClose()}>{mine("close") ? "Closing…" : "Close pane"}</Button>}
                <Button variant="danger"
 
 disabled={busy !== null}
 onClick={() => {
 if (s.worktree_path) {
 const rm = confirm(`Delete session "${s.name}" AND remove its worktree + local branch ${s.branch}?\n\nOK = remove the worktree too · Cancel = keep the worktree, forget only the session`);
 if (!rm && !confirm(`Forget session "${s.name}" and keep the worktree at ${s.worktree_path}?`)) return;
 void onDelete(rm);
 } else if (confirm(`Delete session "${s.name}"? The conversation cannot be resumed from Vortex afterwards.`)) void onDelete(false);
 }}
>
                    {mine("delete") ? "Deleting…" : "Delete"}
                </Button>
            </div>
        </section>
    );
};

const NewSession = ({ envs, accounts, configDirs, settings, onCreate }: {
    envs: Env[]; accounts: Account[]; configDirs: ConfigDir[]; settings: Settings | null;
    onCreate: (body: { envId: string; accountId?: string | null; model?: string | null; name?: string; branch?: string | null }) => Promise<void>;
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
    return (
        <Card className="env-section">
            <h2>New session</h2>
            <div className="env-fields">
                <label>Environment
                    <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                        {envs.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.base_branch})</option>)}
                    </Select>
                    <span className="field-hint">Fixes the config dir ({dir?.name ?? "server default"}), env vars and the checkout at <code>{env?.path}</code>.</span>
                </label>
                <label>AI account
                    <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                        {usable.length === 0 && <option value="">no account can run in this config dir</option>}
                        {usable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.plan ? ` · ${a.plan}` : ""}</option>)}
                    </Select>
                </label>
                <label>Model
                    <Select value={model} onChange={(e) => setModel(e.target.value)}>
                        {(settings?.models ?? [{ value: "", label: "Account default" }]).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </Select>
                </label>
                <label>Name <span className="field-hint" style={{ display: "inline" }}>(optional)</span>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={worktree && branch ? branch : `${env?.name ?? "session"} · date`} />
                </label>
                <label className="inline">
                    <Input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> Own worktree on a new branch
                </label>
                {worktree && (
                    <label>Branch
                        <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={`${prefix}my-experiment`} />
                        <span className="field-hint">
                            Created from <code>origin/{env?.base_branch}</code> under <code>{env?.path}/.claude/worktrees/</code>; the env's setup command runs in the terminal before claude starts.
                            {prefix && !branch.startsWith(prefix) ? ` This env's branches usually start with "${prefix}".` : ""}
                        </span>
                    </label>
                )}
                {!worktree && <span className="field-hint">Without a worktree, claude works directly in the environment's main checkout, whatever branch it is on.</span>}
            </div>
            <div className="actions">
                <Button variant="primary"
 
 disabled={!canSubmit}
 onClick={() => {
 setSubmitting(true);
 void onCreate({ envId, accountId, model: model || null, ...(name.trim() ? { name: name.trim() } : {}), branch: worktree ? branch.trim() : null }).finally(() => setSubmitting(false));
 }}
>
                    {submitting ? "Creating…" : "Create and open"}
                </Button>
            </div>
        </Card>
    );
};
