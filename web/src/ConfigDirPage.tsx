import { useEffect, useState } from "react";
import { api, chromeBrowserLabel, type ConfigDir, type ConfigDirRules, type Rules } from "./api";

// One Claude config dir: what it contributes to every agent run (skills, hooks, agents, MCP servers), whether its
// Chrome bridge works, and the commit/branch/PR rules Stagehand enforces for environments using it.

const splitLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
const nul = (s: string) => (s.trim() === "" ? null : s);

const Section = ({ title, hint, children, onSave, saving }: { title: string; hint?: string; children: React.ReactNode; onSave?: () => Promise<void>; saving?: boolean }) => (
    <section className="card env-section">
        <h2>{title}</h2>
        {hint && <p className="field-hint">{hint}</p>}
        <div className="env-fields">{children}</div>
        {onSave && (
            <div className="actions">
                <button className="primary" disabled={saving} onClick={() => void onSave()}>{saving ? "Saving…" : "Save"}</button>
            </div>
        )}
    </section>
);

const List = ({ items, empty }: { items: string[]; empty: string }) => (items.length ? <span>{items.join(", ")}</span> : <span className="quiet">{empty}</span>);

export const ConfigDirPage = ({ dir, onBack, onChanged, onError, onTerminal }: { dir: ConfigDir; onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void; onTerminal: (name: string) => void }) => {
    const [saving, setSaving] = useState<string | null>(null);
    const [info, setInfo] = useState<ConfigDirRules | null>(null);
    const [r, setR] = useState<Rules | null>(null);
    const [name, setName] = useState(dir.name);
    const [probing, setProbing] = useState(false);
    const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null);
    useEffect(() => {
        void api.configDirRules(dir.id).then((i) => { setInfo(i); setR(i.rules); }).catch((e: Error) => onError(e.message));
    }, [dir.id, dir.rules, onError]);

    const save = async (section: string, body: Parameters<typeof api.patchConfigDir>[1]) => {
        setSaving(section);
        try {
            await api.patchConfigDir(dir.id, body);
            await onChanged();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setSaving(null);
        }
    };
    const c = dir.contents;

    return (
        <div className="env-page">
            <button className="back-link" onClick={onBack}>← config dirs</button>
            <h1>{dir.name}</h1>
            <div className="sub"><code>{dir.path}</code></div>

            <Section title="General" saving={saving === "general"} onSave={() => save("general", { name })}>
                <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
                <div className="kv">
                    <b>Used by</b><List items={dir.envs} empty="no environment yet" />
                    <b>Accounts that can run here</b><List items={dir.usable_accounts} empty="none — accounts need a token, or a legacy login in this very dir" />
                </div>
            </Section>

            <Section title="What agents inherit from this dir" hint="Read live from disk. Every agent run in an environment using this dir gets these skills, hooks, subagents, commands, MCP servers and CLAUDE.md — switch the environment's dir and its behaviour switches with it.">
                {!c.exists && <div className="blocked-box">This directory does not exist.</div>}
                <div className="kv">
                    <b>Skills</b><List items={c.skills} empty="none" />
                    <b>Hooks</b><List items={c.hooks} empty="none" />
                    <b>Subagents</b><List items={c.agents} empty="none" />
                    <b>Commands</b><List items={c.commands} empty="none" />
                    <b>MCP servers</b><List items={c.mcpServers} empty="none" />
                    <b>Plugins</b><span>{c.plugins}</span>
                    <b>CLAUDE.md</b><span>{c.hasClaudeMd ? "present" : "none"}</span>
                    <b>settings.json</b><span>{c.hasSettings ? "present" : "none"}</span>
                </div>
            </Section>

            <Section title="Browser login and Chrome" hint="Claude Code disables the Chrome bridge for token sessions, so browser stages (QA, the login helper) run with the claude.ai login stored in this dir and are charged to the account with that email. Log in once with the browser form, then probe: the probe also lists the Chrome profiles that have the extension, which environments pick from.">
                <div className="kv">
                    <b>Browser login</b>
                    <span>{dir.login_ok === null ? <span className="chip">unknown — probe</span> : dir.login_ok ? <span className="chip ok">{dir.login_email ?? "logged in"}</span> : <span className="chip bad">none</span>}</span>
                    <b>Chrome bridge</b>
                    <span>{dir.chrome_capable === null ? <span className="chip">not probed</span> : dir.chrome_capable ? <span className="chip ok">connected</span> : <span className="chip bad">not connected</span>}</span>
                    <b>Chrome profiles</b>
                    <span>{dir.browsers.length ? dir.browsers.map((b) => `${chromeBrowserLabel(b)}${b.account ? ` · ${b.account}` : ""}${b.profile ? "" : ` (${b.deviceId.slice(0, 8)})`}`).join(", ") : <span className="quiet">none seen — install the extension in a Chrome profile signed into this claude.ai account, then probe</span>}</span>
                </div>
                <div className="actions">
                    <button onClick={async () => { try { const r = await api.loginConfigDir(dir.id); onTerminal(r.terminal); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Log in (browser)</button>
                    <button disabled={probing} onClick={async () => { setProbing(true); setProbe({ ok: true, detail: "checking the login, then running a tiny --chrome agent…" }); try { const d = await api.probeConfigDir(dir.id); setProbe(d.probe ?? null); await onChanged(); } catch (e) { setProbe({ ok: false, detail: String((e as Error).message ?? e) }); } finally { setProbing(false); } }}>
                        {probing ? "Probing…" : "Probe Chrome"}
                    </button>
                </div>
                {probe && <div className={`test-result ${probe.ok ? "" : "bad"}`}>{probe.detail}</div>}
            </Section>

            {r && info && (
                <Section title="Rules" hint="Stagehand generates the same three skills (/git-commit, /git-branch, /pr-description) and one guard hook for every run in an environment using this dir; only these values differ. The hook blocks a git commit, push, branch name or `gh pr create` that breaks them and tells the agent why. Push/PR permissions also gate what the orchestrator does after you approve a PR draft." saving={saving === "rules"} onSave={() => save("rules", { rules: r })}>
                    <h3>Commits</h3>
                    <label><input type="checkbox" checked={r.allowCommit} onChange={(e) => setR({ ...r, allowCommit: e.target.checked })} /> Agents may create commits (off = they leave changes uncommitted and say so)</label>
                    <label>Commit message pattern (regex on the first line) <input value={r.commitPattern} onChange={(e) => setR({ ...r, commitPattern: e.target.value })} /></label>
                    <label>Forbidden in commit messages (regex per line) <textarea value={r.commitForbid.join("\n")} onChange={(e) => setR({ ...r, commitForbid: splitLines(e.target.value) })} /></label>
                    <label>Commit message guidance (shown to agents) <input value={r.commitHint} onChange={(e) => setR({ ...r, commitHint: e.target.value })} /></label>
                    <h3>Branches</h3>
                    <label>Branch name pattern (regex, applied after the environment's prefix) <input value={r.branchPattern} onChange={(e) => setR({ ...r, branchPattern: e.target.value })} /></label>
                    <label>Branch name guidance <input value={r.branchHint} onChange={(e) => setR({ ...r, branchHint: e.target.value })} /></label>
                    <h3>Push and pull requests</h3>
                    <label><input type="checkbox" checked={r.allowPush} onChange={(e) => setR({ ...r, allowPush: e.target.checked })} /> Auto-pushing the task branch is allowed</label>
                    <label><input type="checkbox" checked={r.allowPrCreate} onChange={(e) => setR({ ...r, allowPrCreate: e.target.checked })} /> Auto-creating the pull request (after you approve the draft) is allowed</label>
                    <label>PR description rules <textarea value={r.prRules} onChange={(e) => setR({ ...r, prRules: e.target.value })} className="tall" /></label>
                    <label>PR template path override (relative to the repo; empty = auto-detect per environment) <input value={r.prTemplatePath ?? ""} onChange={(e) => setR({ ...r, prTemplatePath: nul(e.target.value) })} placeholder=".github/pull_request_template.md" /></label>
                    <h3>GitHub comments</h3>
                    <label>Automation handles (one GitHub login per line; their PR comments go to the "Automation comments" tab; anything ending in [bot] counts too) <textarea value={r.automationHandles.join("\n")} onChange={(e) => setR({ ...r, automationHandles: splitLines(e.target.value) })} /></label>
                    <div className="kv">
                        <b>Guard hook</b><code>{info.guardHook}</code>
                    </div>
                    <div className="actions"><button onClick={() => setR(info.defaults)}>Reset to defaults</button></div>
                </Section>
            )}
        </div>
    );
};
