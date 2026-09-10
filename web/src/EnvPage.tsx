import { useEffect, useState } from "react";
import { accountOrderOf, accountUsableWith, api, type Account, type ConfigDir, type Env, type EnvDependencyStatus, type EnvRules } from "./api";

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
        qaSeedHints: env.qa_seed_hints ?? "", cleanupCommand: env.cleanup_command ?? "",
    });
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
                <label>Branch prefix <input value={g.branchPrefix} onChange={sg("branchPrefix")} placeholder="e.g. stepanb/ — prepended to the branch research proposes" /></label>
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
                qaSeedHints: nul(s.qaSeedHints), cleanupCommand: nul(s.cleanupCommand),
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
                <label>Cleanup command (runs from the worktree when a task is cleaned up, after BE/FE stop and before the worktree is removed — drop a per-task database, free caches; {"{{worktree}}"} / {"{{envPath}}"}) <textarea value={s.cleanupCommand} onChange={ss("cleanupCommand")} placeholder="optional" /></label>
                <label>BE command <textarea value={s.beCommand} onChange={ss("beCommand")} /></label>
                <label>FE command <textarea value={s.feCommand} onChange={ss("feCommand")} /></label>
                <label>Seeding hints for QA (how agents create test data here: local DB connection and key tables, API auth, seed scripts; given to the Design and QA prompts verbatim) <textarea value={s.qaSeedHints} onChange={ss("qaSeedHints")} className="tall" placeholder={"Local Postgres: PGPASSWORD=… psql -h localhost -p 5433 -U … -d …\nDeals live in deal, pro formas in pro_forma; sources in pro_forma_source (source_type_id …)\nPrefer SQL for numeric inputs; the pro forma table UI is slow to edit."} /></label>
            </Section>

        </div>
    );
};
