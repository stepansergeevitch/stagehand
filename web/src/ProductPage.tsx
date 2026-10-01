import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Env, type PalaceHit, type PoArtifact, type PoDetail, type PoIssue, type PoPhase, type PoTicket, type ProductOwner } from "./api";
import { Markdown } from "./Markdown";
import { poBus } from "./poBus";
import type { PoTab } from "./routes";

// The Product section: the global product context, the Product Owners (one per project of the product), and the
// palace search. A PO page shows its three documents as pages — context, design, tickets — beside the chat that
// changes them.

const PHASES: PoPhase[] = ["context", "design", "tickets", "approved", "live"];
const PHASE_LABEL: Record<PoPhase, string> = { context: "Context", design: "Design", tickets: "Tickets", approved: "Approved", live: "Live" };

const EditableMarkdown = ({ text, empty, onSave }: { text: string; empty: string; onSave: (t: string) => Promise<void> }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(text);
    useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
    return editing ? (
        <>
            <textarea className="md-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(30, Math.max(8, draft.split("\n").length + 2))} />
            <div className="actions">
                <button className="primary" onClick={async () => { await onSave(draft); setEditing(false); }}>Save</button>
                <button onClick={() => setEditing(false)}>Cancel</button>
            </div>
        </>
    ) : (
        <>
            {text.trim() ? <Markdown source={text} /> : <div className="empty">{empty}</div>}
            <div className="actions"><button onClick={() => setEditing(true)}>Edit</button></div>
        </>
    );
};

const PalaceSearch = ({ wing, onError }: { wing?: string; onError: (m: string) => void }) => {
    const [q, setQ] = useState("");
    const [hits, setHits] = useState<PalaceHit[] | null>(null);
    const run = async () => {
        if (!q.trim()) return;
        try { setHits((await api.palaceSearch(q.trim(), wing)).results); } catch (e) { onError(String((e as Error).message ?? e)); }
    };
    return (
        <>
            <div className="po-row">
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} placeholder={wing ? `Search this PO's memory (${wing})` : "Search the whole palace"} />
                <button onClick={() => void run()}>Search</button>
            </div>
            {hits && (hits.length === 0 ? <div className="quiet">No drawers match.</div> : (
                <div className="palace-hits">
                    {hits.map((h, i) => (
                        <details key={i} className="palace-hit">
                            <summary><span className="chip">{h.wing}</span><span className="chip">{h.room}</span>{h.similarity != null && <span className="field-hint"> {Math.round(h.similarity * 100)} %</span>} {h.text.split("\n")[0]?.slice(0, 120)}</summary>
                            <Markdown source={h.text} />
                        </details>
                    ))}
                </div>
            ))}
        </>
    );
};

// ---------- the list ----------

const ProductHome = ({ onOpen, onError }: { onOpen: (id: string) => void; onError: (m: string) => void }) => {
    const [ctx, setCtx] = useState<string | null>(null);
    const [pos, setPos] = useState<ProductOwner[] | null>(null);
    const [url, setUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState<"owners" | "context" | "memory">("owners");
    const load = useCallback(() => {
        void api.productContext().then((r) => setCtx(r.text)).catch((e: Error) => onError(e.message));
        void api.productOwners().then(setPos).catch((e: Error) => onError(e.message));
    }, [onError]);
    useEffect(load, [load]);
    useEffect(() => poBus.subscribe((ev) => ev.kind === "updated" && load()), [load]);
    return (
        <div className="product">
            <div className="subtabs">
                <button className={tab === "owners" ? "active" : ""} onClick={() => setTab("owners")}>Product owners {pos ? <span className="chip">{pos.length}</span> : null}</button>
                <button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}>Product context</button>
                <button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>Memory</button>
            </div>
            {tab === "owners" && <section className="card">
                <h2>Product owners <span className="field-hint">— one per project of the product: a Linear project or a ClickUp epic</span></h2>
                <div className="po-row">
                    <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Linear project URL (linear.app/…/project/…) or ClickUp epic URL (app.clickup.com/t/…)" />
                    <button className="primary" disabled={busy || url.trim().length < 8} onClick={async () => { setBusy(true); try { const po = await api.createProductOwner(url.trim()); setUrl(""); onOpen(po.id); } catch (e) { onError(String((e as Error).message ?? e)); } finally { setBusy(false); } }}>{busy ? "Reading the project…" : "New product owner"}</button>
                </div>
                {pos === null ? <div className="empty">loading…</div> : pos.length === 0 ? <div className="empty">No Product Owner yet. Paste a project URL above to start one.</div> : (
                    <div className="po-list">
                        {pos.map((po) => (
                            <div key={po.id} className="po-item" onClick={() => onOpen(po.id)}>
                                <b>{po.title}</b>
                                <span className="chip">{po.source === "linear" ? "Linear project" : "ClickUp epic"}</span>
                                <span className={`chip ${po.phase === "live" ? "ok" : "accent"}`}>{PHASE_LABEL[po.phase]}</span>
                                {po.status === "running" && <span className="chip wait">answering…</span>}
                                {po.status === "failed" && <span className="chip bad" title={po.status_line ?? ""}>failed</span>}
                                <span className="field-hint">{po.created ? `${po.created} ticket(s) created · ` : ""}{po.tasks ? `${po.tasks} task(s) · ` : ""}updated {new Date(po.updated_at).toLocaleString()}</span>
                            </div>
                        ))}
                    </div>
                )}
            </section>}
            {tab === "context" && <section className="card">
                <h2>Product context <span className="field-hint">— the whole product; every Product Owner reads it</span></h2>
                {ctx === null ? <div className="empty">loading…</div> : <EditableMarkdown text={ctx} empty="Empty. Describe the product: what it is, who uses it, its main areas, its rules." onSave={async (t) => { await api.setProductContext(t); setCtx(t); }} />}
            </section>}
            {tab === "memory" && <section className="card">
                <h2>Memory</h2>
                <PalaceSearch onError={onError} />
            </section>}
        </div>
    );
};

// ---------- one PO ----------

const ArtifactRow = ({ poId, a, onRemove }: { poId: string; a: PoArtifact; onRemove: () => void }) => {
    const [text, setText] = useState<string | null>(null);
    const textual = a.mime?.startsWith("text/") || /\.(md|txt|csv|json)$/i.test(a.file);
    return (
        <details className="po-artifact" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && text === null && textual) void api.poFileText(poId, a.file).then(setText).catch(() => setText("(could not read)")); }}>
            <summary>
                <span className="chip">{a.kind}</span> <b>{a.title}</b>
                {a.source_url && <> <a href={a.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>source ↗</a></>}
                {!textual && <> <a href={api.poFileUrl(poId, a.file)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>open ↗</a></>}
                <button className="tiny danger" onClick={(e) => { e.preventDefault(); if (confirm(`Remove ${a.title}?`)) onRemove(); }}>Remove</button>
            </summary>
            {textual && (text === null ? <div className="quiet">loading…</div> : <Markdown source={text} />)}
        </details>
    );
};

const ContextTab = ({ d, onError, reload }: { d: PoDetail; onError: (m: string) => void; reload: () => void }) => {
    const [url, setUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [paste, setPaste] = useState<{ title: string; text: string; tell: boolean } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } finally { setBusy(false); } };
    return (
        <>
            {d.proposal && (
                <div className="review-box">
                    <b>The Product Owner proposes a new product context.</b> It replaces the product context of every Product Owner.
                    <details><summary>Read the proposal</summary><Markdown source={d.proposal} /></details>
                    <div className="actions">
                        <button className="primary" onClick={() => void act(() => api.poAcceptProposal(d.po.id))}>Accept</button>
                        <button onClick={() => void act(() => api.poRejectProposal(d.po.id))}>Reject</button>
                    </div>
                </div>
            )}
            <section className="card">
                <h2>Project context <span className="field-hint">— the PO keeps it current; filed in its palace wing after every turn</span></h2>
                <EditableMarkdown text={d.context} empty="Empty — the Product Owner writes it in the first turn." onSave={(t) => api.poSetContext(d.po.id, t).then(reload)} />
            </section>
            <section className="card">
                <h2>Sources <span className="chip">{d.artifacts.length}</span></h2>
                <div className="po-row">
                    <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Linear project or issue, ClickUp task, Notion page, or any web page URL" />
                    <button disabled={busy || url.trim().length < 8} onClick={() => void act(async () => { await api.poFetch(d.po.id, url.trim()); setUrl(""); })}>{busy ? "Fetching…" : "Fetch"}</button>
                    <button disabled={busy} onClick={() => fileRef.current?.click()}>Upload</button>
                    <button disabled={busy} onClick={() => setPaste((p) => (p ? null : { title: "", text: "", tell: true }))}>Paste text</button>
                    <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; void act(async () => { for (const f of files) await api.poUpload(d.po.id, f); }); }} />
                </div>
                {paste && (
                    <div className="po-paste">
                        <input value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder="Title (optional) — e.g. Call with Austin about density" />
                        <textarea rows={10} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste a conversation, notes or any text with context for this project" autoFocus />
                        <div className="actions">
                            <label className="inline" title={d.running ? "The Product Owner is answering; it reads the source in a later turn" : undefined}><input type="checkbox" checked={paste.tell} onChange={(e) => setPaste({ ...paste, tell: e.target.checked })} /> Product Owner reads it now and updates the context</label>
                            <button className="primary" disabled={busy || !paste.text.trim()} onClick={() => void act(async () => { await api.poPaste(d.po.id, paste.title, paste.text, paste.tell); setPaste(null); })}>Add source</button>
                            <button onClick={() => setPaste(null)}>Cancel</button>
                        </div>
                    </div>
                )}
                {d.artifacts.map((a) => <ArtifactRow key={a.id} poId={d.po.id} a={a} onRemove={() => void act(() => api.poRemoveArtifact(d.po.id, a.id))} />)}
            </section>
            <section className="card">
                <h2>Memory</h2>
                <PalaceSearch wing={d.po.slug} onError={onError} />
            </section>
        </>
    );
};

// design.md split on its `## ` headings: a table of contents on the side, each section addressable.
const sectionsOf = (md: string): Array<{ title: string; body: string }> => {
    const out: Array<{ title: string; body: string }> = [];
    let cur: { title: string; body: string } | null = null;
    let fence = false;
    for (const line of md.split("\n")) {
        if (/^```/.test(line)) fence = !fence;
        const h = !fence ? /^##\s+(.+?)\s*$/.exec(line) : null;
        if (h) {
            if (cur) out.push(cur);
            cur = { title: h[1]!, body: "" };
        } else if (cur) cur.body += `${line}\n`;
    }
    if (cur) out.push(cur);
    return out;
};

const DesignTab = ({ d, onError, reload, send }: { d: PoDetail; onError: (m: string) => void; reload: () => void; send: (t: string) => void }) => {
    const [rev, setRev] = useState<{ name: string; text: string } | null>(null);
    const revs = d.revisions.filter((r) => r.file === "design.md");
    const text = rev?.text ?? d.design ?? "";
    const sections = useMemo(() => sectionsOf(text), [text]);
    if (!d.design) {
        return (
            <div className="empty">
                No design yet. The Product Owner writes <code>design.md</code> once the context is complete.
                <div className="actions"><button className="primary" disabled={d.running} onClick={() => send("Write design.md now, from what we know. Mark what is still open in Open questions.")}>Ask for the design</button></div>
            </div>
        );
    }
    const canApprove = d.po.phase === "context" || d.po.phase === "design";
    return (
        <div className="po-doc">
            <nav className="po-toc">
                {sections.map((s, i) => <a key={i} href={`#`} onClick={(e) => { e.preventDefault(); document.getElementById(`po-sec-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{s.title}</a>)}
                {revs.length > 1 && (
                    <label className="field-hint">Version
                        <select value={rev?.name ?? ""} onChange={async (e) => { const n = e.target.value; if (!n) return setRev(null); try { setRev({ name: n, text: (await api.poRevision(d.po.id, n)).text }); } catch (err) { onError(String((err as Error).message ?? err)); } }}>
                            <option value="">current</option>
                            {revs.slice(0, -1).reverse().map((r) => <option key={r.name} value={r.name}>{new Date(r.at).toLocaleString()}</option>)}
                        </select>
                    </label>
                )}
            </nav>
            <div className="po-doc-body">
                {rev && <div className="review-box">You are reading an earlier version. <button onClick={() => setRev(null)}>Back to current</button></div>}
                {canApprove && !rev && (
                    <div className="review-box">
                        <b>Design — your call.</b> Refine it in the chat, or approve it: the Product Owner then splits it into tickets.
                        <div className="actions"><button className="primary" disabled={d.running} onClick={async () => { try { await api.poApproveDesign(d.po.id); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Approve design</button></div>
                    </div>
                )}
                {sections.map((s, i) => (
                    <section key={i} id={`po-sec-${i}`} className="po-section">
                        <h2>{s.title}</h2>
                        <Markdown source={s.body} />
                    </section>
                ))}
            </div>
        </div>
    );
};

const TicketEditor = ({ t, onSave, onCancel }: { t: PoTicket; onSave: (t: PoTicket) => void; onCancel: () => void }) => {
    const [x, setX] = useState(t);
    return (
        <div className="po-ticket-edit">
            <label>Title<input value={x.title} onChange={(e) => setX({ ...x, title: e.target.value })} /></label>
            <label>Type<select value={x.type} onChange={(e) => setX({ ...x, type: e.target.value as PoTicket["type"] })}>{["epic", "story", "task", "bug"].map((k) => <option key={k}>{k}</option>)}</select></label>
            <label>Estimate<input value={x.estimate ?? ""} onChange={(e) => setX({ ...x, estimate: e.target.value.trim() === "" ? null : Number(e.target.value) })} /></label>
            <label>Summary<input value={x.summary} onChange={(e) => setX({ ...x, summary: e.target.value })} /></label>
            <label>Description<textarea rows={8} value={x.description} onChange={(e) => setX({ ...x, description: e.target.value })} /></label>
            <label>Acceptance criteria (one per line)<textarea rows={5} value={x.acceptanceCriteria.join("\n")} onChange={(e) => setX({ ...x, acceptanceCriteria: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })} /></label>
            <div className="actions"><button className="primary" onClick={() => onSave(x)}>Save</button><button onClick={onCancel}>Cancel</button></div>
        </div>
    );
};

const since = (iso: string): string => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

// When the issues were last read from the task manager, and a button to read them now.
const IssuesRefresh = ({ d, onError, reload }: { d: PoDetail; onError: (m: string) => void; reload: () => void }) => {
    const [busy, setBusy] = useState(false);
    const refresh = async () => {
        setBusy(true);
        try { await api.poRefreshIssues(d.po.id); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } finally { setBusy(false); }
    };
    return (
        <div className="po-issues-bar">
            <span className="field-hint">
                {d.issues.length} issue(s) tracked · {d.po.issues_refreshed_at ? `read ${since(d.po.issues_refreshed_at)}` : "never read"} · every hour, and the Product Owner gets what changed
                {d.po.issues_error && <span className="chip bad" title={d.po.issues_error}> last refresh failed</span>}
            </span>
            <button className="tiny" disabled={busy || d.refreshingIssues || d.running} title={d.running ? "Wait for the Product Owner's turn" : undefined} onClick={() => void refresh()}>{busy || d.refreshingIssues ? "Refreshing…" : "Refresh issues"}</button>
        </div>
    );
};

// The issue behind a ticket as the task manager has it now: status, labels, assignee and its comments.
const LiveIssue = ({ issue }: { issue: PoIssue }) => (
    <>
        <h3>In {issue.url.includes("clickup") ? "ClickUp" : "Linear"} now</h3>
        <div className="po-ticket-meta">
            <span className="chip accent">{issue.status ?? "?"}</span>
            {issue.assignee && <span className="chip">{issue.assignee}</span>}
            {issue.priority && <span className="chip">priority {issue.priority}</span>}
            {issue.labels.map((l) => <span key={l} className="chip">{l}</span>)}
        </div>
        <h3>Comments ({issue.comments.length})</h3>
        {issue.comments.length === 0 ? <p className="quiet">No comments.</p> : (
            <div className="po-comments">
                {issue.comments.map((c) => (
                    <div key={c.id} className="po-comment">
                        <div className="po-comment-head"><b>{c.author}</b> <span className="quiet">{new Date(c.at).toLocaleString()}</span></div>
                        <Markdown source={c.body} />
                    </div>
                ))}
            </div>
        )}
    </>
);

// The Stagehand task of a ticket's issue, or a way to start one in an environment of the same task manager.
const TicketTask = ({ d, identifier, reload, onError }: { d: PoDetail; identifier: string; reload: () => void; onError: (m: string) => void }) => {
    const task = d.tasks.find((t) => t.ticket_id.toUpperCase() === identifier.toUpperCase());
    const [envs, setEnvs] = useState<Env[]>([]);
    const [env, setEnv] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (task) return;
        void api.envs().then((all) => {
            const mine = all.filter((e) => e.ticket_source === d.po.source);
            setEnvs(mine);
            setEnv((cur) => cur || mine[0]?.id || "");
        }).catch(() => undefined);
    }, [task, d.po.source]);
    if (task) {
        return (
            <div className="po-ticket-task">
                <b>Task:</b> <a href={`#/tasks/${encodeURIComponent(task.id)}`}>{task.ticket_id}{task.title ? ` — ${task.title}` : ""}</a>
                <span className="chip">{task.stage.replace(/_/g, " ")}</span> <span className="chip">{task.status.replace(/_/g, " ")}</span>
            </div>
        );
    }
    const create = async () => {
        setBusy(true);
        try { await api.createTasks({ envId: env, tickets: [identifier], mode: "each", productOwnerId: d.po.id }); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } finally { setBusy(false); }
    };
    return (
        <div className="po-ticket-task">
            <b>No task yet.</b>
            {envs.length === 0 ? <span className="quiet"> No environment uses {d.po.source === "linear" ? "Linear" : "ClickUp"}.</span> : (
                <>
                    {envs.length > 1 && <select value={env} onChange={(e) => setEnv(e.target.value)}>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}
                    <button className="tiny primary" disabled={busy || !env} onClick={() => void create()}>{busy ? "Creating…" : `Create task${envs.length === 1 ? ` in ${envs[0]!.name}` : ""}`}</button>
                </>
            )}
        </div>
    );
};

const TicketsTab = ({ d, onError, reload, send }: { d: PoDetail; onError: (m: string) => void; reload: () => void; send: (t: string) => void }) => {
    const tickets = d.tickets?.tickets ?? [];
    const [sel, setSel] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const byKey = useMemo(() => new Map(tickets.map((t) => [t.key, t])), [tickets]);
    const link = (k: string) => d.links.find((l) => l.key === k);
    const current = (sel && byKey.get(sel)) || tickets[0];
    const identOf = (t: PoTicket): string | null => link(t.key)?.identifier ?? t.existing ?? null;
    const issueOf = (t: PoTicket): PoIssue | undefined => { const id = identOf(t)?.toUpperCase(); return id ? d.issues.find((i) => i.identifier.toUpperCase() === id) : undefined; };
    const taskOf = (t: PoTicket) => { const id = identOf(t)?.toUpperCase(); return id ? d.tasks.find((x) => x.ticket_id.toUpperCase() === id) : undefined; };
    if (!d.tickets) {
        return (
            <div className="empty">
                {d.ticketsError ? <div className="blocked-box">tickets.json: {d.ticketsError}</div> : null}
                No ticket proposal yet. {d.po.phase === "tickets" ? "The Product Owner is writing it." : "It comes after you approve the design."}
                {d.po.phase === "tickets" && <div className="actions"><button disabled={d.running} onClick={() => send("Write tickets.json now from the approved design.")}>Ask for the tickets</button></div>}
            </div>
        );
    }
    const roots = tickets.filter((t) => !t.parent || !byKey.has(t.parent));
    const children = (k: string) => tickets.filter((t) => t.parent === k);
    const save = async (next: PoTicket) => {
        try { await api.poSetTickets(d.po.id, tickets.map((t) => (t.key === next.key ? next : t))); setEditing(false); reload(); } catch (e) { onError(String((e as Error).message ?? e)); }
    };
    const points = tickets.reduce((n, t) => n + (t.estimate ?? 0), 0);
    const pending = tickets.filter((t) => !link(t.key)).length;
    const row = (t: PoTicket, depth: number) => (
        <div key={t.key}>
            <button className={`po-ticket-row ${current?.key === t.key ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => { setSel(t.key); setEditing(false); }}>
                <span className={`chip ${t.type === "epic" ? "accent" : t.type === "bug" ? "bad" : ""}`}>{t.type}</span> <b>{t.title}</b>
                {t.estimate != null && <span className="chip">{t.estimate}</span>}
                {link(t.key) && <span className="chip ok">{link(t.key)!.identifier}</span>}
                {issueOf(t)?.status && <span className="chip">{issueOf(t)!.status}</span>}
                {taskOf(t) && <span className="chip accent" title="Stagehand task">task · {taskOf(t)!.stage.replace(/_/g, " ")}</span>}
                {(issueOf(t)?.comments.length ?? 0) > 0 && <span className="chip" title="comments">💬 {issueOf(t)!.comments.length}</span>}
            </button>
            {children(t.key).map((c) => row(c, depth + 1))}
        </div>
    );
    return (
        <>
            {d.ticketsError && <div className="blocked-box">tickets.json: {d.ticketsError}</div>}
            <IssuesRefresh d={d} onError={onError} reload={reload} />
            {(d.po.phase === "tickets" || (d.po.phase === "approved" && pending > 0)) && (
                <div className="review-box">
                    <b>{tickets.length} ticket(s), {points} point(s).</b> Refine them in the chat or edit one here. Approve to create {pending === tickets.length ? "them" : `the ${pending} not created yet`} in {d.po.source === "linear" ? "the Linear project" : "the ClickUp epic"}.
                    <div className="actions"><button className="primary" disabled={busy || d.running} onClick={async () => { setBusy(true); try { await api.poApproveTickets(d.po.id); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } finally { setBusy(false); } }}>{busy ? "Creating…" : "Approve and create"}</button></div>
                </div>
            )}
            <div className="po-tickets">
                <div className="po-ticket-tree">{roots.map((t) => row(t, 0))}</div>
                <div className="po-ticket-detail">
                    {current && (editing ? <TicketEditor t={current} onSave={(t) => void save(t)} onCancel={() => setEditing(false)} /> : (
                        <>
                            <h2><span className="chip">{current.key}</span> {current.title}</h2>
                            <div className="po-ticket-meta">
                                <span className="chip">{current.type}</span>
                                {current.estimate != null && <span className="chip"><b>{current.estimate}</b> pt</span>}
                                {current.labels.map((l) => <span key={l} className="chip">{l}</span>)}
                                {current.parent && byKey.get(current.parent) && <button className="tiny" onClick={() => setSel(current.parent)}>parent: {byKey.get(current.parent)!.title}</button>}
                                {link(current.key)?.url && <a href={link(current.key)!.url!} target="_blank" rel="noreferrer">{link(current.key)!.identifier} ↗</a>}
                            </div>
                            {current.summary && <p><b>{current.summary}</b></p>}
                            <Markdown source={current.description} />
                            {current.acceptanceCriteria.length > 0 && (<><h3>Acceptance criteria</h3><ul className="po-ac">{current.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul></>)}
                            {current.dependsOn.length > 0 && (<><h3>Depends on</h3><div className="po-ticket-meta">{current.dependsOn.map((k) => <button key={k} className="tiny" onClick={() => setSel(k)}>{k} {byKey.get(k)?.title ?? ""}</button>)}</div></>)}
                            {identOf(current) && <TicketTask d={d} identifier={identOf(current)!} reload={reload} onError={onError} />}
                            {issueOf(current) && <LiveIssue issue={issueOf(current)!} />}
                            {!link(current.key) && <div className="actions"><button onClick={() => setEditing(true)}>Edit</button></div>}
                        </>
                    ))}
                </div>
            </div>
        </>
    );
};

const PoChat = ({ d, onError, reload }: { d: PoDetail; onError: (m: string) => void; reload: () => void }) => {
    const [text, setText] = useState("");
    const [live, setLive] = useState<string>("");
    const [activity, setActivity] = useState<string>("");
    const end = useRef<HTMLDivElement>(null);
    useEffect(() => poBus.subscribe((ev) => {
        if (ev.poId !== d.po.id) return;
        if (ev.kind === "text") setLive(ev.text);
        if (ev.kind === "activity") setActivity(ev.text);
        if (ev.kind === "message" || ev.kind === "updated") { if (ev.kind === "message" && ev.message.role === "agent") { setLive(""); setActivity(""); } reload(); }
    }), [d.po.id, reload]);
    useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [d.messages.length, live]);
    const send = async () => {
        const t = text.trim();
        if (!t) return;
        try { await api.poSend(d.po.id, t); setText(""); reload(); } catch (e) { onError(String((e as Error).message ?? e)); }
    };
    return (
        <div className="po-chat">
            <div className="po-messages">
                {d.messages.map((m) => (
                    <div key={m.id} className={`po-msg ${m.role}`}>
                        <span className="po-msg-who">{m.role === "agent" ? "Product Owner" : m.role === "user" ? "You" : "Stagehand"}</span>
                        <Markdown source={m.text} />
                    </div>
                ))}
                {d.running && (
                    <div className="po-msg agent live">
                        <span className="po-msg-who">Product Owner {activity && <span className="field-hint">· {activity}</span>}</span>
                        {live ? <Markdown source={live} /> : <div className="quiet">thinking…</div>}
                    </div>
                )}
                <div ref={end} />
            </div>
            <div className="po-input">
                <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={d.running ? "The Product Owner is answering…" : "Message the Product Owner (⌘/Ctrl+Enter sends)"} rows={3} disabled={d.running} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} />
                <div className="actions">
                    {d.running ? <button className="danger" onClick={() => void api.poStop(d.po.id).then(reload)}>Stop</button> : <button className="primary" disabled={!text.trim()} onClick={() => void send()}>Send</button>}
                </div>
            </div>
        </div>
    );
};

const PoPage = ({ id, tab, onTab, onBack, onError }: { id: string; tab: PoTab; onTab: (t: PoTab) => void; onBack: () => void; onError: (m: string) => void }) => {
    const [d, setD] = useState<PoDetail | null>(null);
    const reload = useCallback(() => void api.productOwner(id).then(setD).catch((e: Error) => onError(e.message)), [id, onError]);
    useEffect(reload, [reload]);
    const send = (t: string) => void api.poSend(id, t).then(reload).catch((e: Error) => onError(e.message));
    if (!d) return <div className="empty">loading…</div>;
    const idx = PHASES.indexOf(d.po.phase);
    return (
        <div className="po-page">
            <div className="po-head">
                <button onClick={onBack}>← Product</button>
                <h1>{d.po.title}</h1>
                {d.po.scope_url && <a href={d.po.scope_url} target="_blank" rel="noreferrer">{d.po.source === "linear" ? "Linear project" : "ClickUp epic"} ↗</a>}
                <span className="po-phases">{PHASES.map((p, i) => <span key={p} className={`chip ${i < idx ? "ok" : i === idx ? "accent" : ""}`}>{PHASE_LABEL[p]}</span>)}</span>
                {d.po.status_line && <span className={`field-hint ${d.po.status === "failed" ? "bad" : ""}`}>{d.po.status_line}</span>}
                <span className="spacer" />
                {d.tasks.length > 0 && <span className="field-hint">{d.tasks.length} task(s) assigned</span>}
                <button className="danger" onClick={async () => { if (!confirm(`Delete the Product Owner "${d.po.title}"? Its chat, sources and proposals go; its palace wing and the created tickets stay.`)) return; await api.deleteProductOwner(id); onBack(); }}>Delete</button>
            </div>
            <div className="po-layout">
                <div className="po-main">
                    <div className="subtabs">
                        {(["context", "design", "tickets"] as const).map((t) => (
                            <button key={t} className={tab === t ? "active" : ""} onClick={() => onTab(t)}>
                                {t === "context" ? `Context · ${d.artifacts.length} source(s)` : t === "design" ? "Design" : `Tickets${d.tickets ? ` · ${d.tickets.tickets.length}` : ""}`}
                                {t === "context" && d.proposal && <span className="chip warn">proposal</span>}
                            </button>
                        ))}
                    </div>
                    {tab === "context" && <ContextTab d={d} onError={onError} reload={reload} />}
                    {tab === "design" && <DesignTab d={d} onError={onError} reload={reload} send={send} />}
                    {tab === "tickets" && <TicketsTab d={d} onError={onError} reload={reload} send={send} />}
                </div>
                <PoChat d={d} onError={onError} reload={reload} />
            </div>
        </div>
    );
};

export const ProductPage = ({ po, tab, onNavigate, onError }: { po?: string; tab?: PoTab; onNavigate: (po?: string, tab?: PoTab) => void; onError: (m: string) => void }) =>
    po ? <PoPage key={po} id={po} tab={tab ?? "context"} onTab={(t) => onNavigate(po, t)} onBack={() => onNavigate()} onError={onError} /> : <ProductHome onOpen={(id) => onNavigate(id)} onError={onError} />;
