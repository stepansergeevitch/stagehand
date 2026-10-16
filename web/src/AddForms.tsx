import { useState } from "react";
import { api, type Account, type ConfigDir } from "./api";
import { Button, Input, Select } from "@vortex/ds";

const splitRepos = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

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
    const [ticketSource, setTicketSource] = useState<"clickup" | "linear">("clickup");
    const repoList = splitRepos(repos);
    return (
        <>
            <label>Name <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Path <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/code/repo — or a workspace folder holding several repos" /></label>
            <label>Sub-repositories (comma-separated; empty = the path itself is the git repo) <Input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="backend, frontend" /></label>
            <label>Base branch <Input value={base} onChange={(e) => setBase(e.target.value)} /></label>
            <label>Task system (how bare ids like ABC-123 are resolved)
                <Select value={ticketSource} onChange={(e) => setTicketSource(e.target.value as "clickup" | "linear")}>
                    <option value="clickup">ClickUp</option><option value="linear">Linear</option>
                </Select>
            </label>
            <label>App URL for QA <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://localhost:3000" /></label>
            <label>Claude config dir
                <Select value={dirId} onChange={(e) => setDirId(e.target.value)}>
                    <option value="">— auto: {"<path>"}/.claude if registered, else the first dir —</option>
                    {configDirs.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.path}</option>)}
                </Select>
            </label>
            <label>First AI account (the environment page lets you list more, in priority order)
                <Select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    <option value="">— any account that can run in the dir —</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
            </label>
            <Button variant="primary"
 
 disabled={!name || !path}
 onClick={() =>
 onSubmit({
 name,
 path,
 baseBranch: base,
 ticketSource,
 ...(acc ? { defaultAccountId: acc } : {}),
 ...(dirId ? { configDirId: dirId } : {}),
 ...(appUrl ? { appUrl } : {}),
 ...(repoList.length ? { repos: repoList } : {}),
 })
 }
>
                Add
            </Button>
        </>
    );
};

export const AccountForm = ({ onSubmit }: { onSubmit: (name: string, email?: string) => Promise<void> }) => {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    return (
        <>
            <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13 }}>Opens a terminal running <code>claude setup-token</code>: finish the claude.ai login in the browser (pick the right account there — the email below is only a label), paste the code back if asked. Vortex stores the resulting long-lived token and closes the terminal; the account then works in any config dir.</p>
            <label>Name <Input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="work" /></label>
            <label>Email (label) <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
            <Button variant="primary" disabled={!/^[a-z0-9-]+$/.test(name)} onClick={() => onSubmit(name, email || undefined)}>Set up token</Button>
        </>
    );
};
