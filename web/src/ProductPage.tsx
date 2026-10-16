import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, poEnvIds, type Env, type PalaceHit, type PoArtifact, type PoDetail, type PoIssue, type PoPhase, type PoTicket, type ProductOwner } from "./api";
import { Markdown } from "./Markdown";
import { Modal } from "./Modal";
import { DataTable, type DataColumn } from "./components/DataTable";
import { EntityForm, EntityView, Field, ReadField, useDraft, useSaver } from "./components/EntityView";
import { poBus } from "./poBus";
import { navigate, type PoTab, type Route } from "./routes";

type ProductRoute = Extract<Route, { page: "product" }>;
import { CorrectionsTab, EventsTab, QuestionsTab } from "./PoJournal";
import { Collapsible } from "./components/Collapsible";
import { CheckboxSelect } from "./components/CheckboxSelect";
import { Button, Card, Chip, Input, Select, Textarea, Tab, TabList } from "@vortex/ds";

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
            <Textarea className="md-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(30, Math.max(8, draft.split("\n").length + 2))} />
            <div className="actions">
                <Button variant="primary" onClick={async () => { await onSave(draft); setEditing(false); }}>Save</Button>
                <Button onClick={() => setEditing(false)}>Cancel</Button>
            </div>
        </>
    ) : (
        <>
            {text.trim() ? <Markdown source={text} /> : <div className="empty">{empty}</div>}
            <div className="actions"><Button onClick={() => setEditing(true)}>Edit</Button></div>
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
                <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void run()} placeholder={wing ? `Search this PO's memory (${wing})` : `Search the memory of ${envLabel ?? "this environment"}`} />
                <Button onClick={() => void run()}>Search</Button>
            </div>
            {hits && (hits.length === 0 ? <div className="quiet">No drawers match.</div> : (
                <div className="palace-hits">
                    {hits.map((h, i) => (
                        <details key={i} className="palace-hit">
                            <summary><Chip>{h.wing}</Chip><Chip>{h.room}</Chip>{h.similarity != null && <span className="field-hint"> {Math.round(h.similarity * 100)} %</span>} {h.text.split("\n")[0]?.slice(0, 120)}</summary>
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
    // The environments the PO works for, the first picked is its primary one; all on one task manager.
    const [envIds, setEnvIds] = useState<string[]>(envs[0] ? [envs[0].id] : []);
    const env = envs.find((e) => e.id === envIds[0]);
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
        // A project PO works for every picked environment; an environment PO is one per environment, each with the sources.
        let pos: ProductOwner[];
        try {
            pos = kind === "env" ? await Promise.all(envIds.map((id) => api.createEnvProductOwner([id]))) : [await api.createProductOwner(url.trim(), envIds, false)];
        } catch (e) {
            setProgress(null);
            onError(String((e as Error).message ?? e));
            return;
        }
        const failed: string[] = [];
        for (const po of pos) {
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
        }
        if (failed.length) onError(`Some sources were not added — add them on the Context tab:\n${failed.join("\n")}`);
        onCreated(pos[0]!.id);
    };
    const label = (s: PendingSource) => (s.kind === "url" ? s.url : s.kind === "text" ? `${s.title || "Pasted text"} (${s.text.length} characters)` : `${s.file.name} (${Math.round(s.file.size / 1024)} KB)`);
    return (
        <Modal title="New product owner" onClose={() => !progress && onClose()} wide>
            <label>Environments
                <EnvsSelect envs={envs} value={envIds} switchable onChange={(ids) => { if (envs.find((e) => e.id === ids[0])?.ticket_source !== env?.ticket_source) setUrl(""); setEnvIds(ids); }} />
            </label>
            <div className="po-kind">
                <label className="inline"><Input type="radio" checked={kind === "project"} onChange={() => setKind("project")} /> <b>Project</b> — one {manager === "Linear" ? "Linear project" : "ClickUp epic"}: plans it, designs it, splits it into tickets</label>
                <label className="inline"><Input type="radio" checked={kind === "env"} onChange={() => setKind("env")} /> <b>Whole environment</b> — no project: briefs and reviews every task of the environment that has no project PO, from the product context and the environment's memory (one per picked environment)</label>
            </div>
            {kind === "project" && (
                <>
                    <div className="field-hint">Task manager: <b>{manager}</b> — the Product Owner reads its project and creates tickets only there. Only the tasks of the picked environments get it.</div>
                    <label>{manager === "Linear" ? "Linear project" : "ClickUp epic"}
                        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={manager === "Linear" ? "https://linear.app/<workspace>/project/…" : "https://app.clickup.com/t/…"} />
                    </label>
                    {url.trim() && !urlOk && <div className="field-hint bad">This is not a {manager === "Linear" ? "Linear project URL" : "ClickUp task URL"}.</div>}
                </>
            )}
            <h3>Sources <span className="field-hint">— optional; the Product Owner reads them in its first turn</span></h3>
            {sources.length > 0 && (
                <ul className="po-pending">
                    {sources.map((s, i) => (
                        <li key={i}><Chip>{s.kind}</Chip> {label(s)} <Button size="sm" onClick={() => setSources((x) => x.filter((_, j) => j !== i))}>Remove</Button></li>
                    ))}
                </ul>
            )}
            <div className="po-row">
                <Input value={srcUrl} onChange={(e) => setSrcUrl(e.target.value)} placeholder="Linear issue, ClickUp task, Notion page, Figma link or any web page URL" />
                <Button disabled={!/^https?:\/\//.test(srcUrl.trim())} onClick={() => { setSources((x) => [...x, { kind: "url", url: srcUrl.trim() }]); setSrcUrl(""); }}>Add URL</Button>
                <Button onClick={() => setPaste((p) => (p ? null : { title: "", text: "" }))}>Paste text</Button>
                <Button onClick={() => fileRef.current?.click()}>Upload files</Button>
                <Input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; setSources((x) => [...x, ...files.map((file) => ({ kind: "file" as const, file }))]); }} />
            </div>
            {paste && (
                <div className="po-paste">
                    <Input value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder="Title (optional)" />
                    <Textarea rows={8} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste a conversation, notes or any text with context for this project" autoFocus />
                    <div className="actions"><Button disabled={!paste.text.trim()} onClick={() => { setSources((x) => [...x, { kind: "text", title: paste.title.trim(), text: paste.text }]); setPaste(null); }}>Add text</Button></div>
                </div>
            )}
            <div className="actions">
                <Button variant="primary" disabled={!env || (kind === "project" && !urlOk) || !!progress} onClick={() => void create()}>{progress ?? "Create"}</Button>
                <Button disabled={!!progress} onClick={onClose}>Cancel</Button>
            </div>
        </Modal>
    );
};

// The environments a PO works for: any number on the task manager of the first picked one (the primary). With
// `switchable` (a PO not created yet) an environment on another task manager replaces the selection instead of being
// disabled — otherwise the first environment's task manager would lock the others out for good.
const EnvsSelect = ({ envs, value, onChange, disabled, switchable }: { envs: Env[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; switchable?: boolean }) => {
    const source = envs.find((e) => e.id === value[0])?.ticket_source;
    const sourceOf = (id: string) => envs.find((e) => e.id === id)?.ticket_source;
    return (
        <CheckboxSelect
            options={envs.map((e) => ({ value: e.id, label: e.name, disabled: !switchable && source && e.ticket_source !== source ? `uses ${e.ticket_source === "linear" ? "Linear" : "ClickUp"}, not ${source === "linear" ? "Linear" : "ClickUp"}` : undefined }))}
            value={value}
            onChange={(ids) => {
                const added = ids.find((id) => !value.includes(id));
                onChange(added && sourceOf(added) !== source ? [added] : ids);
            }}
            min={1}
            {...(disabled ? { disabled } : {})}
        />
    );
};

const EnvPicker = ({ envs, value, onChange }: { envs: Env[]; value: string; onChange: (id: string) => void }) => (
    <label className="inline env-picker">Environment
        <Select value={value} onChange={(e) => onChange(e.target.value)}>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>
    </label>
);

// The subtab, the New dialog and the environment the context/memory tabs show are all routed (#/product/context?env=…).
const ProductHome = ({ route, onOpen, onError }: { route: ProductRoute; onOpen: (id: string) => void; onError: (m: string) => void }) => {
    const [ctx, setCtx] = useState<string | null>(null);
    const [pos, setPos] = useState<ProductOwner[] | null>(null);
    const creating = !!route.create;
    const setCreating = (on: boolean): void => navigate(on ? { page: "product", create: true } : { page: "product" });
    const tab: "owners" | "context" | "memory" = route.home ?? "owners";
    const [envs, setEnvs] = useState<Env[]>([]);
    useEffect(() => { void api.envs().then(setEnvs).catch(() => undefined); }, []);
    const envId = envs.some((e) => e.id === route.env) ? route.env! : envs[0]?.id ?? "";
    const setTab = (t: "owners" | "context" | "memory"): void => navigate(t === "owners" ? { page: "product" } : { page: "product", home: t, ...(envId ? { env: envId } : {}) });
    const setEnvId = (id: string): void => navigate({ page: "product", home: tab === "owners" ? "context" : tab, env: id });
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
        { key: "env", label: "Environments", value: (po) => poEnvIds(po).map(envName).join(", "), filter: "auto" },
        { key: "type", label: "Type", value: typeOf, filter: "auto" },
        {
            key: "status",
            label: "Status",
            value: (po) => PHASE_LABEL[po.phase],
            filter: "auto",
            render: (po) => (
                <>
                    <Chip className={`${po.phase === "live" ? "ok" : "accent"}`}>{PHASE_LABEL[po.phase]}</Chip>
                    {po.status === "running" && <Chip tone="wait"> answering…</Chip>}
                    {po.status === "failed" && <Chip tone="bad" title={po.status_line ?? ""}> failed</Chip>}
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
            <TabList variant="pill">
                <Tab active={tab === "owners"} onClick={() => setTab("owners")}>Product owners {pos ? <Chip>{pos.length}</Chip> : null}</Tab>
                <Tab active={tab === "context"} onClick={() => setTab("context")}>Product context</Tab>
                <Tab active={tab === "memory"} onClick={() => setTab("memory")}>Memory</Tab>
            </TabList>
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
            {tab === "context" && <details className="card">
                <summary>
                    <h2>Product context <span className="field-hint">— this environment's product; its Product Owners read it</span></h2>
                    <span style={{ marginLeft: "auto" }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}><EnvPicker envs={envs} value={envId} onChange={setEnvId} /></span>
                </summary>
                <div className="card-body">
                    {ctx === null ? <div className="empty">loading…</div> : <EditableMarkdown key={envId} text={ctx} empty="Empty. Describe the product: what it is, who uses it, its main areas, its rules." onSave={async (t) => { await api.setProductContext(envId, t); setCtx(t); }} />}
                </div>
            </details>}
            {tab === "memory" && <Card>
                <div className="po-head">
                    <h2>Memory <span className="field-hint">— this environment's product and its Product Owners</span></h2>
                    <EnvPicker envs={envs} value={envId} onChange={setEnvId} />
                </div>
                {envs.find((e) => e.id === envId) && <MemoryWings key={envId} env={envs.find((e) => e.id === envId)!} onError={onError} />}
                <PalaceSearch key={envId} env={envId} {...(envLabel ? { envLabel } : {})} onError={onError} />
            </Card>}
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
            <Field label="Memory wings" hint="Palace wings that belong to this environment's memory besides its product wing and its Product Owners' — e.g. an imported palace's knowledge wings. Comma-separated."><Input value={d.value.wings} onChange={(e) => d.patch({ wings: e.target.value })} /></Field>
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
                <Chip>{a.kind}</Chip> <b>{a.title}</b>
                {a.source_url && <> <a href={a.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>source ↗</a></>}
                {image && <Chip>{a.description ? "image · described" : "image · describing…"}</Chip>}
                {a.text_file && <Chip>text extracted</Chip>}
                {!textual && <> <a href={api.poFileUrl(poId, a.file)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>open ↗</a></>}
                <Button size="sm" variant="danger" onClick={(e) => { e.preventDefault(); if (confirm(`Remove ${a.title}?`)) onRemove(); }}>Remove</Button>
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
                        <Button variant="primary" onClick={() => void act(() => api.poAcceptProposal(d.po.id))}>Accept</Button>
                        <Button onClick={() => void act(() => api.poRejectProposal(d.po.id))}>Reject</Button>
                    </div>
                </div>
            )}
            <Collapsible title="Project context" hint="— the PO keeps it current; filed in its palace wing after every turn">
                <EditableMarkdown text={d.context} empty="Empty — the Product Owner writes it in the first turn." onSave={(t) => api.poSetContext(d.po.id, t).then(reload)} />
            </Collapsible>
            <Card>
                <h2>Sources <Chip>{d.artifacts.length}</Chip></h2>
                <div className="po-row">
                    <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Linear project or issue, ClickUp task, Notion page, Figma link, or any web page URL" />
                    <Button disabled={busy || url.trim().length < 8} onClick={() => void act(async () => { await api.poFetch(d.po.id, url.trim()); setUrl(""); })}>{busy ? "Fetching…" : "Fetch"}</Button>
                    <Button disabled={busy} onClick={() => fileRef.current?.click()}>Upload</Button>
                    <Button disabled={busy} onClick={() => setPaste((p) => (p ? null : { title: "", text: "", tell: true }))}>Paste text</Button>
                    <Input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; void act(async () => { for (const f of files) await api.poUpload(d.po.id, f); }); }} />
                </div>
                {paste && (
                    <div className="po-paste">
                        <Input value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder="Title (optional) — e.g. Call with Austin about density" />
                        <Textarea rows={10} value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste a conversation, notes or any text with context for this project" autoFocus />
                        <div className="actions">
                            <label className="inline" title={d.running ? "The Product Owner is answering; it reads the source in a later turn" : undefined}><Input type="checkbox" checked={paste.tell} onChange={(e) => setPaste({ ...paste, tell: e.target.checked })} /> Product Owner reads it now and updates the context</label>
                            <Button variant="primary" disabled={busy || !paste.text.trim()} onClick={() => void act(async () => { await api.poPaste(d.po.id, paste.title, paste.text, paste.tell); setPaste(null); })}>Add source</Button>
                            <Button onClick={() => setPaste(null)}>Cancel</Button>
                        </div>
                    </div>
                )}
                {d.artifacts.map((a) => <ArtifactRow key={a.id} poId={d.po.id} a={a} onRemove={() => void act(() => api.poRemoveArtifact(d.po.id, a.id))} />)}
            </Card>
            <Card>
                <h2>Memory</h2>
                <PalaceSearch wing={d.po.slug} onError={onError} />
            </Card>
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
                <div className="actions"><Button variant="primary" disabled={d.running} onClick={() => send("Write design.md now, from what we know. Mark what is still open in Open questions.")}>Ask for the design</Button></div>
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
                        <Select value={rev?.name ?? ""} onChange={async (e) => { const n = e.target.value; if (!n) return setRev(null); try { setRev({ name: n, text: (await api.poRevision(d.po.id, n)).text }); } catch (err) { onError(String((err as Error).message ?? err)); } }}>
                            <option value="">current</option>
                            {revs.slice(0, -1).reverse().map((r) => <option key={r.name} value={r.name}>{new Date(r.at).toLocaleString()}</option>)}
                        </Select>
                    </label>
                )}
            </nav>
            <div className="po-doc-body">
                {rev && <div className="review-box">You are reading an earlier version. <Button onClick={() => setRev(null)}>Back to current</Button></div>}
                {canApprove && !rev && (
                    <div className="review-box">
                        <b>Design — your call.</b> Refine it in the chat, or approve it: the Product Owner then splits it into tickets.
                        <div className="actions"><Button variant="primary" disabled={d.running} onClick={async () => { try { await api.poApproveDesign(d.po.id); reload(); } catch (e) { onError(String((e as Error).message ?? e)); } }}>Approve design</Button></div>
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
            <label>Title<Input value={x.title} onChange={(e) => setX({ ...x, title: e.target.value })} /></label>
            <label>Type<Select value={x.type} onChange={(e) => setX({ ...x, type: e.target.value as PoTicket["type"] })}>{["epic", "story", "task", "bug"].map((k) => <option key={k}>{k}</option>)}</Select></label>
            <label>Estimate<Input value={x.estimate ?? ""} onChange={(e) => setX({ ...x, estimate: e.target.value.trim() === "" ? null : Number(e.target.value) })} /></label>
            <label>Summary<Input value={x.summary} onChange={(e) => setX({ ...x, summary: e.target.value })} /></label>
            <label>Description<Textarea rows={8} value={x.description} onChange={(e) => setX({ ...x, description: e.target.value })} /></label>
            <label>Acceptance criteria (one per line)<Textarea rows={5} value={x.acceptanceCriteria.join("\n")} onChange={(e) => setX({ ...x, acceptanceCriteria: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) })} /></label>
            <div className="actions"><Button variant="primary" onClick={() => onSave(x)}>Save</Button><Button onClick={onCancel}>Cancel</Button></div>
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
            {d.po.issues_error && <Chip tone="bad" title={d.po.issues_error}>last refresh failed</Chip>}
            <Button disabled={busy || d.refreshingIssues || d.running} title={`${d.issues.length} issue(s) tracked · ${read} · read every hour, and the Product Owner gets what changed${d.running ? " · wait for the Product Owner's turn" : ""}`} onClick={() => void refresh()}>{busy || d.refreshingIssues ? "Refreshing…" : "Refresh issues"}</Button>
        </>
    );
};

// The issue behind a ticket as the task manager has it now: status, labels, assignee and its comments.
const LiveIssue = ({ issue }: { issue: PoIssue }) => (
    <>
        <h3>In {issue.url.includes("clickup") ? "ClickUp" : "Linear"} now</h3>
        <div className="po-ticket-meta">
            <Chip tone="accent">{issue.status ?? "?"}</Chip>
            {issue.assignee && <Chip>{issue.assignee}</Chip>}
            {issue.priority && <Chip>priority {issue.priority}</Chip>}
            {issue.labels.map((l) => <Chip key={l}>{l}</Chip>)}
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
const TicketsTab = ({ d, sel, ticketTab, onError, reload, send }: { d: PoDetail; sel: string | null; ticketTab: string | undefined; onError: (m: string) => void; reload: () => void; send: (t: string) => void }) => {
    const tickets = d.tickets?.tickets ?? [];
    // The opened ticket and its tab are routed (#/product/<po>/tickets/<key>/<tab>).
    const setSel = (key: string | null, tab?: string): void => navigate({ page: "product", po: d.po.id, tab: "tickets", ...(key ? { ticket: key } : {}), ...(key && tab ? { ticketTab: tab } : {}) });
    const [busy, setBusy] = useState(false);
    // Tasks are created in one of the PO's environments: its primary one unless another is picked.
    const [allEnvs, setAllEnvs] = useState<Env[]>([]);
    useEffect(() => { void api.envs().then(setAllEnvs).catch(() => undefined); }, []);
    const poEnvs = poEnvIds(d.po);
    const [target, setTarget] = useState(d.po.env_id);
    const targetEnv = poEnvs.includes(target) ? target : d.po.env_id;
    const envName = allEnvs.find((e) => e.id === targetEnv)?.name ?? null;
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
    const createTasks = (ids: string[]) => act(() => api.createTasks({ envId: targetEnv, tickets: ids, mode: "each", productOwnerId: d.po.id }));
    const targetPicker = poEnvs.length > 1 && (
        <Select value={targetEnv} title="The environment new tasks are created in" onChange={(e) => setTarget(e.target.value)}>
            {poEnvs.map((id) => <option key={id} value={id}>{allEnvs.find((e) => e.id === id)?.name ?? id}</option>)}
        </Select>
    );
    if (!d.tickets) {
        return (
            <div className="empty">
                {d.ticketsError ? <div className="blocked-box">tickets.json: {d.ticketsError}</div> : null}
                No ticket proposal yet. {d.po.phase === "tickets" ? "The Product Owner is writing it." : "It comes after you approve the design."}
                {d.po.phase === "tickets" && <div className="actions"><Button disabled={d.running} onClick={() => send("Write tickets.json now from the approved design.")}>Ask for the tickets</Button></div>}
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
                tab={ticketTab}
                onTab={(t) => setSel(current.key, t)}
                id={<>{current.key}{ident ? ` · ${ident}` : ""} · {current.title}</>}
                actions={
                    <>
                        {!ident && <Button variant="primary" disabled={busy || d.running} onClick={() => void createIssues([current.key])}>Create in {tracker}</Button>}
                        {ident && !task && <>{targetPicker}<Button variant="primary" disabled={busy || !d.po.env_id} title={d.po.env_id ? undefined : "this Product Owner has no environment"} onClick={() => void createTasks([ident])}>Create task{envName ? ` in ${envName}` : ""}</Button></>}
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
                                <ReadField label="Type">{current.type}{current.estimate != null && <Chip>{current.estimate} pt</Chip>}{current.labels.map((l) => <Chip key={l}>{l}</Chip>)}</ReadField>
                                {current.parent && byKey.get(current.parent) && <ReadField label="Parent"><Button size="sm" onClick={() => setSel(current.parent)}>{current.parent} · {byKey.get(current.parent)!.title}</Button></ReadField>}
                                {current.summary && <ReadField label="Summary">{current.summary}</ReadField>}
                                <Field label="Description"><Markdown source={current.description} /></Field>
                                {current.acceptanceCriteria.length > 0 && <Field label="Acceptance criteria"><ul className="po-ac">{current.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul></Field>}
                                {current.dependsOn.length > 0 && <ReadField label="Depends on">{current.dependsOn.map((k) => <Button size="sm" key={k} onClick={() => setSel(k)}>{k} {byKey.get(k)?.title ?? ""}</Button>)}</ReadField>}
                            </div>
                        ),
                    },
                    ...(issue ? [{ key: "tracker", label: tracker, content: <LiveIssue issue={issue} /> }] : []),
                    ...(!link(current.key) ? [{ key: "edit", label: "Edit", content: <TicketEditor key={current.key} t={current} onSave={(t) => void save(t)} onCancel={() => setSel(current.key, "details")} /> }] : []),
                ]}
            />
        );
    }
    const pendingAll = tickets.filter((t) => !identOf(t));
    const columns: DataColumn<PoTicket>[] = [
        { key: "key", label: "Key", value: (t) => t.key, filter: false },
        { key: "title", label: "Title", kind: "label", value: (t) => t.title, filter: false },
        { key: "type", label: "Type", value: (t) => t.type, filter: "auto", render: (t) => <Chip className={`${t.type === "epic" ? "accent" : t.type === "bug" ? "bad" : ""}`}>{t.type}</Chip> },
        { key: "points", label: "Points", kind: "num", value: (t) => t.estimate ?? null, filter: false, render: (t) => (t.estimate == null ? <span className="quiet">—</span> : t.estimate) },
        { key: "issue", label: tracker, value: (t) => identOf(t) ?? "not created", filter: false, render: (t) => (identOf(t) ? <Chip tone="ok">{identOf(t)}</Chip> : <Chip>not created</Chip>) },
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
                        {pendingAll.length > 0 && <Button variant="primary" disabled={busy || d.running} title={`Creates the ${pendingAll.length} ticket(s) not in ${tracker} yet`} onClick={() => void createIssues()}>{busy ? "Creating…" : `Create ${pendingAll.length} in ${tracker}`}</Button>}
                    </>
                }
                bulkActions={(rows, clear) => {
                    const toCreate = rows.filter((t) => !identOf(t));
                    const toStart = rows.filter((t) => identOf(t) && !taskOf(t));
                    return (
                        <>
                            {toCreate.length > 0 && <Button size="sm" disabled={busy || d.running} onClick={() => void createIssues(toCreate.map((t) => t.key)).then(clear)}>Create {toCreate.length} in {tracker}</Button>}
                            {toStart.length > 0 && targetPicker}
                            {toStart.length > 0 && <Button size="sm" variant="primary" disabled={busy || !d.po.env_id} onClick={() => void createTasks(toStart.map((t) => identOf(t)!)).then(clear)}>Create {toStart.length} task{toStart.length === 1 ? "" : "s"}{envName ? ` in ${envName}` : ""}</Button>}
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
                <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={d.running ? "The Product Owner is answering…" : "Message the Product Owner (⌘/Ctrl+Enter sends)"} rows={3} disabled={d.running} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} />
                <div className="actions">
                    {d.running ? <Button variant="danger" onClick={() => void api.poStop(d.po.id).then(reload)}>Stop</Button> : <Button variant="primary" disabled={!text.trim()} onClick={() => void send()}>Send</Button>}
                </div>
            </div>
        </div>
    );
};

// The environments the PO works for, changed in place; an environment's own PO stays with its environment.
const PoEnvs = ({ d, onSaved, onError }: { d: PoDetail; onSaved: () => void; onError: (m: string) => void }) => {
    const [envs, setEnvs] = useState<Env[]>([]);
    useEffect(() => { void api.envs().then(setEnvs).catch(() => undefined); }, []);
    const env = d.po.scope_kind === "env";
    return (
        <span className="inline" title={env ? "An environment's own Product Owner belongs to that one environment" : "The environments this Product Owner works for; the first is its primary one"}>
            <EnvsSelect envs={envs} value={poEnvIds(d.po)} disabled={env} onChange={(ids) => void api.setProductOwnerEnvs(d.po.id, ids).then(onSaved).catch((e: Error) => onError(e.message))} />
        </span>
    );
};

const PoPage = ({ id, tab: tabArg, ticket, ticketTab, onTab, onBack, onError }: { id: string; tab: PoTab | undefined; ticket: string | undefined; ticketTab: string | undefined; onTab: (t: PoTab) => void; onBack: () => void; onError: (m: string) => void }) => {
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
                <Button onClick={onBack}>← Product</Button>
                <h1>{d.po.title}</h1>
                {d.po.scope_url && <a href={d.po.scope_url} target="_blank" rel="noreferrer">{d.po.source === "linear" ? "Linear project" : "ClickUp epic"} ↗</a>}
                <PoEnvs d={d} onSaved={reload} onError={onError} />
                <span className="po-phases">{PHASES.map((p, i) => <Chip key={p} className={`${i < idx ? "ok" : i === idx ? "accent" : ""}`}>{PHASE_LABEL[p]}</Chip>)}</span>
                {d.po.status_line && <span className={`field-hint ${d.po.status === "failed" ? "bad" : ""}`}>{d.po.status_line}</span>}
                <span className="spacer" />
                {d.tasks.length > 0 && <span className="field-hint">{d.tasks.length} task(s) assigned</span>}
                <Button variant="danger" onClick={async () => { if (!confirm(`Delete the Product Owner "${d.po.title}"? Its chat, sources and proposals go; its palace wing and the created tickets stay.`)) return; await api.deleteProductOwner(id); onBack(); }}>Delete</Button>
            </div>
            <div className="po-layout">
                <div className="po-main">
                    <TabList variant="pill">
                        {tabs.map((t) => (
                            <Tab key={t} active={tab === t} onClick={() => onTab(t)}>
                                {t === "context" ? `Context · ${d.artifacts.length} source(s)` : t === "design" ? "Design" : t === "questions" ? "Questions" : t === "events" ? "Events" : t === "corrections" ? "Corrections" : `Tickets${d.tickets ? ` · ${d.tickets.tickets.length}` : ""}`}
                                {t === "context" && d.proposal && <Chip tone="warn">proposal</Chip>}
                                {t === "questions" && openQuestions > 0 && <Chip>{openQuestions}</Chip>}
                                {t === "questions" && proposed > 0 && <Chip tone="accent" title="Resolutions to confirm">{proposed} to confirm</Chip>}
                                {t === "events" && unread > 0 && <Chip tone="warn" title="Events the Product Owner has not read">{unread}</Chip>}
                                {t === "corrections" && openCorrections > 0 && <Chip tone="warn">{openCorrections}</Chip>}
                            </Tab>
                        ))}
                    </TabList>
                    {tab === "context" && <ContextTab d={d} onError={onError} reload={reload} />}
                    {tab === "design" && d.po.scope_kind !== "env" && <DesignTab d={d} onError={onError} reload={reload} send={send} />}
                    {tab === "questions" && <QuestionsTab d={d} onError={onError} reload={reload} />}
                    {tab === "tickets" && d.po.scope_kind !== "env" && <TicketsTab d={d} sel={ticket ?? null} ticketTab={ticketTab} onError={onError} reload={reload} send={send} />}
                    {tab === "events" && <EventsTab d={d} onError={onError} reload={reload} />}
                    {tab === "corrections" && <CorrectionsTab d={d} onError={onError} reload={reload} />}
                </div>
                <Collapsible title="Chat with the Product Owner" defaultOpen><PoChat d={d} onError={onError} reload={reload} /></Collapsible>
            </div>
        </div>
    );
};

export const ProductPage = ({ route, onError }: { route: ProductRoute; onError: (m: string) => void }) => {
    const po = route.po;
    return po
        ? <PoPage key={po} id={po} tab={route.tab} ticket={route.ticket} ticketTab={route.ticketTab} onTab={(t) => navigate({ page: "product", po, tab: t })} onBack={() => navigate({ page: "product" })} onError={onError} />
        : <ProductHome route={route} onOpen={(id) => navigate({ page: "product", po: id })} onError={onError} />;
};
