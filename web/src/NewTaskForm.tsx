import { useEffect, useMemo, useRef, useState } from "react";
import { BranchPicker } from "./BranchPicker";
import { accountOrderOf, api, envRepos, poEnvIds, modelLabel, type Account, type Env, type MyTicket, type ProductOwner, type Readiness, type SharedFile, type Settings } from "./api";
import { AgentInput, usePendingFiles } from "./AgentInput";
import { Modal } from "./components/Modal";
import { Button, Chip, Hint, Input, Notice, Select, StatusDot, type Tone } from "@vortex/ds";
import "./tasks/newtask.css";

// ClickUp and Linear both use 1 = urgent … 4 = low; 0/null = unset.
const PRIORITY: Record<number, { tone: Tone; label: string }> = { 1: { tone: "bad", label: "Urgent" }, 2: { tone: "warn", label: "High" }, 3: { tone: "info", label: "Medium" }, 4: { tone: "neutral", label: "Low" } };

// Splits pasted ticket ids/links (one per line, or separated by commas/spaces).
const splitTickets = (s: string): string[] => [...new Set(s.split(/[\n,;]+|\s+(?=[A-Za-z]|https?:)/).map((x) => x.trim()).filter(Boolean))];
const looksLikeTicket = (s: string): boolean => /app\.clickup\.com\/t\//.test(s) || /linear\.app\/.+\/issue\//.test(s) || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s) || /^[a-z0-9]{6,12}$/i.test(s);
// What a chip shows for a pasted link: its last path segment.
const shortRef = (s: string): string => { if (!/^https?:/.test(s)) return s; try { return decodeURIComponent(s.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? s); } catch { return s; } };
const SHOWN = 6;

export type NewTaskBody = { tickets: string[]; mode: "each" | "batch"; accountId?: string; model?: string; notes?: string; baseBranch?: string | Record<string, string>; productOwnerId?: string | null; files?: SharedFile[] };

const Section = ({ title, summary, children }: { title: string; summary?: string; children: React.ReactNode }) => (
    <details className="nt-sum">
        <summary><b>{title}</b><span className="nt-sum-val">{summary}</span><span className="nt-sum-caret" aria-hidden="true">▸</span></summary>
        <div className="nt-sum-body">{children}</div>
    </details>
);

const TaskFormBody = ({ accounts, env, settings, readiness, onSubmit, footerRef }: {
    accounts: Account[]; env: Env; settings: Settings | null; readiness: Readiness | undefined;
    onSubmit: (body: NewTaskBody) => Promise<void>;
    footerRef: (s: { label: string; disabled: boolean; submit: () => void }) => void;
}) => {
    const [list, setList] = useState<string[]>([]);
    const [draft, setDraft] = useState("");
    const [status, setStatus] = useState<{ bad: boolean; text: string } | null>(null);
    const [q, setQ] = useState("");
    const [showAll, setShowAll] = useState(false);
    // "" = automatic (the PO whose project the ticket belongs to), "none" = no PO, else a PO id.
    const [owner, setOwner] = useState("");
    const [owners, setOwners] = useState<ProductOwner[]>([]);
    useEffect(() => { void api.productOwners().then(setOwners).catch(() => setOwners([])); }, []);
    const [mode, setMode] = useState<"each" | "batch">("each");
    const [notes, setNotes] = useState("");
    const pending = usePendingFiles();
    // One base branch per repository ("" = the single repo); empty = the env default.
    const repoKeys = useMemo(() => { const r = envRepos(env); return r.length ? r : [""]; }, [env]);
    const [bases, setBases] = useState<Record<string, string>>({});
    const baseBranch = ((): string | Record<string, string> | undefined => {
        const given: Record<string, string> = Object.fromEntries(repoKeys.map((k) => [k, (bases[k] ?? "").trim()] as const).filter(([, v]) => v && v !== env.base_branch));
        const values: string[] = [...new Set(Object.values(given))];
        if (values.length === 0) return undefined;
        return repoKeys.length === 1 || (values.length === 1 && Object.keys(given).length === repoKeys.length) ? values[0] : given;
    })();
    const [acc, setAcc] = useState(accountOrderOf(env).find((id) => accounts.some((a) => a.id === id)) ?? accounts[0]?.id ?? "");
    const [model, setModel] = useState("");
    const [mine, setMine] = useState<{ tickets: MyTicket[]; error?: string } | null>(null);
    useEffect(() => {
        setMine(null);
        void api.myTickets(env.id).then(setMine).catch((e: Error) => setMine({ tickets: [], error: e.message }));
    }, [env.id]);

    const toggle = (id: string) => { setStatus(null); setList((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])); };
    // Pasted or typed text becomes chips; what is no ticket id or link stays in the box and is reported.
    const commit = (text: string): void => {
        const parts = splitTickets(text);
        const bad = parts.filter((t) => !looksLikeTicket(t));
        const fresh = parts.filter((t) => looksLikeTicket(t) && !list.includes(t));
        if (fresh.length) setList((l) => [...l, ...fresh]);
        setDraft(bad.join(" "));
        setStatus(bad.length ? { bad: true, text: `Not a ticket id or link: ${bad.join(", ")}` } : fresh.length ? { bad: false, text: `${fresh.length} added` } : null);
    };

    const all = mine?.tickets ?? [];
    // A chip's ticket: the sprint row with that id or link, when there is one (there is no other lookup).
    const known = (ref: string): MyTicket | undefined => all.find((t) => t.id.toLowerCase() === ref.toLowerCase() || (t.url && t.url === ref));
    const needle = q.trim().toLowerCase();
    const matching = all.filter((t) => !needle || t.id.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle));
    const visible = needle || showAll ? matching : matching.slice(0, SHOWN);
    const groups = useMemo(() => {
        const m = new Map<string, MyTicket[]>();
        for (const t of visible) { const g = t.priority === 1 || t.priority === 2 ? "Urgent and high" : "Normal"; m.set(g, [...(m.get(g) ?? []), t]); }
        return ["Urgent and high", "Normal"].filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as const);
    }, [visible]);
    const isPicked = (t: MyTicket): boolean => list.some((r) => r.toLowerCase() === t.id.toLowerCase() || (!!t.url && r === t.url));
    const toggleRow = (t: MyTicket) => { const ref = list.find((r) => r.toLowerCase() === t.id.toLowerCase() || (!!t.url && r === t.url)); toggle(ref ?? t.id); };

    const account = accounts.find((a) => a.id === acc);
    const ownerName = owner === "" ? "Automatic" : owner === "none" ? "None" : owners.find((o) => o.id === owner)?.title ?? "Automatic";
    const modelName = model === "" ? "Account default" : settings?.models.find((m) => m.value === model)?.label ?? model;
    const baseName = [...new Set(repoKeys.map((k) => (bases[k] ?? "").trim() || env.base_branch))].join(", ");
    const blocked = accounts.length === 0 ? "No account can run in this environment's config dir." : null;
    const label = list.length > 1 && mode === "each" ? `Create ${list.length} tasks` : "Create task";
    const disabled = list.length === 0 || blocked !== null;
    const submit = (): void => {
        if (disabled) return;
        void (async () => {
            let files: SharedFile[] = [];
            try {
                if (pending.files.length > 0) files = await api.uploadEnvFiles(env.id, pending.files);
            } catch (e) {
                setStatus({ bad: true, text: `Could not upload the files: ${(e as Error).message}` });
                return;
            }
            await onSubmit({ tickets: list, mode, ...(acc ? { accountId: acc } : {}), ...(model ? { model } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(baseBranch ? { baseBranch } : {}), ...(owner ? { productOwnerId: owner === "none" ? null : owner } : {}), ...(files.length ? { files } : {}) });
        })();
    };
    const submitRef = useRef(submit);
    submitRef.current = submit;
    useEffect(() => { footerRef({ label, disabled, submit: () => submitRef.current() }); }, [label, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <>
            {(blocked || (readiness && readiness.warnings.length > 0)) && (
                <Notice tone={blocked ? "bad" : "warn"}>
                    {blocked && <b>{blocked}</b>}
                    {readiness && readiness.warnings.length > 0 && <ul className="plain">{readiness.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                </Notice>
            )}
            <section className="nt-field" aria-label="Tickets">
                <label htmlFor="nt-tickets">Tickets</label>
                <div className="nt-chips" onClick={(e) => { if (e.target === e.currentTarget) document.getElementById("nt-tickets")?.focus(); }}>
                    {list.map((ref) => {
                        const t = known(ref);
                        return (
                            <Chip key={ref} tone="accent" className="nt-chip" title={t?.title ?? ref}>
                                <span className="mono">{t?.id ?? shortRef(ref)}</span>{t && <span className="nt-chip-title">{t.title}</span>}
                                <Button variant="ghost" type="button" className="nt-chip-x" onClick={() => toggle(ref)} aria-label={`Remove ${t?.id ?? shortRef(ref)}`}>×</Button>
                            </Chip>
                        );
                    })}
                    <Input
                        id="nt-tickets"
                        autoFocus
                        className="nt-chips-input"
                        value={draft}
                        placeholder={list.length ? "" : "Paste ids or links"}
                        onChange={(e) => setDraft(e.target.value)}
                        onPaste={(e) => { const text = e.clipboardData.getData("text"); if (text) { e.preventDefault(); commit(`${draft} ${text}`); } }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "," || e.key === ";") { if (draft.trim()) { e.preventDefault(); commit(draft); } }
                            else if (e.key === "Backspace" && !draft && list.length) toggle(list[list.length - 1]!);
                        }}
                        onBlur={() => { if (draft.trim()) commit(draft); }}
                    />
                </div>
                {status && <div className={`nt-status${status.bad ? " bad" : ""}`} role="status">{status.text}</div>}
                {mine?.error && <div className="nt-status bad" role="status">{mine.error}</div>}
                {mine && mine.tickets.length > 0 && (
                    <div className="nt-sprint">
                        <div className="nt-sprint-head">
                            <b>{env.ticket_source === "clickup" ? "From the current sprint" : env.ticket_source === "tasksmd" ? "From the board" : "Assigned to you"}</b><span className="mono nt-count">{all.length}</span>
                            <Input className="nt-filter" aria-label="Filter sprint tickets" placeholder="Filter by id or title" value={q} onChange={(e) => setQ(e.target.value)} />
                        </div>
                        <div role="listbox" aria-multiselectable="true" aria-label="Sprint tickets">
                            {groups.map(([g, tl]) => (
                                <div key={g}>
                                    <div className="nt-group">{g}</div>
                                    {tl.map((t) => (
                                        <label key={t.id} className={`nt-opt${isPicked(t) ? " on" : ""}`} role="option" aria-selected={isPicked(t)}>
                                            <Input type="checkbox" checked={isPicked(t)} onChange={() => toggleRow(t)} aria-label={t.id} />
                                            <span className="mono nt-opt-id">{t.id}</span>
                                            <span className="nt-opt-title">{t.title}{PRIORITY[t.priority ?? 0] && <StatusDot tone={PRIORITY[t.priority ?? 0]!.tone} title={PRIORITY[t.priority ?? 0]!.label} />}</span>
                                            <span className="nt-opt-status">{t.status}</span>
                                        </label>
                                    ))}
                                </div>
                            ))}
                            {matching.length === 0 && <div className="nt-more">Nothing matches.</div>}
                            {!needle && !showAll && matching.length > SHOWN && <Button variant="ghost" type="button" className="nt-more" onClick={() => setShowAll(true)}>{matching.length - SHOWN} more</Button>}
                        </div>
                    </div>
                )}
            </section>

            {list.length > 1 && (
                <div className="nt-modes" role="radiogroup" aria-label="Tasks to create">
                    <label className={mode === "each" ? "on" : ""}><input type="radio" name="nt-mode" checked={mode === "each"} onChange={() => setMode("each")} /><span className="nt-mode-long">One task per ticket</span><span className="nt-mode-short">One per ticket</span></label>
                    <label className={mode === "batch" ? "on" : ""}><input type="radio" name="nt-mode" checked={mode === "batch"} onChange={() => setMode("batch")} /><span className="nt-mode-long">One task for all</span><span className="nt-mode-short">One for all</span></label>
                </div>
            )}

            <div className="nt-rows">
                <Section title="Defaults" summary={[baseName, account?.name ?? "No account", modelName, owners.length ? ownerName : null].filter(Boolean).join(" · ")}>
                    <div className="nt-grid">
                        {repoKeys.map((repo) => (
                            <label key={repo}>Base branch{repo ? ` (${repo})` : ""}<Hint text={`The branch the work starts from and the PR targets. Default ${env.base_branch}. For a stacked PR, another task's branch${repoKeys.length > 1 ? " (per repository: a parent that touched only one repo leaves the other on the default)" : ""}; when that branch's PR merges, the task is rebased onto the new base automatically.`} />
                                <BranchPicker envId={env.id} repo={repo} value={bases[repo] ?? ""} onChange={(v) => setBases((b) => ({ ...b, [repo]: v }))} placeholder={env.base_branch} />
                            </label>
                        ))}
                        {owners.length > 0 && (
                            <label>Product owner
                                <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                                    <option value="">Automatic</option>
                                    <option value="none">None</option>
                                    {owners.filter((o) => poEnvIds(o).includes(env.id)).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                                </Select>
                            </label>
                        )}
                        <label>AI account
                            <Select value={acc} onChange={(e) => setAcc(e.target.value)}>
                                {accounts.length === 0 && <option value="">None</option>}
                                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ""}</option>)}
                            </Select>
                        </label>
                        <label>Claude model<Hint text="Applies to Design, Implementation and PR fixes; Research, QA and the PR draft run on Sonnet." />
                            <Select value={model} onChange={(e) => setModel(e.target.value)}>
                                {(settings?.models ?? [{ value: "", label: "Account default" }]).map((m) => (
                                    <option key={m.value} value={m.value}>
                                        {m.value === "" ? `Account default${(() => { const d = modelLabel(accounts.find((a) => a.id === acc)?.default_model, settings?.models); return d ? ` · ${d}` : " · not resolved yet, refresh the account"; })()}` : m.label}
                                    </option>
                                ))}
                            </Select>
                        </label>
                    </div>
                </Section>
                <Section title="Instructions" summary={notes.trim() ? notes.trim().replace(/\s+/g, " ").slice(0, 80) : undefined}>
                    <AgentInput value={notes} onChange={setNotes} pending={pending} placeholder="Constraints, where the code lives, what to skip, how to test…" className="short-text" />
                </Section>
            </div>
        </>
    );
};

// The New task dialog: the form in a Modal with Cancel / Create in its footer. C-g closes, C-c C-c creates.
export const NewTaskDialog = ({ onClose, ...rest }: { accounts: Account[]; env: Env; settings: Settings | null; readiness: Readiness | undefined; onSubmit: (body: NewTaskBody) => Promise<void>; onClose: () => void }) => {
    const [foot, setFoot] = useState<{ label: string; disabled: boolean; submit: () => void }>({ label: "Create task", disabled: true, submit: () => undefined });
    const footRef = useRef(foot);
    footRef.current = foot;
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let prefix = 0;
        const onKey = (e: KeyboardEvent): void => {
            if (!e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.code === "KeyG") { e.preventDefault(); e.stopPropagation(); closeRef.current(); return; }
            if (e.code === "KeyC") {
                // C-c is only a prefix when no text is selected, so copying still works.
                if (Date.now() - prefix < 1500) { prefix = 0; e.preventDefault(); footRef.current.submit(); }
                else if (!window.getSelection()?.toString()) { prefix = Date.now(); e.preventDefault(); }
            } else prefix = 0;
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, []);
    return (
        <Modal
            title={`New task in ${rest.env.name}`}
            onClose={onClose}
            sheet
            className="nt-box"
            footer={<><Button type="button" onClick={onClose}>Cancel</Button><Button type="button" variant="primary" disabled={foot.disabled || busy} onClick={foot.submit}>{foot.label}</Button></>}
        >
            <TaskFormBody {...rest} onSubmit={async (b) => { setBusy(true); try { await rest.onSubmit(b); } finally { setBusy(false); } }} footerRef={setFoot} />
        </Modal>
    );
};
