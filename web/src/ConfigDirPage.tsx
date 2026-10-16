import { useEffect, useState } from "react";
import { api, type ClaudeMdFile, type ConfigDir, type ConfigDirRules, type Rules } from "./api";
import { CheckField, EntityForm, EntityView, Field, ReadField, useDraft, useSaver } from "./components/EntityView";
import { Section } from "./components/Panel";
import { CodeArea, Loading } from "./SettingsParts";
import { Button, Chip, Input } from "@vortex/ds";

// One Claude config dir's entity view: what it contributes to every agent run (skills, hooks, agents, MCP servers) and
// the commit/branch/PR rules Vortex enforces for environments using it.

const splitLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
// A list of names as chips; nothing as a neutral "none" chip.
const items = (xs: string[], empty = "none") => (xs.length ? <>{xs.map((x) => <Chip key={x}>{x}</Chip>)}</> : <Chip>{empty}</Chip>);

type Save = (key: string, body: Parameters<typeof api.patchConfigDir>[1]) => Promise<void>;

const GeneralTab = ({ dir, save, saving }: { dir: ConfigDir; save: Save; saving: string | null }) => {
    const d = useDraft(() => ({ name: dir.name }), [dir]);
    return (
        <EntityForm dirty={d.dirty} saving={saving === "general"} onDiscard={d.reset} onSave={() => save("general", { name: d.value.name })}>
            <ReadField label="Path"><code>{dir.path}</code>{!dir.contents.exists && <Chip tone="bad">missing on disk</Chip>}</ReadField>
            <Field label="Name"><Input value={d.value.name} onChange={(e) => d.patch({ name: e.target.value })} /></Field>
            <ReadField label="Used by">{items(dir.envs, "no environment yet")}</ReadField>
            <ReadField label="Accounts that can run here" hint="Accounts need a token, or a legacy login in this very dir. Browser stages (QA, the login helper) run under an account's browser login; this dir's skills, hooks and rules are mirrored into that account's browser dir for the run.">{items(dir.usable_accounts, "none")}</ReadField>
        </EntityForm>
    );
};

const ContentsTab = ({ dir }: { dir: ConfigDir }) => {
    const c = dir.contents;
    const hint = "Read live from disk. Every agent run in an environment using this dir gets it.";
    return (
        <div className="ev-fields">
            <Section title="Extends every agent run" hint={hint}>
                <ReadField label="Skills">{items(c.skills)}</ReadField>
                <ReadField label="Hooks">{items(c.hooks)}</ReadField>
                <ReadField label="Subagents">{items(c.agents)}</ReadField>
                <ReadField label="Commands">{items(c.commands)}</ReadField>
                <ReadField label="MCP servers">{items(c.mcpServers)}</ReadField>
            </Section>
            <Section title="Files">
                <ReadField label="Plugins">{c.plugins}</ReadField>
                <ReadField label="CLAUDE.md"><Chip tone={c.hasClaudeMd ? "ok" : "neutral"}>{c.hasClaudeMd ? "present" : "none"}</Chip></ReadField>
                <ReadField label="settings.json"><Chip tone={c.hasSettings ? "ok" : "neutral"}>{c.hasSettings ? "present" : "none"}</Chip></ReadField>
            </Section>
        </div>
    );
};

const ClaudeMdTab = ({ dir, onError }: { dir: ConfigDir; onError: (m: string) => void }) => {
    const [file, setFile] = useState<ClaudeMdFile | null>(null);
    const [draft, setDraft] = useState<string | null>(null);
    const { saving, run } = useSaver(onError);
    useEffect(() => {
        setFile(null);
        setDraft(null);
        void api.configDirClaudeMd(dir.id).then((r) => setFile(r.file)).catch((e: Error) => onError(e.message));
    }, [dir.id, onError]);
    if (!file) return <Loading lines={2} />;
    const dirty = draft !== null && draft !== file.content;
    return (
        <EntityForm dirty={dirty} saving={saving === "md"} onDiscard={() => setDraft(null)} saveLabel={file.exists ? "Save" : "Create"} onSave={() => run("md", async () => { setFile((await api.saveConfigDirClaudeMd(dir.id, draft ?? "")).file); setDraft(null); })}>
            <Field label="CLAUDE.md" hint="What every agent run of every environment using this dir reads first. An edit applies to the next run at once. The repositories' own CLAUDE.md files are on each environment.">
                <div className="file-meta"><code>{file.path}</code>{!file.exists && <Chip tone="warn">none yet — saving creates it</Chip>}</div>
                <CodeArea size="lg" prose value={draft ?? file.content} onChange={(e) => setDraft(e.target.value)} />
            </Field>
        </EntityForm>
    );
};

const RulesTab = ({ dir, info, save, saving }: { dir: ConfigDir; info: ConfigDirRules; save: Save; saving: string | null }) => {
    const d = useDraft<Rules>(() => info.rules, [dir, info]);
    const r = d.value;
    const GUARD = "Enforced by the guard hook every run of an environment using this dir gets: a git commit, push, branch name or gh pr create that breaks a rule is blocked and the agent is told why.";
    return (
        <EntityForm dirty={d.dirty} saving={saving === "rules"} onDiscard={d.reset} onSave={() => save("rules", { rules: r })} extra={<Button onClick={() => d.setValue(info.defaults)}>Reset to defaults</Button>}>
            <Section title="Commits">
                <CheckField label="Agents may create commits" hint="Off: they leave changes uncommitted and say so." checked={r.allowCommit} onChange={(on) => d.patch({ allowCommit: on })} />
                <Field label="Commit message pattern" hint={`Regex on the first line. ${GUARD}`}><Input value={r.commitPattern} onChange={(e) => d.patch({ commitPattern: e.target.value })} /></Field>
                <Field label="Forbidden in commit messages" hint="One regex per line."><CodeArea value={r.commitForbid.join("\n")} onChange={(e) => d.patch({ commitForbid: splitLines(e.target.value) })} /></Field>
                <Field label="Commit message guidance" hint="Shown to agents in the generated /git-commit skill."><Input value={r.commitHint} onChange={(e) => d.patch({ commitHint: e.target.value })} /></Field>
            </Section>
            <Section title="Branches">
                <Field label="Branch prefix" hint="Prepended to every task branch Research proposes, e.g. yourname/. The branch name pattern below applies after it."><Input value={r.branchPrefix} onChange={(e) => d.patch({ branchPrefix: e.target.value })} /></Field>
                <Field label="Branch name pattern" hint={`Regex, applied after the environment's prefix. ${GUARD}`}><Input value={r.branchPattern} onChange={(e) => d.patch({ branchPattern: e.target.value })} /></Field>
                <Field label="Branch name guidance" hint="Shown to agents in the generated /git-branch skill."><Input value={r.branchHint} onChange={(e) => d.patch({ branchHint: e.target.value })} /></Field>
            </Section>
            <Section title="Pushes and pull requests">
                <CheckField label="Auto-pushing the task branch is allowed" hint="Also gates what Vortex does after you approve a PR draft." checked={r.allowPush} onChange={(on) => d.patch({ allowPush: on })} />
                <CheckField label="Auto-creating the pull request is allowed" hint="After you approve the PR draft." checked={r.allowPrCreate} onChange={(on) => d.patch({ allowPrCreate: on })} />
                <CheckField label="Open every PR as a draft" hint="You mark it ready for review yourself." checked={r.prDraft} onChange={(on) => d.patch({ prDraft: on })} />
                <Field label="PR description rules" hint="Given to the generated /pr-description skill."><CodeArea size="md" prose value={r.prRules} onChange={(e) => d.patch({ prRules: e.target.value })} /></Field>
                <Field label="Automation handles" hint="One GitHub login per line; their PR comments go to the Automation comments tab. Anything ending in [bot] counts too."><CodeArea value={r.automationHandles.join("\n")} onChange={(e) => d.patch({ automationHandles: splitLines(e.target.value) })} /></Field>
            </Section>
            <ReadField label="Guard hook" hint="The hook that enforces these rules in every run."><code>{info.guardHook}</code></ReadField>
        </EntityForm>
    );
};

export const ConfigDirPage = ({ dir, tab, onTab, onBack, onChanged, onError }: { tab: string | undefined; onTab: (t: string) => void; dir: ConfigDir; onBack: () => void; onChanged: () => Promise<void>; onError: (m: string) => void; onTerminal?: (name: string) => void }) => {
    const [info, setInfo] = useState<ConfigDirRules | null>(null);
    useEffect(() => {
        void api.configDirRules(dir.id).then(setInfo).catch((e: Error) => onError(e.message));
    }, [dir.id, dir.rules, onError]);
    const { saving, run } = useSaver(onError);
    const save: Save = (key, body) => run(key, async () => {
        await api.patchConfigDir(dir.id, body);
        await onChanged();
    });
    return (
        <EntityView tab={tab} onTab={onTab}
            type="Claude config dirs"
            onType={onBack}
            id={dir.name}
            meta={dir.contents.exists ? <Chip tone="ok">present</Chip> : <Chip tone="bad">missing on disk</Chip>}
            actions={<Button variant="danger" disabled={dir.envs.length > 0} title={dir.envs.length ? `Still used by ${dir.envs.join(", ")}` : "Forget the dir; nothing on disk changes"} onClick={() => { if (confirm(`Forget config dir ${dir.name}? Nothing on disk is touched.`)) void run("delete", async () => { await api.deleteConfigDir(dir.id); await onChanged(); onBack(); }); }}>Delete</Button>}
            tabs={[
                { key: "general", label: "General", content: <GeneralTab dir={dir} save={save} saving={saving} /> },
                { key: "contents", label: "Contents", content: <ContentsTab dir={dir} /> },
                { key: "claude-md", label: "CLAUDE.md", content: <ClaudeMdTab dir={dir} onError={onError} /> },
                { key: "rules", label: "Rules", content: info ? <RulesTab dir={dir} info={info} save={save} saving={saving} /> : <Loading /> },
            ]}
        />
    );
};
