import { useEffect, useState } from "react";
import { accountUsableWith, api, type Account, type ConfigDir, type Env, type EnvRules } from "./api";

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

export const EnvPage = ({ env, accounts, configDirs, onBack, onOpenDir, onChanged, onError }: {
    env: Env; accounts: Account[]; configDirs: ConfigDir[]; onBack: () => void; onOpenDir: (id: string) => void; onChanged: () => Promise<void>; onError: (m: string) => void;
}) => {
    const [saving, setSaving] = useState<string | null>(null);
    const [info, setInfo] = useState<EnvRules | null>(null);
    useEffect(() => {
        void api.envRules(env.id).then(setInfo).catch((e: Error) => onError(e.message));
    }, [env.id, env.config_dir_id, onError]);

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
    // ---- claude config dir + default AI account
    const [acc, setAcc] = useState(env.default_account_id ?? "");
    const [dirId, setDirId] = useState(env.config_dir_id ?? "");
    const dirPath = configDirs.find((d) => d.id === dirId)?.path ?? info?.configDir.path ?? "";
    // ---- services
    const [s, setS] = useState({
        appUrl: env.app_url ?? "", beCommand: env.be_command ?? "", feCommand: env.fe_command ?? "", beUrlTemplate: env.be_url_template ?? "", feUrlTemplate: env.fe_url_template ?? "",
        bePort: env.be_port ? String(env.be_port) : "", fePort: env.fe_port ? String(env.fe_port) : "", setupCommand: env.setup_command ?? "", envVars: env.env_vars ?? "",
    });
    const set =<T extends object>(setter: React.Dispatch<React.SetStateAction<T>>) => (k: keyof T) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setter((prev) => ({ ...prev, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
    const sg = set(setG);
    const ss = set(setS);

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

            <Section title="Claude config dir and AI account" hint="Every agent run for this environment (research, design, QA, implementation, helpers, the terminal) uses the config dir: its skills, hooks, subagents, MCP servers, CLAUDE.md and the commit/branch/PR rules. The AI account only supplies the login; when it hits a rate limit another usable account takes over (per-account failover toggle)." saving={saving === "claude"} onSave={() => save("claude", { configDirId: nul(dirId), defaultAccountId: nul(acc) })}>
                <label>Config dir
                    <select value={dirId} onChange={(e) => setDirId(e.target.value)}>
                        <option value="">— server default —</option>
                        {configDirs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.path}{d.chrome_capable ? " · chrome" : ""}</option>)}
                    </select>
                    {dirId && <span className="field-hint"><a href="#" onClick={(e) => { e.preventDefault(); onOpenDir(dirId); }}>Edit this dir's rules and see what it contains</a></span>}
                </label>
                <label>Default AI account
                    <select value={acc} onChange={(e) => setAcc(e.target.value)}>
                        <option value="">— first account that can run in this dir —</option>
                        {accounts.map((a) => {
                            const ok = dirPath ? accountUsableWith(a, dirPath) : a.logged_in === 1;
                            return <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ""}{ok ? "" : a.logged_in ? " (cannot run in this dir — needs a token)" : " (not logged in)"}</option>;
                        })}
                    </select>
                </label>
                {info && (
                    <div className="kv">
                        <b>Accounts that can run here</b><span>{info.usableAccounts.length ? info.usableAccounts.map((id) => accounts.find((a) => a.id === id)?.name ?? id).join(", ") : "none — set up a token on the AI accounts page"}</span>
                        <b>Rules in effect</b><span>commits {info.rules.allowCommit ? "allowed" : "off"} · push {info.rules.allowPush ? "allowed" : "off"} · PR creation {info.rules.allowPrCreate ? "allowed" : "off"} · branch <code>{info.rules.branchPattern}</code></span>
                        <b>PR templates</b><span>{info.prTemplates.map((t) => `${t.dir === "." ? "" : `${t.dir}: `}${t.path ?? "none"}`).join(" · ")}{info.prTemplates.some((t) => t.overridden) ? " (override)" : ""}</span>
                    </div>
                )}
            </Section>

            <Section title="Services" hint="Placeholders: {{port}}, {{url}}, {{bePort}}, {{beUrl}} (FE only), {{worktree}}, {{taskDir}}, {{envPath}} (setup only). Commands run from the task's worktree in tmux." saving={saving === "services"} onSave={() => save("services", {
                appUrl: nul(s.appUrl), beCommand: nul(s.beCommand), feCommand: nul(s.feCommand), beUrlTemplate: nul(s.beUrlTemplate), feUrlTemplate: nul(s.feUrlTemplate),
                bePort: s.bePort.trim() ? Number(s.bePort) : null, fePort: s.fePort.trim() ? Number(s.fePort) : null, setupCommand: nul(s.setupCommand), envVars: nul(s.envVars),
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
                <label>BE command <textarea value={s.beCommand} onChange={ss("beCommand")} /></label>
                <label>FE command <textarea value={s.feCommand} onChange={ss("feCommand")} /></label>
            </Section>

        </div>
    );
};
