import { useState } from "react";
import { splitCsv } from "./format";
import { api, type Account, type ConfigDir } from "./api";
import { Field } from "./components/EntityView";
import { Button, Input, Notice, Select } from "@vortex/ds";
import "./settings.css";

// The create dialogs' forms (rendered inside a Modal): label above each input, the submit pinned at the bottom.


export const EnvForm = ({
    accounts,
    configDirs,
    onSubmit,
}: {
    accounts: Account[];
    configDirs: ConfigDir[];
    onSubmit: (b: Parameters<typeof api.addEnv>[0]) => Promise<void>;
}) => {
    const [name, setName] = useState("");
    const [path, setPath] = useState("");
    const [base, setBase] = useState("main");
    const [acc, setAcc] = useState("");
    const [dirId, setDirId] = useState("");
    const [appUrl, setAppUrl] = useState("");
    const [repos, setRepos] = useState("");
    const [ticketSource, setTicketSource] = useState<"clickup" | "linear" | "tasksmd">("clickup");
    const [busy, setBusy] = useState(false);
    const repoList = splitCsv(repos);
    const submit = async (): Promise<void> => {
        setBusy(true);
        try {
            await onSubmit({
                name,
                path,
                baseBranch: base,
                ticketSource,
                ...(acc ? { defaultAccountId: acc } : {}),
                ...(dirId ? { configDirId: dirId } : {}),
                ...(appUrl ? { appUrl } : {}),
                ...(repoList.length ? { repos: repoList } : {}),
            });
        } finally {
            setBusy(false);
        }
    };
    return (
        <form className="modal-form" onSubmit={(e) => { e.preventDefault(); if (name && path) void submit(); }}>
            <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Path" hint="The git repository, or a workspace folder holding several repositories."><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/code/repo" /></Field>
            <Field label="Sub-repositories" hint="Comma-separated directories of the path that are git repositories. Empty: the path itself is the git repository."><Input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="backend, frontend" /></Field>
            <Field label="Base branch"><Input value={base} onChange={(e) => setBase(e.target.value)} /></Field>
            <Field label="Task system" hint="How bare ticket ids like ABC-123 are resolved.">
                <Select value={ticketSource} onChange={(e) => setTicketSource(e.target.value as "clickup" | "linear" | "tasksmd")}>
                    <option value="clickup">ClickUp</option><option value="linear">Linear</option><option value="tasksmd">Tasks.md</option>
                </Select>
            </Field>
            <Field label="App URL for QA"><Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://localhost:3000" /></Field>
            <Field label="Claude config dir">
                <Select value={dirId} onChange={(e) => setDirId(e.target.value)}>
                    <option value="">Auto: {"<path>"}/.claude if registered, else the first dir</option>
                    {configDirs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.path}</option>)}
                </Select>
            </Field>
            <Field label="First AI account" hint="The environment page lets you list more, in priority order.">
                <Select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    <option value="">Any account that can run in the dir</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
            </Field>
            <div className="modal-form-actions">
                <Button type="submit" variant="primary" disabled={!name || !path || busy}>{busy ? "Adding…" : "Add environment"}</Button>
            </div>
        </form>
    );
};

export const AccountForm = ({ onSubmit }: { onSubmit: (name: string, email?: string) => Promise<void> }) => {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [busy, setBusy] = useState(false);
    const valid = /^[a-z0-9-]+$/.test(name);
    const submit = async (): Promise<void> => {
        setBusy(true);
        try {
            await onSubmit(name, email || undefined);
        } finally {
            setBusy(false);
        }
    };
    return (
        <form className="modal-form" onSubmit={(e) => { e.preventDefault(); if (valid) void submit(); }}>
            <Notice tone="info">
                Opens a terminal running <code>claude setup-token</code>. Finish the claude.ai login in the browser, choosing the right account there, and paste the code back if asked. Vortex stores the long-lived token and closes the terminal; the account then works in any config dir.
            </Notice>
            <Field label="Name" hint="Lowercase letters, digits and dashes."><Input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="work" invalid={name !== "" && !valid} /></Field>
            <Field label="Email" hint="Only a label; the account is the one you log in with."><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></Field>
            <div className="modal-form-actions">
                <Button type="submit" variant="primary" disabled={!valid || busy}>{busy ? "Opening…" : "Set up token"}</Button>
            </div>
        </form>
    );
};
