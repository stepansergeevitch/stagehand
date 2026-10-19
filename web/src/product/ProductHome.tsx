import { useCallback, useEffect, useRef, useState } from "react";
import { Loading } from "../components/Loading";
import { errText } from "../format";
import { api, poEnvIds, trackerName, type Env, type ProductOwner } from "../api";
import { Modal } from "../Modal";
import { DataTable, type DataColumn } from "../components/DataTable";
import { EntityForm, Field, useDraft, useSaver } from "../components/EntityView";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { navigate, type Route } from "../routes";
import { poBus } from "../poBus";
import { Badge, Button, Chip, Input, Radio, Select, Tabs, Textarea } from "@vortex/ds";
import { EditableMarkdown, EnvsSelect, PHASE_LABEL, PalaceSearch } from "./parts";
import "./product.css";

type ProductRoute = Extract<Route, { page: "product" }>;

// The Product home: the Product owners (one per project of the product, or one for a whole environment), the product
// context of an environment, and the memory search. The tab, the New dialog and the environment the context and
// memory tabs show are all routed (#/product/context?env=…).

type PendingSource = { kind: "url"; url: string } | { kind: "text"; title: string; text: string } | { kind: "file"; file: File };
// What one project is in each task manager, and how its address looks.
const SCOPES = {
    linear: { name: "Linear project", placeholder: "https://linear.app/<workspace>/project/…", pattern: /^https?:\/\/linear\.app\/[^/]+\/project\//, bad: "a Linear project URL" },
    clickup: { name: "ClickUp epic", placeholder: "https://app.clickup.com/t/…", pattern: /^https?:\/\/app\.clickup\.com\/t\//, bad: "a ClickUp task URL" },
    tasksmd: { name: "Tasks.md board", placeholder: "tasksmd:<board folder>", pattern: /^tasksmd:/i, bad: "a Tasks.md board (tasksmd:<board folder>)" },
} as const;

// A new PO: its environment (which fixes the task manager), the project of that task manager, and the sources it
// starts from. The PO is created without its first turn, gets the sources, then starts — so it reads them all.
const NewPoDialog = ({ envs, onClose, onCreated, onError }: { envs: Env[]; onClose: () => void; onCreated: (id: string) => void; onError: (m: string) => void }) => {
    // The environments the PO works for, the first picked is its primary one; all on one task manager.
    const [envIds, setEnvIds] = useState<string[]>(envs[0] ? [envs[0].id] : []);
    // Opened by its URL, the environments are not loaded yet: pick the first when they arrive.
    useEffect(() => { if (envIds.length === 0 && envs[0]) setEnvIds([envs[0].id]); }, [envs, envIds.length]);
    const env = envs.find((e) => e.id === envIds[0]);
    const manager = trackerName(env?.ticket_source ?? "linear");
    const scope = SCOPES[env?.ticket_source ?? "linear"];
    const [url, setUrl] = useState("");
    // "env" = the environment's own PO: no project; it reviews the env's tasks that have no project PO.
    const [kind, setKind] = useState<"project" | "env">("project");
    const [sources, setSources] = useState<PendingSource[]>([]);
    const [srcUrl, setSrcUrl] = useState("");
    const [paste, setPaste] = useState<{ title: string; text: string } | null>(null);
    const [progress, setProgress] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const urlOk = scope.pattern.test(url.trim());
    const create = async () => {
        if (!env) return;
        setProgress(kind === "env" ? "Creating…" : "Reading the project…");
        // A project PO works for every picked environment; an environment PO is one per environment, each with the sources.
        let pos: ProductOwner[];
        try {
            pos = kind === "env" ? await Promise.all(envIds.map((id) => api.createEnvProductOwner([id]))) : [await api.createProductOwner(url.trim(), envIds, false)];
        } catch (e) {
            setProgress(null);
            onError(errText(e));
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
                    failed.push(`${s.kind === "url" ? s.url : s.kind === "text" ? s.title || "pasted text" : s.file.name}: ${errText(e)}`);
                }
            }
            await api.startProductOwner(po.id).catch(() => undefined);
        }
        if (failed.length) onError(`Some sources were not added — add them on the Context tab:\n${failed.join("\n")}`);
        onCreated(pos[0]!.id);
    };
    const label = (s: PendingSource) => (s.kind === "url" ? s.url : s.kind === "text" ? `${s.title || "Pasted text"} (${s.text.length} characters)` : `${s.file.name} (${Math.round(s.file.size / 1024)} KB)`);
    return (
        <Modal
            title="New product owner"
            onClose={() => !progress && onClose()}
            wide
            footer={
                <>
                    <Button disabled={!!progress} onClick={onClose}>Cancel</Button>
                    <Button variant="primary" disabled={!env || (kind === "project" && !urlOk) || !!progress} onClick={() => void create()}>{progress ?? "Create"}</Button>
                </>
            }
        >
            <div className="ev-fields">
                <Field label="Environments" hint="The environments this Product owner works for; the first is its primary one. Only the tasks of these environments get it.">
                    <EnvsSelect envs={envs} value={envIds} switchable onChange={(ids) => { if (envs.find((e) => e.id === ids[0])?.ticket_source !== env?.ticket_source) setUrl(""); setEnvIds(ids); }} />
                </Field>
                <Field label="Scope" hint="A project Product owner plans one project, designs it and splits it into tickets. A whole-environment one has no project: it briefs and reviews every task of the environment that has no project Product owner, from the product context and the environment's memory (one per picked environment).">
                    <div className="po-radios">
                        <Radio name="po-kind" label={`One ${scope.name}`} checked={kind === "project"} onChange={() => setKind("project")} />
                        <Radio name="po-kind" label="Whole environment" checked={kind === "env"} onChange={() => setKind("env")} />
                    </div>
                </Field>
                {kind === "project" && (
                    <Field label={scope.name} hint={`The task manager is ${manager}: the Product owner reads its project and creates tickets only there.`}>
                        <Input value={url} invalid={!!url.trim() && !urlOk} onChange={(e) => setUrl(e.target.value)} placeholder={scope.placeholder} />
                        {url.trim() && !urlOk && <p className="po-error">This is not {scope.bad}.</p>}
                    </Field>
                )}
                <Field label="Sources" hint="Optional. The Product owner reads them in its first turn.">
                    <div className="po-sources">
                        {sources.length > 0 && (
                            <ul className="po-pending">
                                {sources.map((s, i) => (
                                    <li key={i}>
                                        <Chip>{s.kind}</Chip>
                                        <span className="po-pending-label">{label(s)}</span>
                                        <Button size="sm" variant="ghost" onClick={() => setSources((x) => x.filter((_, j) => j !== i))}>Remove</Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="po-row">
                            <Input value={srcUrl} onChange={(e) => setSrcUrl(e.target.value)} aria-label="Source URL" placeholder="Linear issue, ClickUp task, Notion page, Figma link or any web page URL" />
                            <Button disabled={!/^https?:\/\//.test(srcUrl.trim())} onClick={() => { setSources((x) => [...x, { kind: "url", url: srcUrl.trim() }]); setSrcUrl(""); }}>Add URL</Button>
                        </div>
                        <div className="po-row">
                            <Button on={!!paste} onClick={() => setPaste((p) => (p ? null : { title: "", text: "" }))}>Paste text</Button>
                            <Button onClick={() => fileRef.current?.click()}>Upload files</Button>
                            <Input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; setSources((x) => [...x, ...files.map((file) => ({ kind: "file" as const, file }))]); }} />
                        </div>
                        {paste && (
                            <div className="po-paste">
                                <Input value={paste.title} aria-label="Title" onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder="Title (optional)" />
                                <Textarea rows={8} value={paste.text} aria-label="Text" onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste a conversation, notes or any text with context for this project" autoFocus />
                                <div className="po-actions"><Button disabled={!paste.text.trim()} onClick={() => { setSources((x) => [...x, { kind: "text", title: paste.title.trim(), text: paste.text }]); setPaste(null); }}>Add text</Button></div>
                            </div>
                        )}
                    </div>
                </Field>
            </div>
        </Modal>
    );
};

// Which memory wings belong to an environment's memory besides its product wing and its Product owners' (envs.memory_wings).
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
            <Field label="Memory wings" hint="Palace wings that belong to this environment's memory besides its product wing and its Product owners' — e.g. an imported palace's knowledge wings. Comma-separated.">
                <Input value={d.value.wings} aria-label="Memory wings" onChange={(e) => d.patch({ wings: e.target.value })} />
            </Field>
        </EntityForm>
    );
};

const typeOf = (po: ProductOwner): string => (po.scope_kind === "env" ? "Whole environment" : SCOPES[po.source].name);
const stateOf = (po: ProductOwner): string => (po.status === "running" ? "Answering" : po.status === "failed" ? "Failed" : "Idle");

export const ProductHome = ({ route, onOpen, onError }: { route: ProductRoute; onOpen: (id: string) => void; onError: (m: string) => void }) => {
    const [ctx, setCtx] = useState<string | null>(null);
    const [pos, setPos] = useState<ProductOwner[] | null>(null);
    const creating = !!route.create;
    const setCreating = (on: boolean): void => navigate(on ? { page: "product", create: true } : { page: "product" });
    const tab: "owners" | "context" | "memory" = route.home ?? "owners";
    const [envs, setEnvs] = useState<Env[]>([]);
    useEffect(() => { void api.envs().then(setEnvs).catch(() => undefined); }, []);
    const envId = envs.some((e) => e.id === route.env) ? route.env! : envs[0]?.id ?? "";
    const setTab = (t: string): void => navigate(t === "owners" ? { page: "product" } : { page: "product", home: t as "context" | "memory", ...(envId ? { env: envId } : {}) });
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
    const columns: DataColumn<ProductOwner>[] = [
        { key: "name", label: "Name", kind: "label", value: (po) => po.title, filter: false },
        { key: "env", label: "Environments", value: (po) => poEnvIds(po).map(envName).join(", "), filter: "auto" },
        { key: "type", label: "Type", value: typeOf, filter: "auto", defaultHidden: true },
        { key: "phase", label: "Phase", value: (po) => PHASE_LABEL[po.phase], filter: "auto" },
        {
            key: "state",
            label: "State",
            value: stateOf,
            filter: "auto",
            render: (po) => (po.status === "running" ? <Chip tone="info" title={po.status_line ?? undefined}>Answering</Chip> : po.status === "failed" ? <Chip tone="bad" title={po.status_line ?? undefined}>Failed</Chip> : <Chip>Idle</Chip>),
        },
        { key: "tickets", label: "Tickets", kind: "num", hint: "Issues of the project in the task manager", value: (po) => po.tickets ?? 0, filter: false },
        { key: "tasks", label: "Tasks", kind: "num", hint: "Vortex tasks with this Product owner", value: (po) => po.tasks ?? 0, filter: false },
        {
            key: "progress",
            label: "Progress",
            hint: "Issues done ÷ all issues, by their status in the task manager; canceled ones count in neither",
            value: (po) => po.progress ?? -1,
            filter: false,
            render: (po) => (po.progress == null ? <span className="po-muted">—</span> : (
                <span className="po-progress-cell" title={`${po.ticketsDone ?? 0} of ${po.tickets ?? 0} done`}>
                    <progress className="po-progress" value={po.progress} max={100} aria-label="Issues done" />
                    <span>{po.progress}%</span>
                </span>
            )),
        },
    ];
    const env = envs.find((e) => e.id === envId);
    return (
        <div className="po-home">
            <PageHeader
                title="Product"
                actions={tab !== "owners" && envs.length > 0 ? (
                    <label className="po-env-pick"><span>Environment</span>
                        <Select value={envId} onChange={(e) => setEnvId(e.target.value)}>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>
                    </label>
                ) : undefined}
            >
                <Tabs
                    items={[
                        { key: "owners", label: <>Owners{pos ? <Badge>{pos.length}</Badge> : null}</> },
                        { key: "context", label: "Product context" },
                        { key: "memory", label: "Memory" },
                    ]}
                    active={tab}
                    onChange={setTab}
                />
            </PageHeader>
            {creating && <NewPoDialog envs={envs} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); onOpen(id); }} onError={onError} />}
            {tab === "owners" && (pos === null ? <Loading /> : (
                <DataTable
                    embedded
                    title="Product owners"
                    entity="product owner"
                    onCreate={() => setCreating(true)}
                    createDisabled={envs.length ? undefined : "Add an environment first"}
                    columns={columns}
                    rows={pos}
                    rowKey={(po) => po.id}
                    onRowClick={(po) => onOpen(po.id)}
                    storageKey="product-owners"
                    empty={<>No Product owner yet. Use <b>Create new product owner</b> to start one.</>}
                />
            ))}
            {tab === "context" && (
                <Panel>
                    {ctx === null ? <Loading /> : (
                        <EditableMarkdown
                            key={envId}
                            title="Product context"
                            hint="This environment's product: what it is, who uses it, its main areas, its rules. Its Product owners read it."
                            text={ctx}
                            empty="Empty. Describe the product: what it is, who uses it, its main areas, its rules."
                            onError={onError}
                            onSave={async (t) => { await api.setProductContext(envId, t); setCtx(t); }}
                        />
                    )}
                </Panel>
            )}
            {tab === "memory" && (
                <>
                    {env && <Panel><MemoryWings key={envId} env={env} onError={onError} /></Panel>}
                    <Panel title="Search the memory" hint="This environment's product and its Product owners."><PalaceSearch key={envId} env={envId} {...(env ? { envLabel: env.name } : {})} onError={onError} /></Panel>
                </>
            )}
        </div>
    );
};
