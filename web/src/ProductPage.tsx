import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Env, type PalaceHit, type PoArtifact, type PoDetail, type PoIssue, type PoPhase, type PoTicket, type ProductOwner } from "./api";
import { Markdown } from "./Markdown";
import { Modal } from "./Modal";
import { DataTable, type DataColumn } from "./components/DataTable";
import { EntityForm, EntityView, Field, ReadField, useDraft, useSaver } from "./components/EntityView";
import { poBus } from "./poBus";
import type { PoTab } from "./routes";
import { CorrectionsTab, EventsTab, QuestionsTab } from "./PoJournal";

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

const PalaceSearch = ({ wing, env, envLabel, onError }: { wing?: string; env?: string; envLabel?: string; onError: (m: string) => void }) => {
    const [q, setQ] = useState("");
    const [hits, setHits] = useState<PalaceHit[] | null>(null);
    const run = async () => {
        if (!q.trim()) return;
        try { setHits((await api.palaceSearch(q.trim(), wing ? { wing } : { env: env ?? "" })).results); } catch (e) { onError(String((e as Error).message ?? e)); }
    };
    return (
        <>
            <div className="po-row">
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} placeholder={wing ? `Search this PO's memory (${wing})` : `Search the memory of ${envLabel ?? "this environment"}`} />
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

type PendingSource = { kind: "url"; url: string } | { kind: "text"; title: string; text: string } | { kind: "file"; file: File };
const LINEAR_PROJECT = /^https?:\/\/linear\.app\/[^/]+\/project\//;
const CLICKUP_TASK = /^https?:\/\/app\.clickup\.com\/t\//;

// A new PO: its environment (which fixes the task manager), the project of that task manager, and the sources it
// starts from. The PO is created without its first turn, gets the sources, then starts — so it reads them all.
const NewPoDialog = ({ envs, onClose, onCreated, onError }: { envs: Env[]; onClose: () => void; onCreated: (id: string) => void; onError: (m: string) => void }) => {
    const [envId, setEnvId] = useState(envs[0]?.id ?? "");
    const env = envs.find((e) => e.id === envId);
    const manager = env?.ticket_source === "clickup" ? "ClickUp" : "Linear";
    const [url, setUrl] = useState("");
    // "env" = the environment's own PO: no project; it reviews the env's tasks that have no project PO.
    const [kind, setKind] = useState<"project" | "env">("project");
    const [sources, setSources] = useState<PendingSource[]>([]);
    const [srcUrl, setSrcUrl] = useState("");
    const [paste, setPaste] = useState<{ title: string; text: string } | null>(null);
    const [progress, setProgress] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const urlOk = env?.ticket_source === "clickup" ? CLICKUP_TASK.test(url.trim()) : LINEAR_PROJECT.test(url.trim());
    const create = async () => {
        if (!env) return;
        setProgress(kind === "env" ? "Creating…" : "Reading the project…");
        let po: ProductOwner;
        try {
            po = kind === "env" ? await api.createEnvProductOwner(env.id) : await api.createProductOwner(url.trim(), env.id, false);
        } catch (e) {
            setProgress(null);
            onError(String((e as Error).message ?? e));
            return;
        }
        const failed: string[] = [];
        for (const [i, s] of sources.entries()) {
            setProgress(`Adding sources ${i + 1} / ${sources.length}…`);
            try {
                if (s.kind === "url") await api.poFetch(po.id, s.url);
                else if (s.kind === "text") await api.poPaste(po.id, s.title, s.text, false);
                else await api.poUpload(po.id, s.file);
            } catch (e) {
                failed.push(`${s.kind === "url" ? s.url : s.kind === "text" ? s.title || "pasted text" : s.file.name}: ${String((e as Error).message ?? e)}`);
            }
        }
        await api.startProductOwner(po.id).catch(() => undefined);
        if (failed.length) onError(`Some sources were not added — add them on the Context tab:\n${failed.join("\n")}`);
        onCreated(po.id);
    };
    const label = (s: PendingSource) => (s.kind === "url" ? s.url : s.kind === "text" ? `${s.title || "Pasted text"} (${s.text.length} characters)` : `${s.file.name} (${Math.round(s.file.size / 1024)} KB)`);
    return (
        <Modal title="New product owner" onClose={() => !progress && onClose()} wide>
            <label>Environment
                <select value={envId} onChange={(e) => { setEnvId(e.target.value); setUrl(""); }}>
                    {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
            </label>
            <div className="po-kind">
                <label className="inline"><input type="radio" checked={kind === "project"} onChange={() => setKind("project")} /> <b>Project</b> — one {manager === "Linear" ? "Linear project" : "ClickUp epic"}: plans it, designs it, splits it into tickets</label>
                <label className="inline"><input type="radio" checked={kind === "env"} onChange={() => setKind("env")} /> <b>Whole environment</b> — no project: briefs and reviews every task of the environment that has no project PO, from the product context and the environment's memory</label>
            </div>
            {kind === "project" && (
                <>
                    <div className="field-hint">Task manager: <b>{manager}</b> — the Product Owner reads its project and creates tickets only there. Only this environment's tasks get it.</div>
                    <label>{manager === "Linear" ? "Linear project" : "ClickUp epic"}
                        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={manager === "Linear" ? "https://linear.app/<workspace>/project/…" : "https://app.clickup.com/t/…"} />
                    </label>
                    {url.trim() && !urlOk && <div className="field-hint bad">This is not a {manager === "Linear" ? "Linear project URL" : "ClickUp task URL"}.</div>}
                </>
            )}
            <h3>Sources <span className="field-hint">— optional; the Product Owner reads them in its first turn</span></h3>
            {sources.length > 0 && (
                <ul className="po-pending">
                    {sources.map((s, i) => (
                        <li key={i}><span className="chip">{s.kind}</span> {label(s)} <button className="tiny" onClick={() => setSources((x) => x.filter((_, j) => j !== i))}>Remove</button></li>
                    ))}
                </ul>
            )}
            <div className="po-row">
                <input value={srcUrl} onChange={(e) => setSrcUrl(e.target.value)} placeholder="Linear issue, ClickUp task, Notion page or any web page URL" />
                <button disabled={!/^https?:\/\//.test(srcUrl.trim())} onClick={() => { setSources((x) => [...x, { kind: "url", url: srcUrl.trim() }]); setSrcUrl(""); }}>Add URL</button>
                <button onClick={() => setPaste((p) => (p ? null : { title: "", text: "" }))}>Paste text</button>
                <button onClick={() => fileRef.current?.click()}>Upload files</button>
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; setSources((x) => [...x, ...files.map((file) => ({ kind: "file" as const, file }))]); }} />
            </div>
            {paste && (
                <div className="po-paste">
                    <input value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder="Title (optional)" />
                    <textarea rows={8} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste a conversation, notes or any text with context for this project" autoFocus />
                    <div className="actions"><button disabled={!paste.text.trim()} onClick={() => { setSources((x) => [...x, { kind: "text", title: paste.title.trim(), text: paste.text }]); setPaste(null); }}>Add text</button></div>
                </div>
            )}
            <div className="actions">
                <button className="primary" disabled={!env || (kind === "project" && !urlOk) || !!progress} onClick={() => void create()}>{progress ?? "Create"}</button>
                <button disabled={!!progress} onClick={onClose}>Cancel</button>
            </div>
        </Modal>
    );
};

// The environment the Product context and Memory tabs show; remembered per browser.
const useProductEnv = (envs: Env[]): [string, (id: string) => void] => {
    const [env, setEnv] = useState<string>(() => {
        try { return localStorage.getItem("stagehand.product.env") ?? ""; } catch { return ""; }
    });
    const valid = envs.some((e) => e.id === env) ? env : envs[0]?.id ?? "";
    const set = (id: string): void => {
        setEnv(id);
        try { localStorage.setItem("stagehand.product.env", id); } catch { /* not remembered */ }
    };
    return [valid, set];
};

const EnvPicker = ({ envs, value, onChange }: { envs: Env[]; value: string; onChange: (id: string) => void }) => (
    <label className="inline env-picker">Environment
        <select value={value} onChange={(e) => onChange(e.target.value)}>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
    </label>
);

const ProductHome = ({ onOpen, onError }: { onOpen: (id: string) => void; onError: (m: string) => void }) => {
    const [ctx, setCtx] = useState<string | null>(null);
    const [pos, setPos] = useState<ProductOwner[] | null>(null);
    const [creating, setCreating] = useState(false);
    const [tab, setTab] = useState<"owners" | "context" | "memory">("owners");
    const [envs, setEnvs] = useState<Env[]>([]);
    useEffect(() => { void api.envs().then(setEnvs).catch(() => undefined); }, []);
    const [envId, setEnvId] = useProductEnv(envs);
    const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? "…";
    const loadOwners = useCallback(() => void api.productOwners().then(setPos).catch((e: Error) => onError(e.message)), [onError]);
    useEffect(loadOwners, [loadOwners]);
    useEffect(() => poBus.subscribe((ev) => ev.kind === "updated" && loadOwners()), [loadOwners]);
    useEffect(() => {
        if (!envId) return;
        setCtx(null);
        void api.productContext(envId).then((r) => setCtx(r.text)).catch((e: Error) => onError(e.message));
    }, [envId, onError]);
    const typeOf = (po: ProductOwner): string => (po.scope_kind === "env" ? "Whole environment" : po.source === "linear" ? "Linear project" : "ClickUp epic");
    const columns: DataColumn<ProductOwner>[] = [
        { key: "name", label: "Name", kind: "label", value: (po) => po.title, filter: false },
        { key: "env", label: "Environment", value: (po) => envName(po.env_id), filter: "auto" },
        { key: "type", label: "Type", value: typeOf, filter: "auto" },
        {
            key: "status",
            label: "Status",
            value: (po) => PHASE_LABEL[po.phase],
            filter: "auto",
            render: (po) => (
                <>
                    <span className={`chip ${po.phase === "live" ? "ok" : "accent"}`}>{PHASE_LABEL[po.phase]}</span>
                    {po.status === "running" && <span className="chip wait"> answering…</span>}
                    {po.status === "failed" && <span className="chip bad" title={po.status_line ?? ""}> failed</span>}
                </>
            ),
        },
        { key: "tickets", label: "Tickets #", kind: "num", hint: "Issues of the project in the task manager", value: (po) => po.tickets ?? 0, filter: false },
        { key: "tasks", label: "Tasks #", kind: "num", hint: "Stagehand tasks with this Product Owner", value: (po) => po.tasks ?? 0, filter: false },
        {
            key: "progress",
            label: "Progress %",
            hint: "Issues done ÷ all issues, by their status in the task manager; canceled ones count in neither",
            value: (po) => po.progress ?? -1,
            filter: false,
            render: (po) => (po.progress == null ? <span className="quiet">—</span> : <span className="share" title={`${po.ticketsDone ?? 0} of ${po.tickets ?? 0} done`}><i style={{ width: `${po.progress}%` }} /><span>{po.progress}%</span></span>),
        },
    ];
    const envLabel = envs.find((e) => e.id === envId)?.name;
    return (
        <div className="product">
            <div className="subtabs">
                <button className={tab === "owners" ? "active" : ""} onClick={() => setTab("owners")}>Product owners {pos ? <span className="chip">{pos.length}</span> : null}</button>
                <button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}>Product context</button>
                <button className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>Memory</button>
            </div>
            {creating && <NewPoDialog envs={envs} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} onError={onError} />}
            {tab === "owners" && (pos === null ? <div className="empty">loading…</div> : (
                <DataTable
                    title="Product owners"
                    entity="product owner"
                    onCreate={() => setCreating(true)}
                    createDisabled={envs.length ? undefined : "add an environment first"}
                    columns={columns}
                    rows={pos}
                    rowKey={(po) => po.id}
                    onRowClick={(po) => onOpen(po.id)}
                    storageKey="product-owners"
                    empty={<>No Product Owner yet. Use <b>Create new product owner</b> to start one.</>}
                />
            ))}
            {tab === "context" && <section className="card">
                <div className="po-head">
                    <h2>Product context <span className="field-hint">— this environment's product; its Product Owners read it</span></h2>
                    <EnvPicker envs={envs} value={envId} onChange={setEnvId} />
                </div>
                {ctx === null ? <div className="empty">loading…</div> : <EditableMarkdown key={envId} text={ctx} empty="Empty. Describe the product: what it is, who uses it, its main areas, its rules." onSave={async (t) => { await api.setProductContext(envId, t); setCtx(t); }} />}
            </section>}
            {tab === "memory" && <section className="card">
                <div className="po-head">
                    <h2>Memory <span className="field-hint">— this environment's product and its Product Owners</span></h2>
                    <EnvPicker envs={envs} value={envId} onChange={setEnvId} />
                </div>
                {envs.find((e) => e.id === envId) && <MemoryWings key={envId} env={envs.find((e) => e.id === envId)!} onError={onError} />}
                <PalaceSearch key={envId} env={envId} {...(envLabel ? { envLabel } : {})} onError={onError} />
            </section>}
        </div>
    );
};

// Which palace wings belong to an environment's memory besides its product wing and its Product Owners' (envs.memory_wings).
const MemoryWings = ({ env, onError }: { env: Env; onError: (m: string) => void }) => {
    const [saved, setSaved] = useState(() => { try { return (JSON.parse(env.memory_wings ?? "[]") as string[]).join(", "); } catch { return ""; } });
    const d = useDraft(() => ({ wings: saved }), [saved]);
    const { saving, run } = useSaver(onError);
    return (
        <EntityForm dirty={d.dirty} saving={saving === "wings"} onDiscard={d.reset} onSave={() => run("wings", async () => {
            const wings = d.value.wings.split(",").map((w) => w.trim()).filter(Boolean);
            await api.patchEnv(env.id, { memoryWings: wings });
            setSaved(wings.join(", "));
        })}>
            <Field label="Memory wings" hint="Palace wings that belong to this environment's memory besides its product wing and its Product Owners' — e.g. an imported palace's knowledge wings. Comma-separated."><input value={d.value.wings} onChange={(e) => d.patch({ wings: e.target.value })} /></Field>
        </EntityForm>
    );
};

// ---------- one PO ----------

const ArtifactRow = ({ poId, a, onRemove }: { poId: string; a: PoArtifact; onRemove: () => void }) => {
    const [text, setText] = useState<string | null>(null);
    const textual = a.mime?.startsWith("text/") || /\.(md|txt|csv|json)$/i.test(a.file);
    const image = (a.mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.file);
    const readable = textual ? a.file : a.text_file ?? null;
    return (
        <details className="po-artifact" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && text === null && readable) void api.poFileText(poId, readable).then(setText).catch(() => setText("(could not read)")); }}>
            <summary>
                <span className="chip">{a.kind}</span> <b>{a.title}</b>
                {a.source_url && <> <a href={a.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>source ↗</a></>}
                {image && <span className="chip">{a.description ? "image · described" : "image · describing…"}</span>}
                {a.text_file && <span className="chip">text extracted</span>}
                {!textual && <> <a href={api.poFileUrl(poId, a.file)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>open ↗</a></>}
                <button className="tiny danger" onClick={(e) => { e.preventDefault(); if (confirm(`Remove ${a.title}?`)) onRemove(); }}>Remove</button>
            </summary>
            {image && (
                <div className="po-image">
                    <img src={api.poFileUrl(poId, a.file)} alt={a.title} />
                    {a.description ? <Markdown source={a.description} /> : <div className="quiet">The description is on its way.</div>}
                </div>
            )}
            {readable && (text === null ? <div className="quiet">loading…</div> : textual ? <Markdown source={text} /> : <pre className="po-doc-text">{text}</pre>)}
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
    const read = d.po.issues_refreshed_at ? `read ${since(d.po.issues_refreshed_at)}` : "never read";
    return (
        <>
            {d.po.issues_error && <span className="chip bad" title={d.po.issues_error}>last refresh failed</span>}
            <button disabled={busy || d.refreshingIssues || d.running} title={`${d.issues.length} issue(s) tracked · ${read} · read every hour, and the Product Owner gets what changed${d.running ? " · wait for the Product Owner's turn" : ""}`} onClick={() => void refresh()}>{busy || d.refreshingIssues ? "Refreshing…" : "Refresh issues"}</button>
        </>
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

// The Product Owner's tickets: one list (components/DataTable) — a row opens the ticket's view (components/EntityView).
// A ticket becomes a tracker issue with Create in Linear/ClickUp, and an issue becomes a Stagehand task with Create task;
// both work on one ticket or on the checked ones.
const TicketsTab = ({ d, onError, reload, send }: { d: PoDetail; onError: (m: string) => void; reload: () => void; send: (t: string) => void }) => {
    const tickets = d.tickets?.tickets ?? [];
    const [sel, setSel] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [envName, setEnvName] = useState<string | null>(null);
    useEffect(() => { void api.envs().then((all) => setEnvName(all.find((e) => e.id === d.po.env_id)?.name ?? null)).catch(() => undefined); }, [d.po.env_id]);
    const tracker = d.po.source === "linear" ? "Linear" : "ClickUp";
    const byKey = useMemo(() => new Map(tickets.map((t) => [t.key, t])), [tickets]);
    const link = (k: string) => d.links.find((l) => l.key === k);
    const identOf = (t: PoTicket): string | null => link(t.key)?.identifier ?? t.existing ?? null;
    const issueOf = (t: PoTicket): PoIssue | undefined => { const id = identOf(t)?.toUpperCase(); return id ? d.issues.find((i) => i.identifier.toUpperCase() === id) : undefined; };
    const taskOf = (t: PoTicket) => { const id = identOf(t)?.toUpperCase(); return id ? d.tasks.find((x) => x.ticket_id.toUpperCase() === id) : undefined; };
    const act = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try { await fn(); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } finally { setBusy(false); }
    };
    const createIssues = (keys?: string[]) => act(() => api.poApproveTickets(d.po.id, keys));
    const createTasks = (ids: string[]) => act(() => api.createTasks({ envId: d.po.env_id ?? "", tickets: ids, mode: "each", productOwnerId: d.po.id }));
    if (!d.tickets) {
        return (
            <div className="empty">
                {d.ticketsError ? <div className="blocked-box">tickets.json: {d.ticketsError}</div> : null}
                No ticket proposal yet. {d.po.phase === "tickets" ? "The Product Owner is writing it." : "It comes after you approve the design."}
                {d.po.phase === "tickets" && <div className="actions"><button disabled={d.running} onClick={() => send("Write tickets.json now from the approved design.")}>Ask for the tickets</button></div>}
            </div>
        );
    }
    const current = sel ? byKey.get(sel) : undefined;
    if (current) {
        const ident = identOf(current);
        const issue = issueOf(current);
        const task = taskOf(current);
        const url = link(current.key)?.url ?? issue?.url ?? null;
        const save = async (next: PoTicket) => act(() => api.poSetTickets(d.po.id, tickets.map((t) => (t.key === next.key ? next : t))));
        return (
            <EntityView
                type="Tickets"
                onType={() => setSel(null)}
                id={<>{current.key}{ident ? ` · ${ident}` : ""} · {current.title}</>}
                actions={
                    <>
                        {!ident && <button className="primary" disabled={busy || d.running} onClick={() => void createIssues([current.key])}>Create in {tracker}</button>}
                        {ident && !task && <button className="primary" disabled={busy || !d.po.env_id} title={d.po.env_id ? undefined : "this Product Owner has no environment"} onClick={() => void createTasks([ident])}>Create task{envName ? ` in ${envName}` : ""}</button>}
                        {task && <a className="button" href={`#/tasks/${encodeURIComponent(task.id)}`}>Open task · {task.stage.replace(/_/g, " ")}</a>}
                        {url && <a className="button" href={url} target="_blank" rel="noreferrer">{ident} ↗</a>}
                    </>
                }
                tabs={[
                    {
                        key: "details",
                        label: "Details",
                        content: (
                            <div className="ev-fields">
                                <ReadField label="Type">{current.type}{current.estimate != null && <span className="chip">{current.estimate} pt</span>}{current.labels.map((l) => <span key={l} className="chip">{l}</span>)}</ReadField>
                                {current.parent && byKey.get(current.parent) && <ReadField label="Parent"><button className="tiny" onClick={() => setSel(current.parent)}>{current.parent} · {byKey.get(current.parent)!.title}</button></ReadField>}
                                {current.summary && <ReadField label="Summary">{current.summary}</ReadField>}
                                <Field label="Description"><Markdown source={current.description} /></Field>
                                {current.acceptanceCriteria.length > 0 && <Field label="Acceptance criteria"><ul className="po-ac">{current.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul></Field>}
                                {current.dependsOn.length > 0 && <ReadField label="Depends on">{current.dependsOn.map((k) => <button key={k} className="tiny" onClick={() => setSel(k)}>{k} {byKey.get(k)?.title ?? ""}</button>)}</ReadField>}
                            </div>
                        ),
                    },
                    ...(issue ? [{ key: "tracker", label: tracker, content: <LiveIssue issue={issue} /> }] : []),
                    ...(!link(current.key) ? [{ key: "edit", label: "Edit", content: <TicketEditor key={current.key} t={current} onSave={(t) => void save(t)} onCancel={() => setSel(current.key)} /> }] : []),
                ]}
            />
        );
    }
    const pendingAll = tickets.filter((t) => !identOf(t));
    const columns: DataColumn<PoTicket>[] = [
        { key: "key", label: "Key", value: (t) => t.key, filter: false },
        { key: "title", label: "Title", kind: "label", value: (t) => t.title, filter: false },
        { key: "type", label: "Type", value: (t) => t.type, filter: "auto", render: (t) => <span className={`chip ${t.type === "epic" ? "accent" : t.type === "bug" ? "bad" : ""}`}>{t.type}</span> },
        { key: "points", label: "Points", kind: "num", value: (t) => t.estimate ?? null, filter: false, render: (t) => (t.estimate == null ? <span className="quiet">—</span> : t.estimate) },
        { key: "issue", label: tracker, value: (t) => identOf(t) ?? "not created", filter: false, render: (t) => (identOf(t) ? <span className="chip ok">{identOf(t)}</span> : <span className="chip">not created</span>) },
        { key: "status", label: "Status", value: (t) => issueOf(t)?.status ?? "", filter: "auto" },
        { key: "task", label: "Task", value: (t) => taskOf(t)?.stage.replace(/_/g, " ") ?? "none", filter: "auto" },
        { key: "comments", label: "Comments", kind: "num", value: (t) => issueOf(t)?.comments.length ?? 0, filter: false, defaultHidden: true },
        { key: "parent", label: "Parent", value: (t) => t.parent ?? "", filter: false, defaultHidden: true },
    ];
    return (
        <>
            {d.ticketsError && <div className="blocked-box">tickets.json: {d.ticketsError}</div>}
            <DataTable
                title="Tickets"
                columns={columns}
                rows={tickets}
                rowKey={(t) => t.key}
                onRowClick={(t) => setSel(t.key)}
                storageKey="po-tickets"
                actions={
                    <>
                        <IssuesRefresh d={d} onError={onError} reload={reload} />
                        {pendingAll.length > 0 && <button className="primary" disabled={busy || d.running} title={`Creates the ${pendingAll.length} ticket(s) not in ${tracker} yet`} onClick={() => void createIssues()}>{busy ? "Creating…" : `Create ${pendingAll.length} in ${tracker}`}</button>}
                    </>
                }
                bulkActions={(rows, clear) => {
                    const toCreate = rows.filter((t) => !identOf(t));
                    const toStart = rows.filter((t) => identOf(t) && !taskOf(t));
                    return (
                        <>
                            {toCreate.length > 0 && <button className="tiny" disabled={busy || d.running} onClick={() => void createIssues(toCreate.map((t) => t.key)).then(clear)}>Create {toCreate.length} in {tracker}</button>}
                            {toStart.length > 0 && <button className="tiny primary" disabled={busy || !d.po.env_id} onClick={() => void createTasks(toStart.map((t) => identOf(t)!)).then(clear)}>Create {toStart.length} task{toStart.length === 1 ? "" : "s"}{envName ? ` in ${envName}` : ""}</button>}
                        </>
                    );
                }}
            />
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

const PoPage = ({ id, tab: tabArg, onTab, onBack, onError }: { id: string; tab: PoTab | undefined; onTab: (t: PoTab) => void; onBack: () => void; onError: (m: string) => void }) => {
    const [d, setD] = useState<PoDetail | null>(null);
    const reload = useCallback(() => void api.productOwner(id).then(setD).catch((e: Error) => onError(e.message)), [id, onError]);
    useEffect(reload, [reload]);
    const send = (t: string) => void api.poSend(id, t).then(reload).catch((e: Error) => onError(e.message));
    if (!d) return <div className="empty">loading…</div>;
    const idx = PHASES.indexOf(d.po.phase);
    const tabs: PoTab[] = d.po.scope_kind === "env" ? ["questions", "corrections", "context", "events"] : ["design", "questions", "corrections", "context", "tickets", "events"];
    // No tab in the URL: the first one.
    const tab = tabArg ?? tabs[0]!;
    const openQuestions = d.questions.filter((q) => q.status === "open" || q.status === "proposed").length;
    const proposed = d.questions.filter((q) => q.status === "proposed").length;
    const unread = d.events.filter((e) => e.status === "unread" || e.status === "failed").length;
    const openCorrections = d.corrections.filter((c) => c.status === "open").length;
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
                        {tabs.map((t) => (
                            <button key={t} className={tab === t ? "active" : ""} onClick={() => onTab(t)}>
                                {t === "context" ? `Context · ${d.artifacts.length} source(s)` : t === "design" ? "Design" : t === "questions" ? "Questions" : t === "events" ? "Events" : t === "corrections" ? "Corrections" : `Tickets${d.tickets ? ` · ${d.tickets.tickets.length}` : ""}`}
                                {t === "context" && d.proposal && <span className="chip warn">proposal</span>}
                                {t === "questions" && openQuestions > 0 && <span className="chip">{openQuestions}</span>}
                                {t === "questions" && proposed > 0 && <span className="chip accent" title="Resolutions to confirm">{proposed} to confirm</span>}
                                {t === "events" && unread > 0 && <span className="chip warn" title="Events the Product Owner has not read">{unread}</span>}
                                {t === "corrections" && openCorrections > 0 && <span className="chip warn">{openCorrections}</span>}
                            </button>
                        ))}
                    </div>
                    {tab === "context" && <ContextTab d={d} onError={onError} reload={reload} />}
                    {tab === "design" && d.po.scope_kind !== "env" && <DesignTab d={d} onError={onError} reload={reload} send={send} />}
                    {tab === "questions" && <QuestionsTab d={d} onError={onError} reload={reload} />}
                    {tab === "tickets" && d.po.scope_kind !== "env" && <TicketsTab d={d} onError={onError} reload={reload} send={send} />}
                    {tab === "events" && <EventsTab d={d} onError={onError} reload={reload} />}
                    {tab === "corrections" && <CorrectionsTab d={d} onError={onError} reload={reload} />}
                </div>
                <PoChat d={d} onError={onError} reload={reload} />
            </div>
        </div>
    );
};

export const ProductPage = ({ po, tab, onNavigate, onError }: { po?: string; tab?: PoTab; onNavigate: (po?: string, tab?: PoTab) => void; onError: (m: string) => void }) =>
    po ? <PoPage key={po} id={po} tab={tab} onTab={(t) => onNavigate(po, t)} onBack={() => onNavigate()} onError={onError} /> : <ProductHome onOpen={(id) => onNavigate(id)} onError={onError} />;
