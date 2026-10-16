import { useEffect, useMemo, useRef, useState } from "react";
import { BranchPicker } from "./BranchPicker";
import { accountOrderOf, api, envRepos, poEnvIds, modelLabel, type Account, type Env, type MyTicket, type ProductOwner, type Readiness, type Settings } from "./api";
import { AgentInput } from "./AgentInput";
import { Button, Chip, Input, Select, Textarea } from "@vortex/ds";

// ClickUp and Linear both use 1 = urgent … 4 = low; 0/null = unset.
const PRIORITY_MARK: Record<number, string> = { 0: "·", 1: "🔴", 2: "🟠", 3: "🟡", 4: "🔵" };

// Splits pasted ticket ids/links (one per line, or separated by commas/spaces).
const splitTickets = (s: string): string[] => [...new Set(s.split(/[\n,;]+|\s+(?=[A-Za-z]|https?:)/).map((x) => x.trim()).filter(Boolean))];
const looksLikeTicket = (s: string): boolean => /app\.clickup\.com\/t\//.test(s) || /linear\.app\/.+\/issue\//.test(s) || /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s) || /^[a-z0-9]{6,12}$/i.test(s);

// The sprint's tickets in a dropdown (closed by default, so the form stays short): search box, checkboxes, picked ones as chips.
const TicketPicker = ({ groups, selected, onToggle }: { groups: Array<[string, MyTicket[]]>; selected: string[]; onToggle: (id: string) => void }) => {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey, true);
        return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
    }, [open]);
    const all = groups.flatMap(([, tl]) => tl);
    const picked = all.filter((t) => selected.includes(t.id));
    const needle = q.trim().toLowerCase();
    const match = (t: MyTicket) => !needle || t.id.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle);
    return (
        <div className="ticket-dropdown" ref={ref}>
            <Button type="button" className="ticket-dropdown-toggle" onClick={() => setOpen((v) => !v)}>
                {picked.length ? `${picked.length} picked` : "Pick from my tickets"} <span className="caret">{open ? "▴" : "▾"}</span>
            </Button>
            {picked.length > 0 && (
                <span className="ticket-chips">
                    {picked.map((t) => <Chip key={t.id} tone="accent" title={t.title}>{t.id} <Button variant="ghost" type="button" className="chip-x" onClick={() => onToggle(t.id)} aria-label={`remove ${t.id}`}>×</Button></Chip>)}
                </span>
            )}
            {open && (
                <div className="ticket-menu">
                    <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by id or title…" />
                    <div className="ticket-menu-list">
                        {groups.map(([g, tl]) => {
                            const shown = tl.filter(match);
                            if (shown.length === 0) return null;
                            return (
                                <div key={g}>
                                    <div className="group">{g}</div>
                                    {shown.map((t) => (
                                        <label key={t.id} className={`inline ticket-option ${selected.includes(t.id) ? "picked" : ""}`}>
                                            <Input type="checkbox" checked={selected.includes(t.id)} onChange={() => onToggle(t.id)} />
                                            <span>{PRIORITY_MARK[t.priority ?? 0] ?? "·"} <b>{t.id}</b> {t.title.length > 70 ? `${t.title.slice(0, 70)}…` : t.title} <Chip>{t.status}</Chip></span>
                                        </label>
                                    ))}
                                </div>
                            );
                        })}
                        {all.filter(match).length === 0 && <div className="quiet">nothing matches</div>}
                    </div>
                    <div className="actions" style={{ margin: "6px 0 0" }}><Button variant="primary" type="button" onClick={() => setOpen(false)}>Done{picked.length ? ` (${picked.length})` : ""}</Button></div>
                </div>
            )}
        </div>
    );
};

export const TaskForm = ({ accounts, env, settings, readiness, onSubmit }: {
    accounts: Account[]; env: Env; settings: Settings | null; readiness: Readiness | undefined;
    onSubmit: (body: { tickets: string[]; mode: "each" | "batch"; accountId?: string; model?: string; notes?: string; baseBranch?: string | Record<string, string>; productOwnerId?: string | null }) => Promise<void>;
}) => {
    const [ticket, setTicket] = useState("");
    // "" = automatic (the PO whose project the ticket belongs to), "none" = no PO, else a PO id.
    const [owner, setOwner] = useState("");
    const [owners, setOwners] = useState<ProductOwner[]>([]);
    useEffect(() => { void api.productOwners().then(setOwners).catch(() => setOwners([])); }, []);
    const [mode, setMode] = useState<"each" | "batch">("each");
    const [notes, setNotes] = useState("");
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
    const list = splitTickets(ticket);
    const bad = list.filter((t) => !looksLikeTicket(t));
    const toggle = (id: string) => setTicket(list.includes(id) ? list.filter((x) => x !== id).join("\n") : [...list, id].join("\n"));
    useEffect(() => {
        setMine(null);
        void api.myTickets(env.id).then(setMine).catch((e: Error) => setMine({ tickets: [], error: e.message }));
    }, [env.id]);
    const groups = useMemo(() => {
        const m = new Map<string, MyTicket[]>();
        for (const t of mine?.tickets ?? []) m.set(t.group, [...(m.get(t.group) ?? []), t]);
        return [...m.entries()];
    }, [mine]);
    return (
        <>
            {readiness && readiness.warnings.length > 0 && (
                <div className="blocked-box" style={{ marginBottom: 0 }}>
                    <b>Before you start:</b>
                    <ul className="plain">{readiness.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </div>
            )}
            {readiness && readiness.warnings.length === 0 && <span className="field-hint">Ready: agents run as {readiness.run.join(" → ")}; browser QA as {readiness.browser.join(" → ")}.</span>}
            <div className="ticket-field">
                <span className="ticket-field-label">My tickets{" "}
                    {mine === null ? <Chip>loading…</Chip> : mine.error ? <Chip tone="bad" title={mine.error}>unavailable</Chip> : <Chip>{mine.tickets.length}{env.ticket_source === "clickup" ? " in current sprint" : " assigned"}</Chip>}
                </span>
                {mine && mine.tickets.length > 0 && <TicketPicker groups={groups} selected={list} onToggle={toggle} />}
                {mine?.error && <span className="hint-line">{mine.error}</span>}
            </div>
            <label>Ticket ids or links (one per line for several) <Textarea autoFocus value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder={"PRODUCT-8704\nhttps://app.clickup.com/t/…\nhttps://linear.app/…/issue/…"} style={{ minHeight: 60 }} /></label>
            {list.length > 0 && <Chip className={`${bad.length ? "bad" : "accent"}`}>{bad.length ? `unrecognised: ${bad.join(", ")}` : `${list.length} ticket${list.length === 1 ? "" : "s"}`}</Chip>}
            {list.length > 1 && (
                <label>Dispatch
                    <Select value={mode} onChange={(e) => setMode(e.target.value as "each" | "batch")}>
                        <option value="each">One task per ticket — each gets its own branch and PR ({list.length} tasks)</option>
                        <option value="batch">One task for all — one branch, one PR per repository</option>
                    </Select>
                </label>
            )}
            {owners.length > 0 && (
                <label>Product owner
                    <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                        <option value="">automatic — the one whose project the ticket belongs to</option>
                        <option value="none">none</option>
                        {owners.filter((o) => poEnvIds(o).includes(env.id)).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                    </Select>
                </label>
            )}
            <label>Extra instructions for the agents (optional; every stage sees them) <AgentInput value={notes} onChange={setNotes} placeholder="Constraints, where the code lives, what to skip, how to test…" style={{ minHeight: 60 }} /></label>
            {repoKeys.map((repo) => (
                <label key={repo}>Base branch{repo ? ` · ${repo}` : ""}
                    <BranchPicker envId={env.id} repo={repo} value={bases[repo] ?? ""} onChange={(v) => setBases((b) => ({ ...b, [repo]: v }))} placeholder={env.base_branch} />
                </label>
            ))}
            <span className="field-hint">The branch the work starts from and the PR targets — default {env.base_branch}. For a stacked PR, another task's branch{repoKeys.length > 1 ? " (per repository: a parent that touched only one repo leaves the other on the default)" : ""}; when that branch's PR merges, the task is rebased onto the new base automatically.</span>
            <label>AI account
                <Select value={acc} onChange={(e) => setAcc(e.target.value)}>
                    {accounts.length === 0 && <option value="">— no account can run in this environment's config dir —</option>}
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.email ? ` · ${a.email}` : ""}</option>)}
                </Select>
            </label>
            <label>Claude model
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                    {(settings?.models ?? [{ value: "", label: "Account default" }]).map((m) => (
                        <option key={m.value} value={m.value}>
                            {m.value === "" ? `Account default${(() => { const d = modelLabel(accounts.find((a) => a.id === acc)?.default_model, settings?.models); return d ? ` · ${d}` : " · not resolved yet (refresh the account)"; })()}` : m.label}
                        </option>
                    ))}
                </Select>
                <span className="field-hint">Applies to Design, Implementation and PR fixes; Research, QA and the PR draft run on Sonnet.</span>
            </label>
            <Button variant="primary" disabled={list.length === 0 || bad.length> 0 || accounts.length === 0} onClick={() => onSubmit({ tickets: list, mode, ...(acc ? { accountId: acc } : {}), ...(model ? { model } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}), ...(baseBranch ? { baseBranch } : {}), ...(owner ? { productOwnerId: owner === "none" ? null : owner } : {}) })}>
                {list.length > 1 ? (mode === "each" ? `Start ${list.length} tasks` : `Start 1 task for ${list.length} tickets`) : "Start task"}
            </Button>
        </>
    );
};
