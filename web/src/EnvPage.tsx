import { useEffect, useState } from "react";
import { api, type Account, type Env, type EnvRules, type Rules } from "./api";

// Full-page environment configuration: general, Claude config dir (account), services, rules (skills + guard hook), PR templates.

const splitLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
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

export const EnvPage = ({ env, accounts, onBack, onChanged, onError }: { env: Env; accounts: Account[]; onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void }) => {
    const [saving, setSaving] = useState<string | null>(null);
    const [info, setInfo] = useState<EnvRules | null>(null);
    useEffect(() => {
        void api.envRules(env.id).then(setInfo).catch((e: Error) => onError(e.message));
    }, [env.id, env.rules, onError]);

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
    // ---- claude config dir
    const [acc, setAcc] = useState(env.default_account_id ?? "");
    const [adoptName, setAdoptName] = useState("");
    const [adoptDir, setAdoptDir] = useState("");
    // ---- services
    const [s, setS] = useState({
        appUrl: env.app_url ?? "", beCommand: env.be_command ?? "", feCommand: env.fe_command ?? "", beUrlTemplate: env.be_url_template ?? "", feUrlTemplate: env.fe_url_template ?? "",
        bePort: env.be_port ? String(env.be_port) : "", fePort: env.fe_port ? String(env.fe_port) : "", setupCommand: env.setup_command ?? "", envVars: env.env_vars ?? "",
    });
    // ---- rules
    const [r, setR] = useState<Rules | null>(null);
    useEffect(() => {
        if (info) setR(info.rules);
    }, [info]);

    const set = <T extends object>(setter: React.Dispatch<React.SetStateAction<T>>) => (k: keyof T) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setter((prev) => ({ ...prev, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
    const sg = set(setG);
    const ss = set(setS);

    return (
        <div className="env-page">
            <button className="back-link" onClick={onBack}>← tasks</button>
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

            <Section title="Claude config dir" hint="Every agent run for this environment (research, design, QA, implementation, helpers, the terminal) uses this Claude config dir: its login, skills, plugins, MCP servers and CLAUDE.md. A task can still override it." saving={saving === "claude"} onSave={() => save("claude", { defaultAccountId: nul(acc) })}>
                <label>Config dir
                    <select value={acc} onChange={(e) => setAcc(e.target.value)}>
                        <option value="">— none (first logged-in account) —</option>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.config_dir}{a.logged_in ? "" : " (not logged in)"}</option>)}
                    </select>
                </label>
                <details>
                    <summary>Adopt another directory as a config dir</summary>
                    <div className="env-fields">
                        <label>Account name <input value={adoptName} onChange={(e) => setAdoptName(e.target.value)} placeholder="dualentry" /></label>
                        <label>Directory <input value={adoptDir} onChange={(e) => setAdoptDir(e.target.value)} placeholder="/Users/you/code/project/.claude" /></label>
                        <button disabled={!adoptName || !adoptDir} onClick={async () => {
                            try {
                                const res = await api.adoptAccount(adoptName.trim(), adoptDir.trim());
                                await onChanged();
                                setAcc(res.account.id);
                                setAdoptName(""); setAdoptDir("");
                            } catch (e) { onError(String((e as Error).message ?? e)); }
                        }}>Adopt (checks login and Chrome)</button>
                    </div>
                </details>
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

            {r && info && (
                <Section title="Rules" hint="The same three skills (/git-commit, /git-branch, /pr-description) and one guard hook are generated for every environment; only these values differ. The hook blocks a git commit, push, branch name or `gh pr create` that breaks them and tells the agent why." saving={saving === "rules"} onSave={() => save("rules", { rules: r })}>
                    <h3>Commits</h3>
                    <label><input type="checkbox" checked={r.allowCommit} onChange={(e) => setR({ ...r, allowCommit: e.target.checked })} /> Agents may create commits (off = they leave changes uncommitted and say so)</label>
                    <label>Commit message pattern (regex on the first line) <input value={r.commitPattern} onChange={(e) => setR({ ...r, commitPattern: e.target.value })} /></label>
                    <label>Forbidden in commit messages (regex per line) <textarea value={r.commitForbid.join("\n")} onChange={(e) => setR({ ...r, commitForbid: splitLines(e.target.value) })} /></label>
                    <label>Commit message guidance (shown to agents) <input value={r.commitHint} onChange={(e) => setR({ ...r, commitHint: e.target.value })} /></label>
                    <h3>Branches</h3>
                    <label>Branch name pattern (regex, applied after the prefix) <input value={r.branchPattern} onChange={(e) => setR({ ...r, branchPattern: e.target.value })} /></label>
                    <label>Branch name guidance <input value={r.branchHint} onChange={(e) => setR({ ...r, branchHint: e.target.value })} /></label>
                    <h3>Push and pull requests</h3>
                    <label><input type="checkbox" checked={r.allowPush} onChange={(e) => setR({ ...r, allowPush: e.target.checked })} /> Auto-pushing the task branch is allowed</label>
                    <label><input type="checkbox" checked={r.allowPrCreate} onChange={(e) => setR({ ...r, allowPrCreate: e.target.checked })} /> Auto-creating the pull request (after you approve the draft) is allowed</label>
                    <label>PR description rules <textarea value={r.prRules} onChange={(e) => setR({ ...r, prRules: e.target.value })} className="tall" /></label>
                    <label>PR template path override (relative to the repo; empty = auto-detect) <input value={r.prTemplatePath ?? ""} onChange={(e) => setR({ ...r, prTemplatePath: nul(e.target.value) })} placeholder=".github/pull_request_template.md" /></label>
                    <div className="kv">
                        <b>Detected templates</b>
                        <span>{info.prTemplates.map((t) => `${t.dir === "." ? "" : `${t.dir}: `}${t.path ?? "none"}`).join(" · ")}{info.prTemplates.some((t) => t.overridden) ? " (override)" : ""}</span>
                        <b>Guard hook</b><code>{info.guardHook}</code>
                    </div>
                    <div className="actions"><button onClick={() => setR(info.defaults)}>Reset to defaults</button></div>
                </Section>
            )}
        </div>
    );
};
