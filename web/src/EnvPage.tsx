import { useEffect, useState } from "react";
import { accountOrderOf, accountUsableWith, api, autopilotRulesOf, AUTOPILOT_KINDS, componentsOf, reviewChecklistOf, taskDbConfigOf, type Account, type AutopilotRules, type ClaudeMdFile, type ConfigDir, type Env, type EnvComponent, type EnvRules, type QaAutoFixScope, type ReviewCategoryDef, type ReviewPass, type TaskDbConfig } from "./api";
import { CheckField, EntityForm, EntityView, Field, Hint, ReadField, useDraft, useSaver } from "./components/EntityView";

// An environment's entity view: one tab per area of its configuration (components/EntityView.tsx).

const splitRepos = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
const joinRepos = (json: string | null): string => {
    try {
        const v: unknown = json ? JSON.parse(json) : [];
        return Array.isArray(v) ? v.join(", ") : "";
    } catch {
        return "";
    }
};
const nul = (s: string) => (s.trim() === "" ? null : s);
const list = (json: string | null | undefined): string => {
    try {
        return (JSON.parse(json ?? "[]") as string[]).join(", ");
    } catch {
        return "";
    }
};
const csv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

type Patch = Parameters<typeof api.patchEnv>[1];
type Common = { env: Env; save: (key: string, body: Patch) => Promise<void>; saving: string | null };

const PLACEHOLDERS = "Placeholders: {{port}}, {{url}}, {{bePort}}, {{beUrl}} (FE only), {{worktree}}, {{taskDir}}, {{envPath}} (setup only). Commands run from the task's worktree in tmux.";

// ---------- General ----------
const GeneralTab = ({ env, envs, save, saving }: Common & { envs: Env[] }) => {
    const d = useDraft(() => ({ name: env.name, repos: joinRepos(env.repos), baseBranch: env.base_branch, ticketSource: env.ticket_source as "clickup" | "linear", dependsOn: env.depends_on_env_id ?? "" }), [env]);
    const v = d.value;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "general"} onDiscard={d.reset} onSave={() => save("general", { name: v.name, baseBranch: v.baseBranch, repos: splitRepos(v.repos).length ? splitRepos(v.repos) : null, ticketSource: v.ticketSource, dependsOnEnvId: v.dependsOn || null })}>
            <ReadField label="Path">{<code>{env.path}</code>}</ReadField>
            <Field label="Name"><input value={v.name} onChange={(e) => d.patch({ name: e.target.value })} /></Field>
            <Field label="Sub-repositories" hint="Comma-separated directories of the path that are git repositories. Empty: the path itself is the git repository."><input value={v.repos} onChange={(e) => d.patch({ repos: e.target.value })} placeholder="backend, frontend" /></Field>
            <Field label="Base branch"><input value={v.baseBranch} onChange={(e) => d.patch({ baseBranch: e.target.value })} /></Field>
            <Field label="Task system" hint="How bare ticket ids like ABC-123 are resolved.">
                <select value={v.ticketSource} onChange={(e) => d.patch({ ticketSource: e.target.value as "clickup" | "linear" })}><option value="clickup">ClickUp</option><option value="linear">Linear</option></select>
            </Field>
            <Field label="Depends on" hint="Another environment whose backend this app calls out to and cannot work without (e.g. Deal needs Core for auth). Started once — by the first task that needs it — and shared by every task of this environment; it keeps its own checkout and branch. Its configured port is tried first.">
                <select value={v.dependsOn} onChange={(e) => d.patch({ dependsOn: e.target.value })}>
                    <option value="">— none —</option>
                    {envs.filter((e) => e.id !== env.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
            </Field>
        </EntityForm>
    );
};

// ---------- Agents: config dir, AI accounts, memory ----------
const AgentsTab = ({ env, save, saving, accounts, configDirs, info, onOpenDir }: Common & { accounts: Account[]; configDirs: ConfigDir[]; info: EnvRules | null; onOpenDir: (id: string) => void }) => {
    const d = useDraft(() => ({ dirId: env.config_dir_id ?? "", order: accountOrderOf(env) }), [env]);
    const v = d.value;
    const move = (id: string, delta: number) => {
        const o = [...v.order];
        const i = o.indexOf(id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= o.length) return;
        [o[i], o[j]] = [o[j]!, o[i]!];
        d.patch({ order: o });
    };
    const toggle = (id: string) => d.patch({ order: v.order.includes(id) ? v.order.filter((x) => x !== id) : [...v.order, id] });
    const dirPath = configDirs.find((x) => x.id === v.dirId)?.path ?? info?.configDir.path ?? "";
    const listed = v.order.map((id) => accounts.find((a) => a.id === id)).filter((a): a is Account => !!a);
    const runnable = (listed.length ? listed : accounts).filter((a) => (dirPath ? accountUsableWith(a, dirPath) : a.logged_in === 1));
    return (
        <EntityForm dirty={d.dirty} saving={saving === "agents"} onDiscard={d.reset} onSave={() => save("agents", { configDirId: nul(v.dirId), accountOrder: v.order })}>
            <Field label="Config dir" hint="Every agent run of this environment (research, design, QA, implementation, helpers, the terminal) uses it: its skills, hooks, subagents, MCP servers, CLAUDE.md and the commit, branch and PR rules.">
                <select value={v.dirId} onChange={(e) => d.patch({ dirId: e.target.value })}>
                    <option value="">— server default —</option>
                    {configDirs.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.path}</option>)}
                </select>
                {v.dirId && <button className="tiny" style={{ marginTop: 6 }} onClick={() => onOpenDir(v.dirId)}>Open config dir</button>}
            </Field>
            <Field label="AI accounts" hint="In priority order: tick to include, arrows to reorder. Runs go to the first listed account that is not exhausted; when it hits its rate limit the next one takes over. Empty: any account that can run in the config dir.">
                <div className="field-rows">
                    {[...v.order.map((id) => accounts.find((a) => a.id === id)).filter((a): a is Account => !!a), ...accounts.filter((a) => !v.order.includes(a.id))].map((a) => {
                        const i = v.order.indexOf(a.id);
                        const ok = dirPath ? accountUsableWith(a, dirPath) : a.logged_in === 1;
                        return (
                            <div key={a.id} className={`account-row ${i >= 0 ? "on" : ""}`}>
                                <label className="inline"><input type="checkbox" checked={i >= 0} onChange={() => toggle(a.id)} /> {i >= 0 ? <b>{i + 1}.</b> : null} {a.name}</label>
                                {a.plan && <span className="chip">{a.plan}</span>}
                                {!ok && <span className="chip warn">{a.logged_in ? "needs a token" : "no auth"}</span>}
                                {i >= 0 && (
                                    <span className="order-buttons">
                                        <button disabled={i === 0} onClick={() => move(a.id, -1)} aria-label="higher priority">▲</button>
                                        <button disabled={i === v.order.length - 1} onClick={() => move(a.id, 1)} aria-label="lower priority">▼</button>
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </Field>
            {info && runnable.length === 0 && <ReadField label="Warning"><span className="chip bad">no {listed.length ? "listed " : ""}account can run in this config dir — set up a token on the account</span></ReadField>}
        </EntityForm>
    );
};

// ---------- CLAUDE.md files of the repositories (the config dir's own is edited on the config dir) ----------
const ClaudeMdTab = ({ env, onError }: { env: Env; onError: (m: string) => void }) => {
    const [files, setFiles] = useState<ClaudeMdFile[] | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const { saving, run } = useSaver(onError);
    useEffect(() => {
        setFiles(null);
        setDrafts({});
        void api.envClaudeMd(env.id).then((r) => setFiles(r.files)).catch((e: Error) => onError(e.message));
    }, [env.id, onError]);
    const changed = (files ?? []).filter((f) => drafts[f.id] !== undefined && drafts[f.id] !== f.content);
    if (!files) return <div className="empty">reading…</div>;
    return (
        <EntityForm dirty={changed.length > 0} saving={saving === "md"} onDiscard={() => setDrafts({})} onSave={() => run("md", async () => {
            for (const f of changed) {
                const r = await api.saveClaudeMd(env.id, f.id, drafts[f.id]!);
                setFiles((fs) => (fs ?? []).map((x) => (x.id === f.id ? r.file : x)));
            }
            setDrafts({});
        })}>
            {files.map((f) => (
                <Field key={f.id} label={<>{f.label} <code>{f.path}</code>{!f.exists && <span className="chip warn">none yet — saving creates it</span>}</>} hint="Committed in git: a task sees an edit once it is on the base branch, and saving here changes the main checkout's working tree. The config dir's own CLAUDE.md is on the config dir.">
                    <textarea className="tall" spellCheck={false} value={drafts[f.id] ?? f.content} onChange={(e) => setDrafts((x) => ({ ...x, [f.id]: e.target.value }))} />
                </Field>
            ))}
        </EntityForm>
    );
};

// ---------- App: how the app is started and reached ----------
const AppTab = ({ env, save, saving }: Common) => {
    const d = useDraft(() => ({
        appUrl: env.app_url ?? "", bePort: env.be_port ? String(env.be_port) : "", fePort: env.fe_port ? String(env.fe_port) : "", beUrlTemplate: env.be_url_template ?? "", feUrlTemplate: env.fe_url_template ?? "",
        beCommand: env.be_command ?? "", feCommand: env.fe_command ?? "", keepServices: env.keep_services === 1, comps: componentsOf(env),
        callbackPorts: ((): string => { try { return (JSON.parse(env.callback_ports ?? "[]") as Array<{ port: number; relay?: boolean }>).map((p) => `${p.port}${p.relay ? "*" : ""}`).join(", "); } catch { return ""; } })(),
    }), [env]);
    const v = d.value;
    const setComp = (i: number, p: Partial<EnvComponent>) => d.patch({ comps: v.comps.map((c, j) => (j === i ? { ...c, ...p } : c)) });
    return (
        <EntityForm dirty={d.dirty} saving={saving === "app"} onDiscard={d.reset} onSave={() => save("app", {
            appUrl: nul(v.appUrl), beCommand: nul(v.beCommand), feCommand: nul(v.feCommand), beUrlTemplate: nul(v.beUrlTemplate), feUrlTemplate: nul(v.feUrlTemplate),
            bePort: v.bePort.trim() ? Number(v.bePort) : null, fePort: v.fePort.trim() ? Number(v.fePort) : null, keepServices: v.keepServices,
            components: v.comps.filter((c) => c.key.trim() && c.command.trim()).map((c) => ({ ...c, key: c.key.trim(), label: c.label.trim() || c.key.trim() })),
            callbackPorts: v.callbackPorts.split(",").map((x) => x.trim()).filter((x) => /^\d+\*?$/.test(x)).map((x) => ({ port: Number(x.replace("*", "")), relay: x.endsWith("*") })),
        })}>
            <Field label="BE command" hint={PLACEHOLDERS}><textarea spellCheck={false} value={v.beCommand} onChange={(e) => d.patch({ beCommand: e.target.value })} /></Field>
            <Field label="FE command" hint={PLACEHOLDERS}><textarea spellCheck={false} value={v.feCommand} onChange={(e) => d.patch({ feCommand: e.target.value })} /></Field>
            <Field label="BE fixed port" hint="Empty: a free port is picked per task."><input value={v.bePort} onChange={(e) => d.patch({ bePort: e.target.value })} /></Field>
            <Field label="FE fixed port" hint="Empty: a free port is picked per task."><input value={v.fePort} onChange={(e) => d.patch({ fePort: e.target.value })} /></Field>
            <Field label="BE URL template"><input value={v.beUrlTemplate} onChange={(e) => d.patch({ beUrlTemplate: e.target.value })} placeholder="http://localhost:{{port}}" /></Field>
            <Field label="FE URL template"><input value={v.feUrlTemplate} onChange={(e) => d.patch({ feUrlTemplate: e.target.value })} placeholder="http://localhost:{{port}}" /></Field>
            <Field label="App URL override" hint="The URL QA and the login helper open. Empty: the FE's URL, else the BE's. Otherwise {{feUrl}}, {{beUrl}} or a fixed URL."><input value={v.appUrl} onChange={(e) => d.patch({ appUrl: e.target.value })} /></Field>
            <Field label="Login callback ports" hint="The identity provider accepts only these as its callback, e.g. 3000; after a login on a task's port, Stagehand moves the tab back to the task's app. Add * to have Stagehand hold the port and redirect for any browser, e.g. 7777*. Comma-separated."><input value={v.callbackPorts} onChange={(e) => d.patch({ callbackPorts: e.target.value })} /></Field>
            <CheckField label="Keep a task's BE/FE running between stages" hint="Overrides the Resources page's policies for this environment: instead of stopping them after every QA pass, they keep running until the task is done or cleaned up. Saves the cold start at the cost of RAM." checked={v.keepServices} onChange={(on) => d.patch({ keepServices: on })} />
            <Field label="Optional components" hint="Extra services beside the BE/FE — a queue worker, a scheduler, a relay. Each runs in its own tmux session from the task's worktree, without a port. Started from the App widget, by agents on demand, by a QA scenario that declares it, or with the app when auto-start is on. Placeholders: {{worktree}}, {{beUrl}}, {{bePort}}, {{taskDir}}.">
                <div className="field-rows">
                    {v.comps.map((c, i) => (
                        <div className="component-row" key={i}>
                            <input value={c.key} placeholder="key — e.g. worker" onChange={(e) => setComp(i, { key: e.target.value })} />
                            <input value={c.label} placeholder="label — e.g. Celery worker" onChange={(e) => setComp(i, { label: e.target.value })} />
                            <label className="inline"><input type="checkbox" checked={c.autoStart} onChange={(e) => setComp(i, { autoStart: e.target.checked })} /> auto-start</label>
                            <button className="tiny danger" onClick={() => d.patch({ comps: v.comps.filter((_, j) => j !== i) })}>remove</button>
                            <textarea value={c.command} placeholder="command (runs from the worktree)" onChange={(e) => setComp(i, { command: e.target.value })} />
                        </div>
                    ))}
                    <button className="tiny" style={{ justifySelf: "start" }} onClick={() => d.patch({ comps: [...v.comps, { key: "", label: "", command: "", autoStart: false }] })}>+ component</button>
                </div>
            </Field>
        </EntityForm>
    );
};

// ---------- Lifecycle: what runs around a task ----------
const LifecycleTab = ({ env, save, saving }: Common) => {
    const d = useDraft(() => ({
        envVars: env.env_vars ?? "", prepareCommand: env.prepare_command ?? "", setupCommand: env.setup_command ?? "", migrateCommand: env.migrate_command ?? "", migrateDownCommand: env.migrate_down_command ?? "",
        cleanupCommand: env.cleanup_command ?? "", rebaseCommand: env.rebase_command ?? "", checkCommand: env.check_command ?? "", testCommand: env.test_command ?? "",
    }), [env]);
    const v = d.value;
    const area = (k: keyof typeof v, tall = false) => <textarea className={tall ? "tall" : undefined} spellCheck={false} value={v[k]} onChange={(e) => d.patch({ [k]: e.target.value } as Partial<typeof v>)} />;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "lifecycle"} onDiscard={d.reset} onSave={() => save("lifecycle", {
            envVars: nul(v.envVars), prepareCommand: nul(v.prepareCommand), setupCommand: nul(v.setupCommand), migrateCommand: nul(v.migrateCommand), migrateDownCommand: nul(v.migrateDownCommand),
            cleanupCommand: nul(v.cleanupCommand), rebaseCommand: nul(v.rebaseCommand), checkCommand: nul(v.checkCommand), testCommand: nul(v.testCommand),
        })}>
            <Field label="Environment variables" hint="KEY=VALUE per line; exported into git, setup, BE/FE, Claude runs and the terminal. Lines starting with # are comments.">{area("envVars")}</Field>
            <Field label="Prepare" hint="Bash that runs before every command of this environment — setup, BE, FE, components, migrate, cleanup, rebase, verification — e.g. bring up the datastores it needs. A non-zero exit stops the command.">{area("prepareCommand", true)}</Field>
            <Field label="Worktree setup" hint="Runs once after a task's worktree is created. {{worktree}} / {{envPath}}.">{area("setupCommand", true)}</Field>
            <Field label="Migrate" hint="Brings the database up to the worktree's code. Runs from the worktree before every BE start. {{worktree}} / {{envPath}}.">{area("migrateCommand")}</Field>
            <Field label="Migrate down" hint="Rolls back the migrations the branch added, to the base. {{baseRef}} = the base commit of the root repository, {{baseRef:<dir>}} of a sub-repository; also $STAGEHAND_BASE_REF and $STAGEHAND_BASE_REF_<DIR>.">{area("migrateDownCommand")}</Field>
            <Field label="Cleanup" hint="Runs from the worktree when a task is cleaned up, after BE/FE stop and before the worktree is removed — drop a per-task database, free caches. {{worktree}} / {{envPath}}.">{area("cleanupCommand")}</Field>
            <Field label="Rebase" hint="Runs from the worktree after every successful rebase onto the base branch — rebuild what a rebase makes stale, e.g. per-task test databases. {{worktree}} / {{envPath}}.">{area("rebaseCommand")}</Field>
            <Field label="Verification" hint="Runs from the worktree after every Implementation and PR Fix run. A non-zero exit sends the output back to the agent, twice, then blocks for you. For what tests and a dev server never exercise, e.g. a framework's system checks.">{area("checkCommand")}</Field>
            <Field label="Test command" hint="Runs named tests. {{tests}} = the test ids, {{envPath}}. The CI autopilot runs it on a checkout of the base to prove an untouched failing test passes there when CI has no green run on the base.">{area("testCommand")}</Field>
        </EntityForm>
    );
};

// ---------- Database: the host guard and the task databases' config ----------
const DatabaseTab = ({ env, save, saving }: Common) => {
    const d = useDraft(() => {
        const c = taskDbConfigOf(env);
        return { dbHostsCommand: env.db_hosts_command ?? "", allowedDbHosts: list(env.allowed_db_hosts), c, shared: c.sharedNames.join(", ") };
    }, [env]);
    const v = d.value;
    const setC = (p: Partial<TaskDbConfig>) => d.patch({ c: { ...v.c, ...p } });
    const setTpl = (i: number, p: Partial<TaskDbConfig["extraTemplates"][number]>) => setC({ extraTemplates: v.c.extraTemplates.map((t, j) => (j === i ? { ...t, ...p } : t)) });
    const area = (k: "create" | "drop" | "connect" | "list", tall = false) => <textarea className={tall ? "tall" : undefined} spellCheck={false} value={v.c[k]} onChange={(e) => setC({ [k]: e.target.value })} />;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "database"} onDiscard={d.reset} onSave={() => {
            const c = v.c;
            const empty = !c.enabled && !c.template.trim() && !c.create.trim() && !c.drop.trim() && !c.connect.trim() && !c.list.trim();
            const extraTemplates = c.extraTemplates.map((t) => ({ template: t.template.trim(), copies: t.copies.map((x) => x.trim()).filter(Boolean), refresh: t.refresh })).filter((t) => t.template);
            return save("database", {
                dbHostsCommand: nul(v.dbHostsCommand), allowedDbHosts: csv(v.allowedDbHosts),
                taskDb: empty ? null : { ...c, template: c.template.trim(), namePattern: c.namePattern.trim(), sharedNames: csv(v.shared), extraTemplates },
            });
        }}>
            <Field label="DB host check" hint="Prints the databases the worktree's app would connect to, as host/name pairs. Stagehand runs it before agent runs, BE/FE/component starts and migrations, and blocks the task when a host is not allowed, or — with task databases on — a name is not the task's own or shared."><textarea className="tall" spellCheck={false} value={v.dbHostsCommand} onChange={(e) => d.patch({ dbHostsCommand: e.target.value })} /></Field>
            <Field label="Allowed DB hosts" hint="Comma-separated. Empty: localhost, 127.0.0.1, ::1."><input value={v.allowedDbHosts} onChange={(e) => d.patch({ allowedDbHosts: e.target.value })} /></Field>
            <CheckField label="New tasks get their own database" hint="Every task gets a database copied from the template when it starts, so one task's migrations, seeds and baseline never reach another. The template is first migrated to the base branch in a template worktree. Existing tasks keep the shared database until adopted (the task's Database widget). Commands get $STAGEHAND_TASK_DB and $STAGEHAND_TASK_DB_TEMPLATE." checked={v.c.enabled} onChange={(on) => setC({ enabled: on })} />
            <Field label="Template database" hint="Copied for every task; nothing may be connected to it while a copy runs."><input value={v.c.template} onChange={(e) => setC({ template: e.target.value })} placeholder="e.g. app or app_template" /></Field>
            <Field label="Name pattern" hint="{{template}}, {{slug}} = the ticket id. Default {{template}}_{{slug}}."><input value={v.c.namePattern} onChange={(e) => setC({ namePattern: e.target.value })} placeholder="{{template}}_{{slug}}" /></Field>
            <Field label="Create" hint="Copies $STAGEHAND_TASK_DB_TEMPLATE into $STAGEHAND_TASK_DB — e.g. CREATE DATABASE … TEMPLATE ….">{area("create", true)}</Field>
            <Field label="Drop" hint="Drops $STAGEHAND_TASK_DB; must succeed when it does not exist. On Clean up / Delete it runs for the task's database and for every listed database derived from it (<name>_…).">{area("drop")}</Field>
            <Field label="Connect" hint="Runs in a worktree: points the app's config at $STAGEHAND_TASK_DB — e.g. the database name in its .env.">{area("connect")}</Field>
            <Field label="List" hint="Prints the template and the task databases, one per line: name, then size in MB. Sizes and databases no task owns show on Resources.">{area("list")}</Field>
            <Field label="Shared databases" hint="A worktree may still use these besides its own. Comma-separated."><input value={v.shared} onChange={(e) => d.patch({ shared: e.target.value })} /></Field>
            <Field label="More templates" hint="Each is copied for every task and session into the copies listed, one per line ({{db}} = the owner's main database) — e.g. a test-database template copied into the test runner's per-worker databases. Copies named {{db}}_… are dropped with the owner's database.">
                <div className="field-rows">
                    {v.c.extraTemplates.map((t, i) => (
                        <div key={i} className="component-row">
                            <input value={t.template} placeholder="template database" onChange={(e) => setTpl(i, { template: e.target.value })} />
                            <span />
                            <label className="inline"><input type="checkbox" checked={t.refresh} onChange={(e) => setTpl(i, { refresh: e.target.checked })} /> migrate at refresh</label>
                            <button className="tiny danger" onClick={() => setC({ extraTemplates: v.c.extraTemplates.filter((_, j) => j !== i) })}>remove</button>
                            <textarea spellCheck={false} value={t.copies.join("\n")} placeholder={"{{db}}_test\n{{db}}_test_gw0"} onChange={(e) => setTpl(i, { copies: e.target.value.split("\n") })} />
                        </div>
                    ))}
                    <button className="tiny" style={{ justifySelf: "start" }} onClick={() => setC({ extraTemplates: [...v.c.extraTemplates, { template: "", copies: [], refresh: true }] })}>+ template</button>
                </div>
            </Field>
        </EntityForm>
    );
};

// ---------- QA ----------
const QaTab = ({ env, save, saving }: Common) => {
    const d = useDraft(() => ({
        qaBrowser: (env.qa_browser ?? "chrome") as "chrome" | "gstack", qaAutoFix: ((env.qa_auto_fix as QaAutoFixScope | null | undefined) ?? "seeds+steps") as QaAutoFixScope,
        qaSeedHints: env.qa_seed_hints ?? "", qaSessionCommand: env.qa_session_command ?? "", qaBrowserCookies: env.qa_browser_cookies ?? "",
    }), [env]);
    const v = d.value;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "qa"} onDiscard={d.reset} onSave={() => save("qa", {
            qaBrowser: v.qaBrowser, qaAutoFix: v.qaAutoFix, qaSeedHints: nul(v.qaSeedHints), qaSessionCommand: nul(v.qaSessionCommand), qaBrowserCookies: nul(v.qaBrowserCookies),
        })}>
            <Field label="QA browser" hint="Chrome profile: the QA account's Chrome via claude-in-chrome (windows, profile copies per run, browser login). gstack: a headless Chromium with no windows; its session comes from the QA session command, else from that Chrome profile's cookies and localStorage; runs on a token account.">
                <select value={v.qaBrowser} onChange={(e) => d.patch({ qaBrowser: e.target.value as "chrome" | "gstack" })}>
                    <option value="chrome">Chrome profile of the QA account</option>
                    <option value="gstack">gstack headless Chromium</option>
                </select>
            </Field>
            <Field label="Corrections Jev may approve" hint="A runner that finds a seed, step or assert wrong as written proposes a correction; Jev judges it against the ticket's acceptance criteria (legit ≥ 85 %, weakens ≤ 15 %), and the kinds in this scope are applied at once. The rest, and every removal, wait for you.">
                <select value={v.qaAutoFix} onChange={(e) => d.patch({ qaAutoFix: e.target.value as QaAutoFixScope })}>
                    <option value="off">off — every correction waits for you</option>
                    <option value="seeds">seeds — seed and teardown commands</option>
                    <option value="seeds+steps">seeds + steps — also a step's action</option>
                    <option value="seeds+steps+asserts">seeds + steps + asserts — also asserts and scenario rewrites</option>
                </select>
            </Field>
            <Field label="Seeding hints" hint="How agents create test data here: database connection and key tables, API auth, seed recipes. Given to the Design and QA prompts verbatim."><textarea className="tall" spellCheck={false} value={v.qaSeedHints} onChange={(e) => d.patch({ qaSeedHints: e.target.value })} /></Field>
            <Field label="QA session command" hint="Runs from the worktree before every QA pass; the last line it prints reaches the QA run and its seeds as $STAGEHAND_QA_SESSION — e.g. a signed session cookie for API scenarios, so the agent never handles the app's secrets."><textarea className="tall" spellCheck={false} value={v.qaSessionCommand} onChange={(e) => d.patch({ qaSessionCommand: e.target.value })} /></Field>
            <Field label="QA browser cookies" hint="One name=value per line; the headless QA browser gets them on the app's host after its session — e.g. a cookie that tells the app a tab is a fresh sign-in."><textarea spellCheck={false} value={v.qaBrowserCookies} onChange={(e) => d.patch({ qaBrowserCookies: e.target.value })} /></Field>
        </EntityForm>
    );
};

// ---------- Pull requests ----------
const PrTab = ({ env, save, saving, info, reloadInfo }: Common & { info: EnvRules | null; reloadInfo: () => void }) => {
    const d = useDraft(() => ({ tpl: Object.fromEntries((info?.prTemplates ?? []).map((t) => [t.dir, t.source === "env" ? t.path ?? "" : t.missing ?? ""])) as Record<string, string> }), [env, info]);
    const v = d.value;
    return (
        <EntityForm dirty={d.dirty} saving={saving === "pr"} onDiscard={d.reset} onSave={async () => {
            await save("pr", { ...(info ? { prTemplates: Object.fromEntries(info.prTemplates.map((t) => [t.dir, (v.tpl[t.dir] ?? "").trim() || null])) } : {}) });
            reloadInfo();
        }}>
            {info?.prTemplates.map((t) => (
                <Field
                    key={t.dir}
                    label={<>PR template{t.dir === "." ? "" : <> · <code>{t.dir}/</code></>}{t.missing && <span className="chip bad">override not found</span>}</>}
                    hint={`Template path relative to the repository; the PR-draft agent writes this repository's description on it. Empty: the template auto-detected in the repository. In effect: ${t.path ?? "none (description only)"}${t.source === "env" ? " — this override" : t.source === "dir" ? " — the config dir's override" : t.source === "detected" ? " — auto-detected" : ""}.`}
                >
                    <input value={v.tpl[t.dir] ?? ""} onChange={(e) => d.patch({ tpl: { ...v.tpl, [t.dir]: e.target.value } })} placeholder={t.detected ? `auto-detected: ${t.detected}` : "none detected"} />
                </Field>
            ))}
        </EntityForm>
    );
};

// ---------- CI autopilot ----------
const AutopilotTab = ({ env, save, saving }: Common) => {
    const d = useDraft(() => ({ on: (env.ci_autopilot ?? 1) !== 0, rules: autopilotRulesOf(env) as AutopilotRules }), [env]);
    const v = d.value;
    const setRule = (i: number, p: Partial<AutopilotRules["custom"][number]>) => d.patch({ rules: { ...v.rules, custom: v.rules.custom.map((x, j) => (j === i ? { ...x, ...p } : x)) } });
    return (
        <EntityForm dirty={d.dirty} saving={saving === "autopilot"} onDiscard={d.reset} onSave={() => save("autopilot", {
            ciAutopilot: v.on,
            ciAutopilotRules: v.rules.disabled.length || v.rules.custom.length ? { disabled: v.rules.disabled, custom: v.rules.custom.filter((r) => r.title.trim()).map((r) => ({ ...r, title: r.title.trim(), detail: r.detail.trim() })) } : null,
        })}>
            <CheckField label="On for new tasks" hint="When a PR's checks finish red, the task fixes by itself the failures it caused, has the fix reviewed, and pushes. Each task can switch it off on its PR tab. It proves an untouched failing test passes on the base with the Lifecycle tab's test command." checked={v.on} onChange={(on) => d.patch({ on })} />
            <Field label="Built-in kinds" hint="Stagehand verifies each built-in kind against the branch diff and the base.">
                <div className="field-rows">
                    {AUTOPILOT_KINDS.map((k) => (
                        <label className="inline" key={k.key}>
                            <input type="checkbox" checked={!v.rules.disabled.includes(k.key)} onChange={() => d.patch({ rules: { ...v.rules, disabled: v.rules.disabled.includes(k.key) ? v.rules.disabled.filter((x) => x !== k.key) : [...v.rules.disabled, k.key] } })} /> {k.title} <Hint text={k.detail} />
                        </label>
                    ))}
                </div>
            </Field>
            <Field label="Rules of this environment" hint="Deny: a failure the autopilot must leave red here. Allow: another kind of failure it may fix; it rests on the triage's judgement. The detail tells the triage how to recognise it. A deny rule wins over everything.">
                <div className="field-rows">
                    {v.rules.custom.map((r, i) => (
                        <div className="component-row" key={r.key || i}>
                            <input value={r.title} placeholder="title" onChange={(e) => setRule(i, { title: e.target.value })} />
                            <select value={r.verdict} onChange={(e) => setRule(i, { verdict: e.target.value as "allow" | "deny" })}>
                                <option value="deny">Deny — leave it red</option>
                                <option value="allow">Allow — may fix</option>
                            </select>
                            <span />
                            <button className="tiny danger" onClick={() => d.patch({ rules: { ...v.rules, custom: v.rules.custom.filter((_, j) => j !== i) } })}>remove</button>
                            <textarea value={r.detail} placeholder="how to recognise it, and what to do instead" onChange={(e) => setRule(i, { detail: e.target.value })} />
                        </div>
                    ))}
                    <button className="tiny" style={{ justifySelf: "start" }} onClick={() => d.patch({ rules: { ...v.rules, custom: [...v.rules.custom, { key: `r${Date.now().toString(36)}`, title: "", verdict: "deny", detail: "" }] } })}>+ rule</button>
                </div>
            </Field>
        </EntityForm>
    );
};

// ---------- Code review ----------
const ReviewTab = ({ env, save, saving, onError }: Common & { onError: (m: string) => void }) => {
    const [cats, setCats] = useState<ReviewCategoryDef[]>([]);
    useEffect(() => void api.reviewCategories().then(setCats).catch((e: Error) => onError(e.message)), [onError]);
    const d = useDraft(() => {
        const rc = reviewChecklistOf(env);
        return { on: env.code_review !== 0, disabled: rc.disabled, custom: rc.custom, doNotFlag: rc.doNotFlag.join("\n") };
    }, [env]);
    const v = d.value;
    const setPoint = (i: number, p: Partial<(typeof v.custom)[number]>) => d.patch({ custom: v.custom.map((x, j) => (j === i ? { ...x, ...p } : x)) });
    const isDefault = v.disabled.length === 0 && v.custom.length === 0 && v.doNotFlag.trim() === "";
    return (
        <EntityForm dirty={d.dirty} saving={saving === "review"} onDiscard={d.reset} onSave={() => save("review", {
            codeReview: v.on,
            reviewChecklist: isDefault ? null : { disabled: v.disabled, custom: v.custom.filter((p) => p.title.trim()).map((p) => ({ ...p, title: p.title.trim(), detail: p.detail.trim() })), doNotFlag: v.doNotFlag.split("\n").map((l) => l.trim()).filter(Boolean) },
        })}>
            <CheckField label="Run the Code Review stage after Implementation" hint="A fresh session applies gstack's pre-landing checklist, tuned below: mechanical findings fixed and committed, serious open ones sent back to Implementation once, everything shown at User Review. Off: tasks go straight on to Manual QA." checked={v.on} onChange={(on) => d.patch({ on })} />
            {(["critical", "informational"] as ReviewPass[]).map((pass) => (
                <Field key={pass} label={pass === "critical" ? "Pass 1 — critical" : "Pass 2 — informational"} hint={pass === "critical" ? "Runs first; findings lean to open for you to judge." : "Runs second; mechanical findings are fixed and committed by the reviewer."}>
                    <div className="field-rows">
                        {cats.filter((c) => c.pass === pass).map((c) => (
                            <label className="inline" key={c.key}>
                                <input type="checkbox" checked={!v.disabled.includes(c.key)} onChange={() => d.patch({ disabled: v.disabled.includes(c.key) ? v.disabled.filter((k) => k !== c.key) : [...v.disabled, c.key] })} /> {c.title} <Hint text={c.detail} />
                            </label>
                        ))}
                        {cats.length === 0 && <span className="quiet">loading…</span>}
                    </div>
                </Field>
            ))}
            <Field label="Points added for this environment" hint="Your own review rules — a project convention, an architecture boundary, a recurring bug class. The title is the category the reviewer reports under; the detail tells it what to look for and where.">
                <div className="field-rows">
                    {v.custom.map((p, i) => (
                        <div className="component-row" key={p.key || i}>
                            <input value={p.title} placeholder="title" onChange={(e) => setPoint(i, { title: e.target.value })} />
                            <select value={p.pass} onChange={(e) => setPoint(i, { pass: e.target.value as ReviewPass })}>
                                <option value="critical">Pass 1 — critical</option>
                                <option value="informational">Pass 2 — informational</option>
                            </select>
                            <span />
                            <button className="tiny danger" onClick={() => d.patch({ custom: v.custom.filter((_, j) => j !== i) })}>remove</button>
                            <textarea value={p.detail} placeholder="what to look for" onChange={(e) => setPoint(i, { detail: e.target.value })} />
                        </div>
                    ))}
                    <button className="tiny" style={{ justifySelf: "start" }} onClick={() => d.patch({ custom: [...v.custom, { key: `p${Date.now().toString(36)}`, title: "", pass: "informational", detail: "" }] })}>+ point</button>
                </div>
            </Field>
            <Field label="Do not flag" hint="One rule per line, added to the checklist's own list."><textarea value={v.doNotFlag} onChange={(e) => d.patch({ doNotFlag: e.target.value })} /></Field>
        </EntityForm>
    );
};

export const EnvPage = ({ env, envs, accounts, configDirs, onBack, onOpenDir, onChanged, onError }: {
    env: Env; envs: Env[]; accounts: Account[]; configDirs: ConfigDir[]; onBack: () => void; onOpenDir: (id: string) => void; onChanged: () => Promise<void>; onError: (m: string) => void;
}) => {
    const [info, setInfo] = useState<EnvRules | null>(null);
    const reloadInfo = () => void api.envRules(env.id).then(setInfo).catch((e: Error) => onError(e.message));
    useEffect(reloadInfo, [env.id, env.config_dir_id]); // eslint-disable-line react-hooks/exhaustive-deps
    const { saving, run } = useSaver(onError);
    const save = (key: string, body: Patch) => run(key, async () => {
        await api.patchEnv(env.id, body);
        await onChanged();
    });
    const common: Common = { env, save, saving };
    return (
        <EntityView
            type="Environments"
            onType={onBack}
            id={env.name}
            tabs={[
                { key: "general", label: "General", content: <GeneralTab {...common} envs={envs} /> },
                { key: "app", label: "App", content: <AppTab {...common} /> },
                { key: "lifecycle", label: "Lifecycle", content: <LifecycleTab {...common} /> },
                { key: "database", label: "Database", content: <DatabaseTab {...common} /> },
                { key: "agents", label: "Agents", content: <AgentsTab {...common} accounts={accounts} configDirs={configDirs} info={info} onOpenDir={onOpenDir} /> },
                { key: "claude-md", label: "CLAUDE.md", content: <ClaudeMdTab env={env} onError={onError} /> },
                { key: "qa", label: "QA", content: <QaTab {...common} /> },
                { key: "pr", label: "PR templates", content: <PrTab {...common} info={info} reloadInfo={reloadInfo} /> },
                { key: "autopilot", label: "CI autopilot", content: <AutopilotTab {...common} /> },
                { key: "review", label: "Code review", content: <ReviewTab {...common} onError={onError} /> },
            ]}
        />
    );
};
