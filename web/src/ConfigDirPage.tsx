import { useEffect, useState } from "react";
import { api, type ClaudeMdFile, type ConfigDir, type ConfigDirRules, type Rules } from "./api";
import { CheckField, EntityForm, EntityView, Field, ReadField, useDraft, useSaver } from "./components/EntityView";
import { Button, Chip, Input, Textarea } from "@vortex/ds";

// One Claude config dir's entity view: what it contributes to every agent run (skills, hooks, agents, MCP servers) and
// the commit/branch/PR rules Stagehand enforces for environments using it.

const splitLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
const items = (xs: string[], empty = "none") => (xs.length ? xs.join(", ") : <span className="quiet">{empty}</span>);

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
            <ReadField label="Skills" hint={hint}>{items(c.skills)}</ReadField>
            <ReadField label="Hooks" hint={hint}>{items(c.hooks)}</ReadField>
            <ReadField label="Subagents" hint={hint}>{items(c.agents)}</ReadField>
            <ReadField label="Commands" hint={hint}>{items(c.commands)}</ReadField>
            <ReadField label="MCP servers" hint={hint}>{items(c.mcpServers)}</ReadField>
            <ReadField label="Plugins">{c.plugins}</ReadField>
            <ReadField label="CLAUDE.md">{c.hasClaudeMd ? "present" : "none"}</ReadField>
            <ReadField label="settings.json">{c.hasSettings ? "present" : "none"}</ReadField>
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
    if (!file) return <div className="empty">reading…</div>;
    const dirty = draft !== null && draft !== file.content;
    return (
        <EntityForm dirty={dirty} saving={saving === "md"} onDiscard={() => setDraft(null)} saveLabel={file.exists ? "Save" : "Create"} onSave={() => run("md", async () => { setFile((await api.saveConfigDirClaudeMd(dir.id, draft ?? "")).file); setDraft(null); })}>
            <Field label={<>CLAUDE.md <code>{file.path}</code>{!file.exists && <Chip tone="warn">none yet — saving creates it</Chip>}</>} hint="What every agent run of every environment using this dir reads first. An edit applies to the next run at once. The repositories' own CLAUDE.md files are on each environment.">
                <Textarea className="tall" spellCheck={false} value={draft ?? file.content} onChange={(e) => setDraft(e.target.value)} />
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
            <CheckField label="Agents may create commits" hint="Off: they leave changes uncommitted and say so." checked={r.allowCommit} onChange={(on) => d.patch({ allowCommit: on })} />
            <Field label="Commit message pattern" hint={`Regex on the first line. ${GUARD}`}><Input value={r.commitPattern} onChange={(e) => d.patch({ commitPattern: e.target.value })} /></Field>
            <Field label="Forbidden in commit messages" hint="One regex per line."><Textarea value={r.commitForbid.join("\n")} onChange={(e) => d.patch({ commitForbid: splitLines(e.target.value) })} /></Field>
            <Field label="Commit message guidance" hint="Shown to agents in the generated /git-commit skill."><Input value={r.commitHint} onChange={(e) => d.patch({ commitHint: e.target.value })} /></Field>
            <Field label="Branch prefix" hint="Prepended to every task branch Research proposes, e.g. yourname/. The branch name pattern below applies after it."><Input value={r.branchPrefix} onChange={(e) => d.patch({ branchPrefix: e.target.value })} /></Field>
            <Field label="Branch name pattern" hint={`Regex, applied after the environment's prefix. ${GUARD}`}><Input value={r.branchPattern} onChange={(e) => d.patch({ branchPattern: e.target.value })} /></Field>
            <Field label="Branch name guidance" hint="Shown to agents in the generated /git-branch skill."><Input value={r.branchHint} onChange={(e) => d.patch({ branchHint: e.target.value })} /></Field>
            <CheckField label="Auto-pushing the task branch is allowed" hint="Also gates what Stagehand does after you approve a PR draft." checked={r.allowPush} onChange={(on) => d.patch({ allowPush: on })} />
            <CheckField label="Auto-creating the pull request is allowed" hint="After you approve the PR draft." checked={r.allowPrCreate} onChange={(on) => d.patch({ allowPrCreate: on })} />
            <CheckField label="Open every PR as a draft" hint="You mark it ready for review yourself." checked={r.prDraft} onChange={(on) => d.patch({ prDraft: on })} />
            <Field label="PR description rules" hint="Given to the generated /pr-description skill."><Textarea className="tall" value={r.prRules} onChange={(e) => d.patch({ prRules: e.target.value })} /></Field>
            <Field label="Automation handles" hint="One GitHub login per line; their PR comments go to the Automation comments tab. Anything ending in [bot] counts too."><Textarea value={r.automationHandles.join("\n")} onChange={(e) => d.patch({ automationHandles: splitLines(e.target.value) })} /></Field>
            <ReadField label="Guard hook"><code>{info.guardHook}</code></ReadField>
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
            tabs={[
                { key: "general", label: "General", content: <GeneralTab dir={dir} save={save} saving={saving} /> },
                { key: "contents", label: "Contents", content: <ContentsTab dir={dir} /> },
                { key: "claude-md", label: "CLAUDE.md", content: <ClaudeMdTab dir={dir} onError={onError} /> },
                { key: "rules", label: "Rules", content: info ? <RulesTab dir={dir} info={info} save={save} saving={saving} /> : <div className="empty">loading…</div> },
            ]}
        />
    );
};
