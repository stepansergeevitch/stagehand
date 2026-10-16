import { Fragment, useEffect, useState } from "react";
import { Loading } from "./components/Loading";
import { errText } from "./format";
import { money, tokens } from "./format";
import { accountBrowserReady, accountOrderOf, api, chromeBrowserLabel, modelLabel, type Account, type AccountModels, type Env, type ModelOperation, type ModelStage, type PrompterSettings, type PrompterStatus, type Settings, type Task, type TaskManager, type TokenIntegration, TOKEN_INTEGRATIONS } from "./api";
import { CheckField, EntityForm, EntityView, Field, Hint, ReadField, useDraft, useSaver } from "./components/EntityView";
import { Section } from "./components/Panel";
import { StatRow, StatTile } from "./components/StatTile";
import { limitTone } from "./SettingsParts";
import { Button, Chip, EmptyState, Input, MenuItem, MoreMenu, Select, type Tone } from "@vortex/ds";

// The entity views of the Configuration pages that are not big enough for a file of their own: an AI account, an
// integration, the Prompter (components/EntityView.tsx).

// The outcome of the last action on the page (Verify, Test, …); `pending` while it runs.
type Outcome = { ok: boolean; text: string; pending?: boolean } | null;

// ---------- AI account ----------

export const MODEL_STAGES: Array<{ key: ModelStage; label: string }> = [
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
    { key: "pr_fix_ci", label: "PR Fix for failing checks", hint: "Wins over the PR Fix stage model for rounds started from CI." },
    { key: "pr_fix_comments", label: "PR Fix for comments", hint: "Rounds started from picked PR comments or Code-changes comments." },
    { key: "chat", label: "Chat (Ask)", hint: "Questions in the task's Chat and on diff lines." },
    { key: "instruct", label: "Chat (Do)", hint: "Free-text instructions carried out in the worktree." },
    { key: "rebase", label: "Rebase with the agent", hint: "Only when the plain git rebase conflicted." },
    { key: "fix_service", label: "Fix a BE/FE start", hint: "The App widget's Fix with agent." },
    { key: "git_edit", label: "Remove a commit", hint: "History edits from Code changes." },
];

export const authLabel = (a: Account): string => (a.setting_up ? "token setup in progress" : a.has_token ? "token" : a.logged_in ? "legacy login" : "no auth");
// Working = ok, legacy login = warn (it only runs in its own config dir), nothing = bad.
export const authTone = (a: Account): Tone => (a.setting_up ? "wait" : a.has_token ? "ok" : a.logged_in ? "warn" : "bad");

const AccountGeneralTab = ({ a, save, saving }: { a: Account; save: (k: string, body: Parameters<typeof api.patchAccount>[1]) => Promise<void>; saving: string | null }) => {
    const d = useDraft(() => ({ name: a.name, chromeDeviceId: a.chrome_device_id ?? "", cloneQa: a.chrome_clone_qa === 1 }), [a]);
    const v = d.value;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "general"} onDiscard={d.reset} onSave={() => save("general", { name: v.name.trim(), chromeDeviceId: v.chromeDeviceId || null, chromeCloneQa: v.cloneQa })}>
            <Field label="Name" hint="Lowercase letters, digits and dashes."><Input value={v.name} onChange={(e) => d.patch({ name: e.target.value })} /></Field>
            <ReadField label="Provider">{a.provider}</ReadField>
            {a.email && <ReadField label="Email">{a.email}</ReadField>}
            {a.plan && <ReadField label="Plan">{a.plan}</ReadField>}
            <Field label="Chrome profile" hint="Browser stages (QA, the login helper) need a claude.ai browser login plus a Chrome profile whose Claude extension is signed into this account; tokens get no Chrome bridge. Probe Chrome lists the profiles.">
                {a.chrome_capable === null ? <Chip>not probed yet — use Probe Chrome in the ⋯ menu</Chip> : a.chrome_capable ? (
                    <Select aria-label="Chrome profile" value={v.chromeDeviceId} onChange={(e) => d.patch({ chromeDeviceId: e.target.value })}>
                        <option value="">— pick a profile —</option>
                        {(a.browsers ?? []).map((b) => <option key={b.deviceId} value={b.deviceId}>{chromeBrowserLabel(b)}{b.account ? ` · ${b.account}` : ""}</option>)}
                    </Select>
                ) : <Chip tone="bad">no Chrome bridge under this login</Chip>}
            </Field>
            <CheckField label="Copy the Chrome profile for every browser QA run" hint="Each QA run copies the profile above (cookies and app logins included), starts its own Chrome window on the copy, drives it, and deletes the copy afterwards — several browser runs of this account go in parallel and your own Chrome is never touched. Off: runs share the profile, one at a time." checked={v.cloneQa} disabled={!v.chromeDeviceId} onChange={(on) => d.patch({ cloneQa: on })} />
        </EntityForm>
    );
};

const AccountStatusTab = ({ a, envs }: { a: Account; envs: Env[] }) => {
    const five = a.limits.find((l) => l.window === "five_hour");
    const week = a.limits.find((l) => l.window === "seven_day");
    const pctNum = (l: typeof five): number | null => (l && !l.expired ? Math.round(l.utilization * 100) : null);
    const pct = (l: typeof five): string => (l ? (l.expired ? "reset" : `${Math.round(l.utilization * 100)}%`) : "—");
    const windowHint = five?.updatedAt ? `As of ${new Date(five.updatedAt).toLocaleString()}${a.windows.length ? `; one window ≈ ${a.windows.map((w) => `$${w.usdPerWindow.toFixed(0)} (${w.window === "five_hour" ? "5 h" : "7 d"})`).join(", ")} of estimated cost` : ""}.` : undefined;
    return (
        <div className="ev-fields">
            <StatRow>
                <StatTile label="5-hour window" value={pct(five)} tone={limitTone(pctNum(five))} sub="used" />
                <StatTile label="7-day window" value={pct(week)} tone={limitTone(pctNum(week))} sub="used" />
                <StatTile label="Today" value={money(a.usage?.today.cost ?? 0)} sub={`${tokens(a.usage?.today.tokens ?? 0)} tokens`} />
                <StatTile label="This week" value={money(a.usage?.week.cost ?? 0)} sub={`${tokens(a.usage?.week.tokens ?? 0)} tokens`} />
            </StatRow>
            <Section title="Access">
                <ReadField label="Auth"><Chip tone={authTone(a)}>{authLabel(a)}</Chip></ReadField>
                <ReadField label="Runs in">{a.has_token ? "any config dir" : a.logged_in ? <>only <code>{a.auth_dir}</code></> : "nowhere yet — set up a token"}</ReadField>
                <ReadField label="Browser login" hint={`A login in the account's own config dir serves environments using that dir; Log in (browser) adds one in ${a.browser_dir}, which serves every environment.`}>
                    {a.login_ok === null ? <Chip>unknown — probe</Chip> : a.login_ok ? <Chip tone="ok">in {a.login_dir ?? a.auth_dir}</Chip> : <Chip tone="bad">none</Chip>}
                </ReadField>
                <ReadField label="Chrome">{accountBrowserReady(a) ? <Chip tone="ok">ready{a.chrome_browser_name ? ` · ${a.chrome_browser_name}` : ""}</Chip> : <Chip>not ready</Chip>}</ReadField>
            </Section>
            <Section title="Usage">
                <ReadField label="CLI default model" hint="What claude picks for this account when no model is passed.">{a.default_model ?? "unknown"}</ReadField>
                <ReadField label="Rate-limit windows" hint={windowHint}>5 h {pct(five)} · 7 d {pct(week)}</ReadField>
                <ReadField label="Used by">{envs.filter((e) => accountOrderOf(e).includes(a.id)).map((e) => `${e.name} (#${accountOrderOf(e).indexOf(a.id) + 1})`).join(", ") || "no environment lists it"}</ReadField>
            </Section>
        </div>
    );
};

const AccountModelsTab = ({ a, settings, save, saving }: { a: Account; settings: Settings; save: (k: string, body: Parameters<typeof api.patchAccount>[1]) => Promise<void>; saving: string | null }) => {
    const d = useDraft<AccountModels>(() => a.models ?? { default: null, stages: {}, reruns: {}, operations: {} }, [a]);
    const m = d.value;
    const label = (v: string | null | undefined): string => (v ? modelLabel(v, settings.models) ?? v : "");
    const cliDefault = `the CLI's default (${label(a.default_model) || "?"})`;
    const defaultLabel = m.default ? label(m.default) : cliDefault;
    const options = (blank: string) => settings.models.map((o) => <option key={o.value} value={o.value}>{o.value === "" ? blank : o.label}</option>);
    const set = (part: "stages" | "reruns" | "operations", key: string, value: string) => d.patch({ [part]: { ...m[part], [key]: value || null } } as Partial<AccountModels>);
    const FALLBACK = "A task created with its own model uses that everywhere. A blank falls back along the arrow.";
    return (
        <EntityForm dirty={d.dirty} saving={saving === "models"} onDiscard={d.reset} onSave={() => save("models", { models: m })} extra={<Button onClick={() => void api.refreshModels()}>Refresh model list</Button>}>
            <Field label="Default" hint={`The fallback of every blank below. ${settings.modelsFetchedAt ? `Model list from the Models API, fetched ${new Date(settings.modelsFetchedAt).toLocaleString()}.` : "Built-in model list."}${settings.modelsError ? ` Last fetch failed: ${settings.modelsError}.` : ""}`}>
                <Select value={m.default ?? ""} onChange={(e) => d.patch({ default: e.target.value || null })}>{options(`→ ${cliDefault}`)}</Select>
            </Field>
            <Section title="Stages" hint={`First run: the stage's first run on a task. Reruns: every later run of it (a review round sent back, Retry, a contract or unblock retry, a QA return). ${FALLBACK}`}>
                <div className="model-grid">
                    <span className="mg-head">Stage</span>
                    <span className="mg-head">First run</span>
                    <span className="mg-head">Reruns</span>
                    {MODEL_STAGES.map((st) => (
                        <Fragment key={st.key}>
                            <span className="mg-label">{st.label}</span>
                            <Select aria-label={`${st.label} first run`} value={m.stages[st.key] ?? ""} onChange={(e) => set("stages", st.key, e.target.value)}>{options(`first run → default (${defaultLabel})`)}</Select>
                            <Select aria-label={`${st.label} reruns`} value={m.reruns[st.key] ?? ""} onChange={(e) => set("reruns", st.key, e.target.value)}>{options(`reruns → first run (${m.stages[st.key] ? label(m.stages[st.key]) : defaultLabel})`)}</Select>
                        </Fragment>
                    ))}
                </div>
            </Section>
            <Section title="Other operations" hint={FALLBACK}>
                <div className="model-single">
                    {MODEL_OPERATIONS.map((o) => (
                        <Fragment key={o.key}>
                            <span className="mg-label">{o.label}<Hint text={o.hint} /></span>
                            <Select aria-label={o.label} value={m.operations[o.key] ?? ""} onChange={(e) => set("operations", o.key, e.target.value)}>{options(o.key.startsWith("pr_fix") ? `→ PR Fix stage (${m.stages.pr_fix ? label(m.stages.pr_fix) : defaultLabel})` : `→ default (${defaultLabel})`)}</Select>
                        </Fragment>
                    ))}
                </div>
            </Section>
        </EntityForm>
    );
};

export const AccountPage = ({ a, envs, tasks, settings, tab, onTab, onBack, onChanged, onError, onTerminal }: { tab: string | undefined; onTab: (t: string) => void; a: Account; envs: Env[]; tasks: Task[]; settings: Settings | null; onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void; onTerminal: (name: string) => void }) => {
    const { saving, run } = useSaver(onError);
    const [notice, setNotice] = useState<Outcome>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const save = (k: string, body: Parameters<typeof api.patchAccount>[1]) => run(k, async () => {
        await api.patchAccount(a.id, body);
        await onChanged();
    });
    const check = async (key: string, start: string, fn: () => Promise<{ ok: boolean; detail: string }>) => {
        setBusy(key);
        setNotice({ ok: true, text: start, pending: true });
        try {
            const r = await fn();
            setNotice({ ok: r.ok, text: r.detail });
            await onChanged();
        } catch (e) {
            setNotice({ ok: false, text: errText(e) });
        } finally {
            setBusy(null);
        }
    };
    const terminal = async (fn: () => Promise<{ terminal: string }>) => {
        try {
            onTerminal((await fn()).terminal);
        } catch (e) {
            onError(errText(e));
        }
    };
    const used = envs.filter((e) => e.default_account_id === a.id).length + tasks.filter((t) => t.account_id === a.id).length;
    const noAuth = !a.has_token && !a.logged_in;
    const setupToken = () => void terminal(() => api.setupToken(a.id));
    const verify = () => void check("verify", "Running a trivial agent turn…", () => api.refreshAccount(a.id));
    return (
        <EntityView tab={tab} onTab={onTab}
            type="AI accounts"
            onType={onBack}
            id={a.name}
            notice={notice}
            meta={<><Chip tone={authTone(a)}>{authLabel(a)}</Chip>{a.plan && <Chip>{a.plan}</Chip>}</>}
            actions={
                <>
                    {noAuth ? <Button variant="primary" onClick={setupToken}>Set up token</Button> : <Button variant="primary" disabled={busy !== null} onClick={verify}>{busy === "verify" ? "Checking…" : "Verify"}</Button>}
                    <MoreMenu>
                        {(close) => (
                            <>
                                {!noAuth && <MenuItem onClick={() => { close(); setupToken(); }}>{a.has_token ? "Renew token" : "Set up token"}</MenuItem>}
                                {noAuth && <MenuItem disabled={busy !== null} onClick={() => { close(); verify(); }}>Verify</MenuItem>}
                                <MenuItem onClick={() => { close(); void terminal(() => api.loginAccount(a.id)); }}>Log in (browser)</MenuItem>
                                <hr />
                                <MenuItem disabled={busy !== null} onClick={() => { close(); void check("chrome", "Checking the browser login, then running a tiny --chrome agent…", () => api.probeAccountChrome(a.id)); }}>Probe Chrome</MenuItem>
                                <MenuItem disabled={busy !== null || !a.chrome_device_id} onClick={() => { close(); void check("clone", "Copying the profile, starting a Chrome on the copy, waiting for its extension…", () => api.testAccountClone(a.id)); }}>Test profile cloning</MenuItem>
                                {a.plan !== "enterprise" && a.logged_in === 1 && <MenuItem disabled={busy !== null || a.refreshing_limits} onClick={() => { close(); void check("limits", "Refreshing the rate-limit windows (one tiny Sonnet turn)…", () => api.refreshLimits(a.id)); }}>{a.refreshing_limits ? "Refreshing limits…" : "Refresh limits"}</MenuItem>}
                            </>
                        )}
                    </MoreMenu>
                    <Button variant="danger" disabled={used > 0} title={used > 0 ? "An environment or task still uses it" : undefined} onClick={() => { if (confirm(`Forget account ${a.name} and its stored token?`)) void run("delete", async () => { await api.deleteAccount(a.id); await onChanged(); onBack(); }); }}>Delete</Button>
                </>
            }
            tabs={[
                { key: "general", label: "General", content: <AccountGeneralTab a={a} save={save} saving={saving} /> },
                { key: "status", label: "Status", content: <AccountStatusTab a={a} envs={envs} /> },
                ...(settings ? [{ key: "models", label: "Models", content: <AccountModelsTab a={a} settings={settings} save={save} saving={saving} /> }] : []),
            ]}
        />
    );
};

// ---------- Integrations ----------

export type IntegrationType = "task manager" | "notifications" | "decision model" | "documents";

const TaskManagerForm = ({ m, onSaved, onError }: { m: TaskManager; onSaved: () => Promise<void>; onError: (m: string) => void }) => {
    const { saving, run } = useSaver(onError);
    const d = useDraft(() => ({ token: "", teamId: m.teamId ?? "" }), [m]);
    return (
        <EntityForm dirty={d.dirty} saving={saving === "save"} onDiscard={d.reset} onSave={() => run("save", async () => {
            await api.patchTaskManager(m.source, { ...(d.value.token ? { token: d.value.token } : {}), ...(m.source === "clickup" ? { teamId: d.value.teamId || null } : {}) });
            await onSaved();
        })}>
            <ReadField label="Used by">{m.envs.join(", ") || "no environment yet"}</ReadField>
            <Field label={m.source === "clickup" ? "Personal API token" : "API key"} hint="Stored in ~/.vortex/config.json. With a token, tickets are fetched server-side (fast, no Claude run); without one, Research fetches them through the account's MCP. Empty: unchanged.">
                <Input value={d.value.token} onChange={(e) => d.patch({ token: e.target.value })} placeholder={m.token ?? (m.source === "clickup" ? "pk_…" : "lin_api_…")} />
            </Field>
            {m.source === "clickup" && <Field label="Team id"><Input value={d.value.teamId} onChange={(e) => d.patch({ teamId: e.target.value })} /></Field>}
        </EntityForm>
    );
};

const TokenIntegrationForm = ({ state, onSaved, onError }: { state: TokenIntegration; onSaved: () => Promise<void>; onError: (m: string) => void }) => {
    const { saving, run } = useSaver(onError);
    const d = useDraft(() => ({ token: "" }), [state]);
    const def = TOKEN_INTEGRATIONS.find((x) => x.id === state.id)!;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "save"} onDiscard={d.reset} onSave={() => run("save", async () => { await api.setTokenIntegration(state.id, d.value.token); await onSaved(); })}>
            <Field label="Token" hint={def.hint}><Input value={d.value.token} onChange={(e) => d.patch({ token: e.target.value })} placeholder={state.token ?? def.placeholder} /></Field>
        </EntityForm>
    );
};

const NotificationsForm = ({ settings, onChanged, onError }: { settings: Settings; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const { saving, run } = useSaver(onError);
    const n = settings.notifications;
    const d = useDraft(() => ({ macos: n.macos, ntfyServer: n.ntfyServer, ntfyTopic: n.ntfyTopic ?? "", ntfyToken: "", baseUrl: n.baseUrl ?? "", localBaseUrl: n.localBaseUrl ?? "http://localhost:5173" }), [settings]);
    const v = d.value;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "save"} onDiscard={d.reset} onSave={() => run("save", async () => {
            await api.patchSettings({ notifications: { macos: v.macos, ntfyServer: v.ntfyServer, ntfyTopic: v.ntfyTopic || null, ...(v.ntfyToken ? { ntfyToken: v.ntfyToken } : {}), baseUrl: v.baseUrl || null, localBaseUrl: v.localBaseUrl || "http://localhost:5173" } });
            await onChanged();
        })}>
            <CheckField label={`macOS notification centre on this Mac (${settings.desktopNotifier})`} hint="Sent whenever a task starts waiting on you: review needed, blocked, failed, or parked on a rate limit — once per distinct reason." checked={v.macos} onChange={(on) => d.patch({ macos: on })} />
            <Field label="URL of this UI on this Mac" hint="A click on the desktop notification opens the task there."><Input value={v.localBaseUrl} onChange={(e) => d.patch({ localBaseUrl: e.target.value })} /></Field>
            <Field label="ntfy topic" hint="For pushes to the phone: install the ntfy app, subscribe to a private, hard-to-guess topic name (e.g. vortex-7f3a9c) and enter it here. Empty: no phone pushes."><Input value={v.ntfyTopic} onChange={(e) => d.patch({ ntfyTopic: e.target.value })} /></Field>
            <Field label="ntfy server"><Input value={v.ntfyServer} onChange={(e) => d.patch({ ntfyServer: e.target.value })} /></Field>
            <Field label="ntfy access token" hint="Only for protected topics or self-hosted servers. Empty: unchanged."><Input value={v.ntfyToken} onChange={(e) => d.patch({ ntfyToken: e.target.value })} placeholder={n.ntfyToken ?? "not set"} /></Field>
            <Field label="Public URL of this UI" hint="Links in phone pushes open the task there."><Input value={v.baseUrl} onChange={(e) => d.patch({ baseUrl: e.target.value })} placeholder="https://your-host:4748" /></Field>
        </EntityForm>
    );
};

const JevForm = ({ settings, onChanged, onError }: { settings: Settings; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const { saving, run } = useSaver(onError);
    const d = useDraft(() => ({ key: "" }), [settings]);
    return (
        <EntityForm dirty={d.dirty} saving={saving === "save"} onDiscard={d.reset} onSave={() => run("save", async () => { await api.patchSettings({ typesafeApiKey: d.value.key.trim() }); await onChanged(); })}>
            <Field label="TypeSafe API key" hint="Jev answers typed questions (yes/no, choice, score) with calibrated probabilities, sub-second — for the engine's small judgments (CI failure triage, QA blocker kinds, comment routing). Without a key every Jev-backed judgment falls back to built-in heuristics. Calls show in Analytics as kind jev. Empty: unchanged."><Input value={d.value.key} onChange={(e) => d.patch({ key: e.target.value })} placeholder={settings.typesafeApiKey ?? "apikey_…"} /></Field>
        </EntityForm>
    );
};

export const IntegrationPage = ({ id, settings, tab, onTab, onBack, onChanged, onError }: { tab: string | undefined; onTab: (t: string) => void; id: string; settings: Settings | null; onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const [managers, setManagers] = useState<TaskManager[] | null>(null);
    const [tokenStates, setTokenStates] = useState<TokenIntegration[] | null>(null);
    const [notice, setNotice] = useState<Outcome>(null);
    const [busy, setBusy] = useState(false);
    const load = async (): Promise<void> => {
        await Promise.all([api.taskManagers().then(setManagers), Promise.all(TOKEN_INTEGRATIONS.map((t) => api.tokenIntegration(t.id))).then(setTokenStates)]).catch((e: Error) => onError(e.message));
    };
    useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const attempt = async (start: string, fn: () => Promise<Outcome>) => {
        setBusy(true);
        setNotice({ ok: true, text: start, pending: true });
        try {
            setNotice(await fn());
        } catch (e) {
            setNotice({ ok: false, text: errText(e) });
        } finally {
            setBusy(false);
        }
    };
    const m = id.startsWith("tm:") ? managers?.find((x) => `tm:${x.source}` === id) : undefined;
    const state = (configured: boolean, no = "no token") => <Chip tone={configured ? "ok" : "neutral"}>{configured ? "configured" : no}</Chip>;
    if (id.startsWith("tm:") && !m) return <Loading />;
    if (m) {
        return (
            <EntityView tab={tab} onTab={onTab} type="Integrations" onType={onBack} id={m.label} notice={notice} meta={state(m.configured)}
                actions={<>
                    <Button variant="primary" disabled={!m.configured || busy} onClick={() => void attempt("Testing…", async () => { const r = await api.testTaskManager(m.source); return r.ok ? { ok: true, text: `OK — ${r.count} ticket(s) assigned to you${r.sample?.length ? `: ${r.sample.join(" · ")}` : ""}` } : { ok: false, text: `Failed: ${r.error}` }; })}>{busy ? "Testing…" : "Test"}</Button>
                    <Button variant="danger" disabled={!m.configured} onClick={() => { if (confirm(`Remove the ${m.label} token?`)) void api.patchTaskManager(m.source, { token: null }).then(load); }}>Remove token</Button>
                </>}
                tabs={[{ key: "settings", label: "Settings", content: <TaskManagerForm m={m} onSaved={load} onError={onError} /> }]} />
        );
    }
    const tokenDef = TOKEN_INTEGRATIONS.find((t) => t.id === id);
    if (tokenDef) {
        const token = tokenStates?.find((t) => t.id === tokenDef.id);
        if (!token) return <Loading />;
        return (
            <EntityView tab={tab} onTab={onTab} type="Integrations" onType={onBack} id={tokenDef.name} meta={state(token.configured)}
                actions={<Button variant="danger" disabled={!token.configured} onClick={() => { if (confirm(`Remove the ${tokenDef.name} token?`)) void api.setTokenIntegration(token.id, null).then(load); }}>Remove token</Button>}
                tabs={[{ key: "settings", label: "Settings", content: <TokenIntegrationForm state={token} onSaved={load} onError={onError} /> }]} />
        );
    }
    if (!settings) return <Loading />;
    if (id === "notifications") {
        return (
            <EntityView tab={tab} onTab={onTab} type="Integrations" onType={onBack} id="Notifications" notice={notice} meta={<Chip tone="ok">{settings.notifications.ntfyTopic ? "phone via ntfy" : "desktop only"}</Chip>}
                actions={<Button variant="primary" disabled={busy} onClick={() => void attempt("Sending…", async () => { const r = await api.testNotification(); return { ok: !r.error, text: `Desktop ${r.macos ? "sent" : "off"} · phone ${r.ntfy === null ? "not configured" : r.ntfy ? "sent" : `failed: ${r.error ?? "?"}`}` }; })}>{busy ? "Sending…" : "Send a test"}</Button>}
                tabs={[{ key: "settings", label: "Settings", content: <NotificationsForm settings={settings} onChanged={onChanged} onError={onError} /> }]} />
        );
    }
    if (id === "jev") {
        const configured = Boolean(settings.typesafeApiKey);
        return (
            <EntityView tab={tab} onTab={onTab} type="Integrations" onType={onBack} id="Jev (TypeSafe AI)" notice={notice} meta={state(configured, "no key")}
                actions={<>
                    <Button variant="primary" disabled={!configured || busy} onClick={() => void attempt("Asking Jev to triage a sample CI failure…", async () => { const r = await api.testJev(); return r.ok ? { ok: true, text: `OK — ${r.model} answered in ${r.ms} ms (${r.inputTokens} input tokens): ${r.summary}` } : { ok: false, text: `Failed: ${r.error}` }; })}>{busy ? "Testing…" : "Test"}</Button>
                    <Button variant="danger" disabled={!configured} onClick={() => { if (confirm("Remove the TypeSafe API key?")) void api.patchSettings({ typesafeApiKey: null }).then(onChanged); }}>Remove key</Button>
                </>}
                tabs={[{ key: "settings", label: "Settings", content: <JevForm settings={settings} onChanged={onChanged} onError={onError} /> }]} />
        );
    }
    return <EmptyState title="No such integration" action={<Button onClick={onBack}>Back to integrations</Button>} />;
};

// ---------- Prompter (a singleton: its settings view) ----------

export const PrompterPage = ({ settings, accounts, tab, onTab, onChanged, onError }: { tab: string | undefined; onTab: (t: string) => void; settings: Settings; accounts: Account[]; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const p: PrompterSettings = settings.prompter ?? { accountId: null, model: "fable", idleHours: 24, purgeDays: 7, farewell: true, maxTurns: 40, seedFrom: "", seedWings: [] };
    const [status, setStatus] = useState<PrompterStatus | null>(null);
    const [notice, setNotice] = useState<Outcome>(null);
    const [seeding, setSeeding] = useState(false);
    const { saving, run } = useSaver(onError);
    const refresh = async () => setStatus(await api.prompterStatus().catch(() => null));
    useEffect(() => { void refresh(); }, []);
    const d = useDraft(() => ({ accountId: p.accountId ?? "", model: p.model, idleHours: String(p.idleHours), purgeDays: String(p.purgeDays), farewell: p.farewell }), [settings]);
    const v = d.value;
    const tokenAccounts = accounts.filter((a) => a.has_token);
    const general = (
        <EntityForm dirty={d.dirty} saving={saving === "save"} onDiscard={d.reset} onSave={() => run("save", async () => {
            const idle = Number(v.idleHours);
            const purge = Number(v.purgeDays);
            await api.patchSettings({ prompter: { accountId: v.accountId || null, model: v.model, farewell: v.farewell, ...(Number.isFinite(idle) && idle > 0 ? { idleHours: idle } : {}), ...(Number.isFinite(purge) && purge > 0 ? { purgeDays: purge } : {}) } });
            await onChanged();
            await refresh();
        })}>
            <ReadField label="Status" hint={`The assistant in the bottom-right corner. It runs headless on a token account, in its own config dir with its own MemPalace under ${status?.home ?? "~/.vortex/prompter"}; every chat is a session of its own and the palace is its memory between chats. It sees the current page with every message and acts through the local API. Usage shows in Analytics as kind prompter.`}>
                {status ? (status.ready ? <Chip tone="ok">ready</Chip> : <><Chip tone="bad">not ready</Chip> {status.reason}</>) : <Chip>checking…</Chip>}
                {status && status.open > 0 && <Chip>{status.open} open chat{status.open === 1 ? "" : "s"}</Chip>}
            </ReadField>
            <Field label="AI account">
                <Select value={v.accountId} onChange={(e) => d.patch({ accountId: e.target.value })}>
                    <option value="">— first account with a token{status?.account ? ` (${status.account})` : ""} —</option>
                    {tokenAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
            </Field>
            <Field label="Default model" hint="The window's own model select overrides it for the next new chat.">
                <Select value={v.model} onChange={(e) => d.patch({ model: e.target.value })}>{settings.models.filter((m) => m.value).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>
            </Field>
            <Field label="End an idle chat after (hours)" hint="Without activity — a message, or an open window. A server restart never ends a chat: the window re-attaches, and a turn that died with the server is sent again."><Input value={v.idleHours} onChange={(e) => d.patch({ idleHours: e.target.value })} /></Field>
            <Field label="Remove closed chats after (days)" hint="Their messages and per-turn logs."><Input value={v.purgeDays} onChange={(e) => d.patch({ purgeDays: e.target.value })} /></Field>
            <CheckField label="Farewell turn" hint="Before a chat ends, one short turn lets it file what is not filed yet." checked={v.farewell} onChange={(on) => d.patch({ farewell: on })} />
        </EntityForm>
    );
    const palace = (
        <div className="ev-fields">
            <ReadField label="Palace" hint={`Seeding copies the Vortex knowledge (wings ${p.seedWings.join(", ")} and the diary entries about it) from ${p.seedFrom}. Re-running only adds what is missing.`}>
                {status?.seeded ? <>seeded {new Date(status.seeded.at).toLocaleString()} · {status.seeded.total} drawer(s)</> : "not seeded yet"}
            </ReadField>
        </div>
    );
    return (
        <EntityView tab={tab} onTab={onTab} type="Prompter" notice={notice}
            actions={<>
                <Button variant={status?.seeded ? "default" : "primary"} disabled={seeding} onClick={async () => { setSeeding(true); setNotice({ ok: true, text: "Copying drawers…", pending: true }); try { const r = await api.prompterSeed(); setNotice({ ok: r.ok, text: r.detail }); await refresh(); } catch (e) { setNotice({ ok: false, text: errText(e) }); } finally { setSeeding(false); } }}>{seeding ? "Seeding…" : status?.seeded ? "Seed again" : "Seed the palace"}</Button>
                <Button variant="ghost" onClick={() => void refresh()}>Refresh</Button>
            </>}
            tabs={[{ key: "general", label: "General", content: general }, { key: "palace", label: "Palace", content: palace }]} />
    );
};
