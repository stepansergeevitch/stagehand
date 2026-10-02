import { useEffect, useState } from "react";
import { accountOrderOf, accountUsableWith, api, autopilotRulesOf, AUTOPILOT_KINDS, componentsOf, reviewChecklistOf, type AutopilotRules, type Account, type ClaudeMdFile, type ConfigDir, type Env, type EnvComponent, type EnvDependencyStatus, type EnvRules, type QaAutoFixScope, type ReviewCategoryDef, type ReviewPass, type ReviewPoint } from "./api";

// Full-page environment configuration: general, Claude config dir + default AI account, services. Rules live on the config dir.

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

const Section = ({ title, hint, children, onSave, saving }: { title: string; hint?: string; children: React.ReactNode; onSave: () => Promise<void>; saving: boolean }) => (
    <section className="card env-section">
        <h2>{title}</h2>
        {hint && <p className="field-hint">{hint}</p>}
        <div className="env-fields">{children}</div>
        <div className="actions">
            <button className="primary" disabled={saving} onClick={() => void onSave()}>{saving ? "Saving…" : "Save"}</button>
        </div>
    </section>
);

// The CLAUDE.md files this environment's runs read, each editable in place: the config dir's applies to every run at
// once; a repository's is committed in git, so a task sees an edit once it is on the base branch.
const ClaudeMdCard = ({ envId, configDirId, onError }: { envId: string; configDirId: string | null; onError: (m: string) => void }) => {
    const [files, setFiles] = useState<ClaudeMdFile[] | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState<string | null>(null);
    useEffect(() => {
        setFiles(null);
        setDrafts({});
        void api.envClaudeMd(envId).then((r) => setFiles(r.files)).catch((e: Error) => onError(e.message));
    }, [envId, configDirId, onError]);
    const save = async (f: ClaudeMdFile) => {
        setSaving(f.id);
        try {
            const r = await api.saveClaudeMd(envId, f.id, drafts[f.id] ?? f.content);
            setFiles((fs) => (fs ?? []).map((x) => (x.id === f.id ? r.file : x)));
            setDrafts((d) => {
                const { [f.id]: _gone, ...rest } = d;
                return rest;
            });
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setSaving(null);
        }
    };
    return (
        <section className="card env-section">
            <h2>CLAUDE.md</h2>
            <p className="field-hint">What every agent run here reads first. The config dir's file applies to the next run at once. A repository's file is committed in git: a task sees an edit once it is on the base branch, and editing it here changes the working tree of the main checkout.</p>
            <div className="env-fields">
                {files === null && <span className="field-hint">reading…</span>}
                {files?.map((f) => {
                    const draft = drafts[f.id];
                    const dirty = draft !== undefined && draft !== f.content;
                    return (
                        <label key={f.id}>
                            <span>
                                <b>{f.label}</b> <code>{f.path}</code>{" "}
                                {f.exists ? <span className="chip">{f.scope === "config-dir" ? "applies at once" : "committed in git"}</span> : <span className="chip warn">none yet — saving creates it</span>}
                            </span>
                            <textarea className="tall" value={draft ?? f.content} onChange={(e) => setDrafts((d) => ({ ...d, [f.id]: e.target.value }))} placeholder={f.exists ? "" : "# Instructions for every agent run in this environment"} spellCheck={false} />
                            <div className="actions" style={{ marginBottom: 0 }}>
                                <button className="primary" disabled={saving === f.id || (!dirty && f.exists)} onClick={() => void save(f)}>{saving === f.id ? "Saving…" : f.exists ? "Save" : "Create"}</button>
                                {dirty && <button onClick={() => setDrafts((d) => { const { [f.id]: _gone, ...rest } = d; return rest; })}>Discard</button>}
                            </div>
                        </label>
                    );
                })}
            </div>
        </section>
    );
};

export const EnvPage = ({ env, envs, accounts, configDirs, onBack, onOpenDir, onChanged, onError }: {
    env: Env; envs: Env[]; accounts: Account[]; configDirs: ConfigDir[]; onBack: () => void; onOpenDir: (id: string) => void; onChanged: () => Promise<void>; onError: (m: string) => void;
}) => {
    const [saving, setSaving] = useState<string | null>(null);
    const [info, setInfo] = useState<EnvRules | null>(null);
    useEffect(() => {
        void api.envRules(env.id).then(setInfo).catch((e: Error) => onError(e.message));
    }, [env.id, env.config_dir_id, onError]);
    // ---- dependency: another env's BE this one needs reachable (e.g. Deal → Core)
    const [dependsOn, setDependsOn] = useState(env.depends_on_env_id ?? "");
    useEffect(() => setDependsOn(env.depends_on_env_id ?? ""), [env.depends_on_env_id]);
    const [depStatus, setDepStatus] = useState<EnvDependencyStatus | null>(null);
    const loadDepStatus = () => void api.envDependency(env.id).then(setDepStatus).catch(() => setDepStatus(null));
    useEffect(() => {
        loadDepStatus();
        if (!env.depends_on_env_id) return;
        const t = setInterval(loadDepStatus, 15_000);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [env.id, env.depends_on_env_id]);

    const save = async (section: string, body: Parameters<typeof api.patchEnv>[1]) => {
        setSaving(section);
        try {
            await api.patchEnv(env.id, body);
            await onChanged();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setSaving(null);
        }
    };

    // ---- general
    const [g, setG] = useState({ name: env.name, repos: joinRepos(env.repos), baseBranch: env.base_branch, branchPrefix: env.branch_prefix ?? "", ticketSource: env.ticket_source });
    // ---- claude config dir + AI accounts in priority order
    const [order, setOrder] = useState<string[]>(() => accountOrderOf(env));
    const [dirId, setDirId] = useState(env.config_dir_id ?? "");
    const browserAccounts = (info?.browserAccounts ?? []).map((id) => accounts.find((a) => a.id === id)).filter((a): a is Account => !!a);
    const move = (id: string, delta: number) => setOrder((o) => {
        const i = o.indexOf(id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= o.length) return o;
        const next = [...o];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return next;
    });
    const toggle = (id: string) => setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
    const dirPath = configDirs.find((d) => d.id === dirId)?.path ?? info?.configDir.path ?? "";
    // ---- services
    const [s, setS] = useState({
        appUrl: env.app_url ?? "", beCommand: env.be_command ?? "", feCommand: env.fe_command ?? "", beUrlTemplate: env.be_url_template ?? "", feUrlTemplate: env.fe_url_template ?? "",
        bePort: env.be_port ? String(env.be_port) : "", fePort: env.fe_port ? String(env.fe_port) : "", setupCommand: env.setup_command ?? "", envVars: env.env_vars ?? "",
        qaSeedHints: env.qa_seed_hints ?? "", cleanupCommand: env.cleanup_command ?? "", rebaseCommand: env.rebase_command ?? "", migrateCommand: env.migrate_command ?? "", migrateDownCommand: env.migrate_down_command ?? "", memoryWings: ((): string => { try { return (JSON.parse(env.memory_wings ?? "[]") as string[]).join(", "); } catch { return ""; } })(), checkCommand: env.check_command ?? "",
    });
    // ---- optional components (a worker, a scheduler): saved with the Services section
    const [comps, setComps] = useState<EnvComponent[]>(() => componentsOf(env));
    const [keepServices, setKeepServices] = useState(env.keep_services === 1);
    // ---- CI autopilot
    const [ciAutopilot, setCiAutopilot] = useState((env.ci_autopilot ?? 1) !== 0);
    const [testCommand, setTestCommand] = useState(env.test_command ?? "");
    const [apRules, setApRules] = useState<AutopilotRules>(() => autopilotRulesOf(env));
    const setApRule = (i: number, patch: Partial<AutopilotRules["custom"][number]>) => setApRules((r) => ({ ...r, custom: r.custom.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
    const [qaBrowser, setQaBrowser] = useState<"chrome" | "gstack">(env.qa_browser ?? "chrome");
    const [qaAutoFix, setQaAutoFix] = useState<QaAutoFixScope>((env.qa_auto_fix as QaAutoFixScope | null | undefined) ?? "seeds+steps");
    // ---- code review: which of gstack's categories run here, points added, extra do-not-flag rules
    const [cats, setCats] = useState<ReviewCategoryDef[]>([]);
    useEffect(() => {
        void api.reviewCategories().then(setCats).catch((e: Error) => onError(e.message));
    }, [onError]);
    const [rc, setRc] = useState(() => reviewChecklistOf(env));
    const [doNotFlagText, setDoNotFlagText] = useState(() => reviewChecklistOf(env).doNotFlag.join("\n"));
    const toggleCat = (key: string) => setRc((r) => ({ ...r, disabled: r.disabled.includes(key) ? r.disabled.filter((k) => k !== key) : [...r.disabled, key] }));
    const setPoint = (i: number, patch: Partial<ReviewPoint>) => setRc((r) => ({ ...r, custom: r.custom.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
    const rcDefault = rc.disabled.length === 0 && rc.custom.length === 0 && doNotFlagText.trim() === "";
    const setComp = (i: number, patch: Partial<EnvComponent>) => setComps((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    const set =<T extends object>(setter: React.Dispatch<React.SetStateAction<T>>) => (k: keyof T) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setter((prev) => ({ ...prev, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
    const sg = set(setG);
    const ss = set(setS);
    // ---- pull requests: draft mode
    const [prDraft, setPrDraft] = useState(env.pr_draft === 1);
    useEffect(() => setPrDraft(env.pr_draft === 1), [env.pr_draft]);
    // ---- PR templates, one per repository (what the PR-draft agent writes each description on)
    const [tpl, setTpl] = useState<Record<string, string>>({});
    useEffect(() => {
        if (!info) return;
        setTpl(Object.fromEntries(info.prTemplates.map((t) => [t.dir, t.source === "env" ? t.path ?? "" : t.missing ?? ""])));
    }, [info]);

    return (
        <div className="env-page">
            <button className="back-link" onClick={onBack}>← environments</button>
            <h1>{env.name}</h1>
            <div className="sub"><code>{env.path}</code></div>

            <Section title="General" saving={saving === "general"} onSave={() => save("general", {
                name: g.name, baseBranch: g.baseBranch, repos: splitRepos(g.repos).length ? splitRepos(g.repos) : null, branchPrefix: nul(g.branchPrefix), ticketSource: g.ticketSource,
            })}>
                <label>Name <input value={g.name} onChange={sg("name")} /></label>
                <label>Sub-repositories (comma-separated; empty = the path itself is the git repo) <input value={g.repos} onChange={sg("repos")} placeholder="backend, frontend" /></label>
                <label>Base branch <input value={g.baseBranch} onChange={sg("baseBranch")} /></label>
                <label>Branch prefix <input value={g.branchPrefix} onChange={sg("branchPrefix")} placeholder="e.g. yourname/ — prepended to the branch research proposes" /></label>
                <label>Task system (how bare ids like ABC-123 are resolved)
                    <select value={g.ticketSource} onChange={sg("ticketSource")}><option value="clickup">ClickUp</option><option value="linear">Linear</option></select>
                </label>
            </Section>

            <Section
                title="Depends on"
                hint="Another environment whose backend this app calls out to and can't work without (e.g. Deal needs Core for auth). Started once — the first task that needs it — and shared by every task of this env after that; it isn't itself under test, so it keeps its own checkout and branch, not a fresh worktree per task. Its own configured port is tried first; a free one is picked only if that's taken."
                saving={saving === "dependency"}
                onSave={async () => { await save("dependency", { dependsOnEnvId: dependsOn || null }); loadDepStatus(); }}
            >
                <label>Depends on
                    <select value={dependsOn} onChange={(e) => setDependsOn(e.target.value)}>
                        <option value="">— none —</option>
                        {envs.filter((e) => e.id !== env.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                </label>
                {env.depends_on_env_id && depStatus?.configured && (
                    <div className="kv" style={{ marginTop: 4 }}>
                        <b>{depStatus.dependencyEnvName}</b>
                        <span>
                            {depStatus.running ? <span className="chip ok">running</span> : <span className="chip">not started yet</span>}
                            {depStatus.port && <code style={{ marginLeft: 8 }}>:{depStatus.port}</code>}
                            {depStatus.startedAt && <span className="field-hint" style={{ marginLeft: 8 }}>since {new Date(depStatus.startedAt).toLocaleString()}</span>}
                            {!depStatus.running && <span className="field-hint" style={{ marginLeft: 8 }}>starts automatically the next time a task here needs it</span>}
                        </span>
                    </div>
                )}
            </Section>

            <Section title="Claude config dir and AI accounts" hint="Every agent run for this environment (research, design, QA, implementation, helpers, the terminal) uses the config dir: its skills, hooks, subagents, MCP servers, CLAUDE.md and the commit/branch/PR rules. The AI accounts only supply the login: runs go to the first listed account that is not exhausted; when it hits its rate limit the next one takes over, and the task waits for a reset only when every listed account is exhausted." saving={saving === "claude"} onSave={() => save("claude", { configDirId: nul(dirId), accountOrder: order })}>
                <label>Config dir
                    <select value={dirId} onChange={(e) => setDirId(e.target.value)}>
                        <option value="">— server default —</option>
                        {configDirs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.path}</option>)}
                    </select>
                    {dirId && <span className="field-hint"><a href="#" onClick={(e) => { e.preventDefault(); onOpenDir(dirId); }}>Edit this dir's rules and see what it contains</a></span>}
                </label>
                <div className="account-order">
                    <span className="field-hint">AI accounts in priority order (tick to include, arrows to reorder; empty = any account that can run in this dir)</span>
                    {[...order.map((id) => accounts.find((a) => a.id === id)).filter((a): a is Account => !!a), ...accounts.filter((a) => !order.includes(a.id))].map((a) => {
                        const i = order.indexOf(a.id);
                        const ok = dirPath ? accountUsableWith(a, dirPath) : a.logged_in === 1;
                        return (
                            <div key={a.id} className={`account-row ${i >= 0 ? "on" : ""}`}>
                                <label className="inline"><input type="checkbox" checked={i >= 0} onChange={() => toggle(a.id)} /> {i >= 0 ? <b>{i + 1}.</b> : null} {a.name}{a.email ? ` · ${a.email}` : ""}</label>
                                {a.plan && <span className="chip">{a.plan}</span>}
                                {!ok && <span className="chip warn" title={a.logged_in ? "cannot run in this dir — needs a token" : "not logged in"}>{a.logged_in ? "needs a token" : "no auth"}</span>}
                                {i >= 0 && (
                                    <span className="order-buttons">
                                        <button disabled={i === 0} onClick={() => move(a.id, -1)} title="higher priority">▲</button>
                                        <button disabled={i === order.length - 1} onClick={() => move(a.id, 1)} title="lower priority">▼</button>
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
                {info && (
                    <div className="kv">
                        <b>Accounts that can run here</b><span>{info.usableAccounts.length ? info.usableAccounts.map((id) => accounts.find((a) => a.id === id)?.name ?? id).join(", ") : "none — set up a token on the AI accounts page"}</span>
                        <b>Browser stages (QA) run as</b><span>{browserAccounts.length ? browserAccounts.map((a) => `${a.name}${a.chrome_browser_name ? ` (Chrome profile ${a.chrome_browser_name})` : ""}`).join(" → ") : "nobody — no listed account has a Chrome-paired browser login (AI accounts → Log in (browser) + Probe Chrome)"}</span>
                        <b>Rules in effect</b><span>commits {info.rules.allowCommit ? "allowed" : "off"} · push {info.rules.allowPush ? "allowed" : "off"} · PR creation {info.rules.allowPrCreate ? "allowed" : "off"} · branch <code>{info.rules.branchPattern}</code></span>
                    </div>
                )}
            </Section>

            <ClaudeMdCard envId={env.id} configDirId={env.config_dir_id} onError={onError} />

            <Section title="Pull requests" hint="Applies once a repository's PR is approved and Stagehand opens it." saving={saving === "pr"} onSave={() => save("pr", { prDraft })}>
                <label className="inline"><input type="checkbox" checked={prDraft} onChange={(e) => setPrDraft(e.target.checked)} /> Open every PR as a draft (mark it ready for review yourself)</label>
            </Section>

            {info && (
                <Section title="Pull request templates" hint="One template per repository: the PR-draft agent writes each repository's description on its own template, and the human edits it per repository at PR Creation Review. Empty = the template auto-detected in that repository (.github/pull_request_template.md, docs/pull_request_template.md, …); a path here overrides it." saving={saving === "templates"} onSave={async () => {
                    await save("templates", { prTemplates: Object.fromEntries(info.prTemplates.map((t) => [t.dir, (tpl[t.dir] ?? "").trim() || null])) });
                    await api.envRules(env.id).then(setInfo).catch((e: Error) => onError(e.message));
                }}>
                    {info.prTemplates.map((t) => (
                        <label key={t.dir}>
                            {t.dir === "." ? "Repository" : <><code>{t.dir}/</code></>} — template path relative to that repository
                            <input value={tpl[t.dir] ?? ""} onChange={(e) => setTpl((p) => ({ ...p, [t.dir]: e.target.value }))} placeholder={t.detected ? `auto-detected: ${t.detected}` : "none detected — write the description only"} />
                            <span className="field-hint">
                                in effect: {t.path ? <code>{t.path}</code> : "none (description only)"}
                                {t.source === "env" ? " · this override" : t.source === "dir" ? " · config dir override" : t.source === "detected" ? " · auto-detected" : ""}
                                {t.missing && <span className="chip bad" style={{ marginLeft: 6 }}>override {t.missing} not found — auto-detected used</span>}
                            </span>
                        </label>
                    ))}
                </Section>
            )}

            <Section title="Services" hint="Placeholders: {{port}}, {{url}}, {{bePort}}, {{beUrl}} (FE only), {{worktree}}, {{taskDir}}, {{envPath}} (setup only). Commands run from the task's worktree in tmux." saving={saving === "services"} onSave={() => save("services", {
                appUrl: nul(s.appUrl), beCommand: nul(s.beCommand), feCommand: nul(s.feCommand), beUrlTemplate: nul(s.beUrlTemplate), feUrlTemplate: nul(s.feUrlTemplate),
                bePort: s.bePort.trim() ? Number(s.bePort) : null, fePort: s.fePort.trim() ? Number(s.fePort) : null, setupCommand: nul(s.setupCommand), envVars: nul(s.envVars),
                qaSeedHints: nul(s.qaSeedHints), cleanupCommand: nul(s.cleanupCommand), rebaseCommand: nul(s.rebaseCommand), migrateCommand: nul(s.migrateCommand), migrateDownCommand: nul(s.migrateDownCommand), memoryWings: s.memoryWings.split(",").map((w) => w.trim()).filter(Boolean), checkCommand: nul(s.checkCommand),
                components: comps.filter((c) => c.key.trim() && c.command.trim()).map((c) => ({ ...c, key: c.key.trim(), label: c.label.trim() || c.key.trim() })),
                keepServices,
                qaBrowser,
                qaAutoFix,
            })}>
                <div className="two">
                    <label>QA app URL <input value={s.appUrl} onChange={ss("appUrl")} placeholder="{{feUrl}} or {{beUrl}} or a fixed URL" /></label>
                    <label>BE fixed port <input value={s.bePort} onChange={ss("bePort")} placeholder="empty = pick free" /></label>
                    <label>FE fixed port <input value={s.fePort} onChange={ss("fePort")} placeholder="empty = pick free" /></label>
                    <label>BE URL template <input value={s.beUrlTemplate} onChange={ss("beUrlTemplate")} placeholder="http://localhost:{{port}}" /></label>
                    <label>FE URL template <input value={s.feUrlTemplate} onChange={ss("feUrlTemplate")} placeholder="http://localhost:{{port}}" /></label>
                </div>
                <label>Environment variables (KEY=VALUE per line; exported into git, setup, BE/FE, Claude runs and the terminal) <textarea value={s.envVars} onChange={ss("envVars")} /></label>
                <label>Worktree setup command (runs once after a worktree is created) <textarea value={s.setupCommand} onChange={ss("setupCommand")} /></label>
                <label>Migrate command (brings the database up to the worktree's code; Stagehand runs it from the worktree before every BE start, and after a QA baseline on base code; {"{{worktree}}"} / {"{{envPath}}"}) <textarea value={s.migrateCommand} onChange={ss("migrateCommand")} placeholder="optional — e.g. cd backend && poetry run python manage.py migrate --noinput" /></label>
                <label>Migrate down command (rolls back the migrations the branch added, to the base; runs from the worktree on the branch's code before a QA baseline switches it to the base. {"{{baseRef}}"} = the base commit of the root repo, {"{{baseRef:<dir>}}"} of a sub-repo; also $STAGEHAND_BASE_REF and $STAGEHAND_BASE_REF_&lt;DIR&gt;) <textarea value={s.migrateDownCommand} onChange={ss("migrateDownCommand")} placeholder="optional — without it a branch that adds migrations runs its baseline against the branch's schema" /></label>
                <label>Memory wings (palace wings that belong to this environment's memory besides its product wing and its Product Owners' — e.g. an imported palace's knowledge wings; comma-separated) <input value={s.memoryWings} onChange={ss("memoryWings")} placeholder="northspyre, northspyre-deal" /></label>
                <label>Cleanup command (runs from the worktree when a task is cleaned up, after BE/FE stop and before the worktree is removed — drop a per-task database, free caches; {"{{worktree}}"} / {"{{envPath}}"}) <textarea value={s.cleanupCommand} onChange={ss("cleanupCommand")} placeholder="optional" /></label>
                <label>Rebase command (runs from the worktree after every successful rebase onto the base branch — rebuild what a rebase makes stale, e.g. drop and recreate the per-task test databases; {"{{worktree}}"} / {"{{envPath}}"}) <textarea value={s.rebaseCommand} onChange={ss("rebaseCommand")} placeholder="optional" /></label>
                <label>Verification command (runs from the worktree after every Implementation and PR Fix run; a non-zero exit sends the output back to the agent, twice, then blocks for you — put here what tests and a dev server never exercise, e.g. Django <code>manage.py check --database default && manage.py makemigrations --check --dry-run</code>) <textarea value={s.checkCommand} onChange={ss("checkCommand")} placeholder="optional" /></label>
                <label>BE command <textarea value={s.beCommand} onChange={ss("beCommand")} /></label>
                <label>FE command <textarea value={s.feCommand} onChange={ss("feCommand")} /></label>
                <label>QA browser for browser scenarios
                    <select value={qaBrowser} onChange={(e) => setQaBrowser(e.target.value as "chrome" | "gstack")}>
                        <option value="chrome">Chrome profile of the QA account (claude-in-chrome: windows, copies per run, browser login)</option>
                        <option value="gstack">gstack headless Chromium (no windows; the session is imported from that Chrome profile's cookies per run; runs on a token account)</option>
                    </select>
                </label>
                <label>QA corrections Jev may approve without you (a runner that finds a seed, step or assert wrong as written proposes the correction; Jev judges it against the ticket's acceptance criteria — approve needs legit ≥ 85 % and weakens ≤ 15 % — and the mechanical kinds in this scope are applied at once; the rest, and every removal, wait for you with Jev's reading shown)
                    <select value={qaAutoFix} onChange={(e) => setQaAutoFix(e.target.value as QaAutoFixScope)}>
                        <option value="off">off — every correction waits for you</option>
                        <option value="seeds">seeds — seed and teardown commands</option>
                        <option value="seeds+steps">seeds + steps — also a step's action (route, control, selector); the assert stays</option>
                        <option value="seeds+steps+asserts">seeds + steps + asserts — also assert text and whole-scenario rewrites</option>
                    </select>
                </label>
                <label className="inline"><input type="checkbox" checked={keepServices} onChange={(e) => setKeepServices(e.target.checked)} /> Keep a task's BE/FE running between stages (QA baseline → Implementation → Manual QA → User Review) instead of stopping them after every QA pass — saves the cold start (a Next dev server compiles for minutes) at the cost of RAM; they stop when the task is done or cleaned up</label>
                <div className="components">
                    <b>Optional components</b>
                    <span className="field-hint">Extra services beside the BE/FE — a queue worker, a scheduler, a relay. Each runs in its own tmux session from the task's worktree, without a port. The human starts one from the App widget; agents start one on demand through the API (every prompt lists them); a QA scenario declares the ones its journey needs in <code>services</code>; "auto-start" brings it up with the app for every QA pass. Placeholders: {"{{worktree}}"}, {"{{beUrl}}"}, {"{{bePort}}"}, {"{{taskDir}}"}.</span>
                    {comps.map((c, i) => (
                        <div className="component-row" key={i}>
                            <input value={c.key} placeholder="key — e.g. worker (a-z, 0-9, -, _)" onChange={(e) => setComp(i, { key: e.target.value })} />
                            <input value={c.label} placeholder="label — e.g. Celery worker" onChange={(e) => setComp(i, { label: e.target.value })} />
                            <label className="inline"><input type="checkbox" checked={c.autoStart} onChange={(e) => setComp(i, { autoStart: e.target.checked })} /> auto-start with the app</label>
                            <textarea value={c.command} placeholder="command (runs from the worktree)" onChange={(e) => setComp(i, { command: e.target.value })} />
                            <button className="tiny danger" onClick={() => setComps((cs) => cs.filter((_, j) => j !== i))}>remove</button>
                        </div>
                    ))}
                    <button className="tiny" onClick={() => setComps((cs) => [...cs, { key: "", label: "", command: "", autoStart: false }])}>+ component</button>
                </div>
                <label>Seeding hints for QA (how agents create test data here: local DB connection and key tables, API auth, seed scripts; given to the Design and QA prompts verbatim) <textarea value={s.qaSeedHints} onChange={ss("qaSeedHints")} className="tall" placeholder={"Local Postgres: PGPASSWORD=… psql -h localhost -p 5433 -U … -d …\nDeals live in deal, pro formas in pro_forma; sources in pro_forma_source (source_type_id …)\nPrefer SQL for numeric inputs; the pro forma table UI is slow to edit."} /></label>
            </Section>

            <Section title="CI autopilot" hint="When a PR's checks finish red, the task fixes by itself the failures it caused, has the fix reviewed, and pushes. Stagehand verifies each built-in kind against the branch diff and the base; your own allow rules rest on the triage's judgement; a deny rule wins over everything." saving={saving === "autopilot"} onSave={() => save("autopilot", {
                ciAutopilot,
                testCommand: nul(testCommand),
                ciAutopilotRules: apRules.disabled.length || apRules.custom.length ? { disabled: apRules.disabled, custom: apRules.custom.filter((r) => r.title.trim()).map((r) => ({ ...r, title: r.title.trim(), detail: r.detail.trim() })) } : null,
            })}>
                <label className="inline"><input type="checkbox" checked={ciAutopilot} onChange={(e) => setCiAutopilot(e.target.checked)} /> On for new tasks (each task can switch it off on its PR tab)</label>
                <div className="review-pass">
                    <b>Built-in kinds</b>
                    {AUTOPILOT_KINDS.map((k) => (
                        <label className="inline review-cat" key={k.key}>
                            <input type="checkbox" checked={!apRules.disabled.includes(k.key)} onChange={() => setApRules((r) => ({ ...r, disabled: r.disabled.includes(k.key) ? r.disabled.filter((x) => x !== k.key) : [...r.disabled, k.key] }))} /> {k.title}
                            <span className="review-cat-detail">{k.detail}</span>
                        </label>
                    ))}
                </div>
                <div className="components">
                    <b>Rules of this environment</b>
                    <span className="field-hint">Deny: a failure the autopilot must leave red here. Allow: another kind of failure it may fix. The detail tells the triage how to recognise it.</span>
                    {apRules.custom.map((r, i) => (
                        <div className="component-row" key={r.key || i}>
                            <input value={r.title} placeholder="title — e.g. FE types generated from an unmerged backend" onChange={(e) => setApRule(i, { title: e.target.value })} />
                            <select value={r.verdict} onChange={(e) => setApRule(i, { verdict: e.target.value as "allow" | "deny" })}>
                                <option value="deny">Deny — leave it red</option>
                                <option value="allow">Allow — may fix</option>
                            </select>
                            <span />
                            <button className="tiny danger" onClick={() => setApRules((x) => ({ ...x, custom: x.custom.filter((_, j) => j !== i) }))}>remove</button>
                            <textarea value={r.detail} placeholder="how to recognise it, and what to do instead" onChange={(e) => setApRule(i, { detail: e.target.value })} />
                        </div>
                    ))}
                    <button className="tiny" onClick={() => setApRules((r) => ({ ...r, custom: [...r.custom, { key: `r${Date.now().toString(36)}`, title: "", verdict: "deny", detail: "" }] }))}>+ rule</button>
                </div>
                <label>Test command (runs named tests on a checkout of the base, to prove an untouched failing test passes there when CI has no green run on the base; {"{{tests}}"} = the test ids; runs from the base checkout of the repository) <textarea value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="optional — e.g. cd backend && poetry run pytest {{tests}}" /></label>
            </Section>

            <Section title="Code review" hint="What the Code Review stage checks after Implementation: gstack's pre-landing checklist, tuned for this environment. Switch off categories that do not apply here, add the points your team reviews for (each becomes a finding category the reviewer reports under), and list what the reviewer must not flag. Every point still follows the same method: a quoted motivating line, confidence 1–10, mechanical fixes committed, judgment calls left open." saving={saving === "review"} onSave={() => save("review", {
                reviewChecklist: rcDefault ? null : { disabled: rc.disabled, custom: rc.custom.filter((p) => p.title.trim()).map((p) => ({ ...p, title: p.title.trim(), detail: p.detail.trim() })), doNotFlag: doNotFlagText.split("\n").map((l) => l.trim()).filter(Boolean) },
            })}>
                {(["critical", "informational"] as ReviewPass[]).map((pass) => (
                    <div className="review-pass" key={pass}>
                        <b>{pass === "critical" ? "Pass 1 — critical" : "Pass 2 — informational"}</b>
                        <span className="field-hint">{pass === "critical" ? "Run first; findings lean to \"open\" for you to judge." : "Run second; mechanical findings are fixed and committed by the reviewer."}</span>
                        {cats.filter((c) => c.pass === pass).map((c) => (
                            <label className="inline review-cat" key={c.key} title={c.detail}>
                                <input type="checkbox" checked={!rc.disabled.includes(c.key)} onChange={() => toggleCat(c.key)} /> {c.title}
                                <span className="review-cat-detail">{c.detail}</span>
                            </label>
                        ))}
                        {cats.length === 0 && <span className="field-hint">loading categories…</span>}
                    </div>
                ))}
                <div className="components">
                    <b>Points added for this environment</b>
                    <span className="field-hint">Your own review rules — a project convention, an architecture boundary, a recurring bug class. The title is the category the reviewer reports under; the detail tells it what to look for and where.</span>
                    {rc.custom.map((p, i) => (
                        <div className="component-row" key={p.key || i}>
                            <input value={p.title} placeholder="title — e.g. UnitOfWork usage" onChange={(e) => setPoint(i, { title: e.target.value })} />
                            <select value={p.pass} onChange={(e) => setPoint(i, { pass: e.target.value as ReviewPass })}>
                                <option value="critical">Pass 1 — critical</option>
                                <option value="informational">Pass 2 — informational</option>
                            </select>
                            <span />
                            <button className="tiny danger" onClick={() => setRc((r) => ({ ...r, custom: r.custom.filter((_, j) => j !== i) }))}>remove</button>
                            <textarea value={p.detail} placeholder="what to look for — e.g. every Repository and Service is constructed with uow=, never db=; a db= call site is a finding even outside the diff when the diff touches that file" onChange={(e) => setPoint(i, { detail: e.target.value })} />
                        </div>
                    ))}
                    <button className="tiny" onClick={() => setRc((r) => ({ ...r, custom: [...r.custom, { key: `p${Date.now().toString(36)}`, title: "", pass: "informational", detail: "" }] }))}>+ point</button>
                </div>
                <label>Do not flag (one rule per line, added to the checklist's own list) <textarea value={doNotFlagText} onChange={(e) => setDoNotFlagText(e.target.value)} placeholder={"Missing docstrings on private helpers\nTest files longer than 300 lines"} /></label>
                {rcDefault && <span className="field-hint">Default: gstack's full checklist, nothing added.</span>}
            </Section>

        </div>
    );
};
