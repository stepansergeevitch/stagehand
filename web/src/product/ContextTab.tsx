import { useEffect, useRef, useState } from "react";
import { api, poEnvIds, type Env, type PoArtifact, type PoDetail } from "../api";
import { Markdown } from "../Markdown";
import { Section } from "../components/Panel";
import { Badge, Button, Checkbox, Chip, Input, Notice, Textarea } from "@vortex/ds";
import { EditableMarkdown, EnvsSelect, Nothing, PalaceSearch, errText } from "./parts";

type Props = { d: PoDetail; onError: (m: string) => void; reload: () => void };

// One source the Product owner reads: a line that unfolds to its text or image; Remove is on the line.
const ArtifactRow = ({ poId, a, onRemove }: { poId: string; a: PoArtifact; onRemove: () => void }) => {
    const [text, setText] = useState<string | null>(null);
    const textual = a.mime?.startsWith("text/") || /\.(md|txt|csv|json)$/i.test(a.file);
    const image = (a.mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(a.file);
    const readable = textual ? a.file : a.text_file ?? null;
    return (
        <details className="po-fold po-artifact" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && text === null && readable) void api.poFileText(poId, readable).then(setText).catch(() => setText("(could not read)")); }}>
            <summary>
                <Chip>{a.kind}</Chip>
                <b className="po-fold-text">{a.title}</b>
                {image && <Chip>{a.description ? "Image, described" : "Image, describing…"}</Chip>}
                {a.text_file && <Chip>Text extracted</Chip>}
                {a.source_url && <a href={a.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Source ↗</a>}
                {!textual && <a href={api.poFileUrl(poId, a.file)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open ↗</a>}
                <Button size="sm" variant="ghost" className="po-fold-end" onClick={(e) => { e.preventDefault(); if (confirm(`Remove ${a.title}?`)) onRemove(); }}>Remove</Button>
            </summary>
            {image && (
                <div className="po-image">
                    <img src={api.poFileUrl(poId, a.file)} alt={a.title} />
                    {a.description ? <Markdown source={a.description} /> : <p className="po-muted">The description is on its way.</p>}
                </div>
            )}
            {readable && (text === null ? <p className="po-muted">Loading…</p> : textual ? <div className="po-scroll"><Markdown source={text} /></div> : <pre className="po-doc-text">{text}</pre>)}
        </details>
    );
};

// The environments the PO works for, changed in place; an environment's own PO stays with its environment.
const PoEnvs = ({ d, onSaved, onError }: { d: PoDetail; onSaved: () => void; onError: (m: string) => void }) => {
    const [envs, setEnvs] = useState<Env[]>([]);
    useEffect(() => { void api.envs().then(setEnvs).catch(() => undefined); }, []);
    return (
        <EnvsSelect envs={envs} value={poEnvIds(d.po)} disabled={d.po.scope_kind === "env"} onChange={(ids) => void api.setProductOwnerEnvs(d.po.id, ids).then(onSaved).catch((e: Error) => onError(e.message))} />
    );
};

export const ContextTab = ({ d, onError, reload }: Props) => {
    const [url, setUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [paste, setPaste] = useState<{ title: string; text: string; tell: boolean } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); reload(); } catch (e) { onError(errText(e)); } finally { setBusy(false); } };
    return (
        <div className="po-stack">
            {d.proposal && (
                <Notice tone="warn">
                    <b>The Product owner proposes a new product context.</b> Accepting replaces the product context of every Product owner.
                    <details className="po-fold"><summary>Read the proposal</summary><div className="po-scroll"><Markdown source={d.proposal} /></div></details>
                    <div className="po-actions">
                        <Button variant="primary" disabled={busy} onClick={() => void act(() => api.poAcceptProposal(d.po.id))}>Accept</Button>
                        <Button disabled={busy} onClick={() => void act(() => api.poRejectProposal(d.po.id))}>Reject</Button>
                    </div>
                </Notice>
            )}
            <EditableMarkdown
                title="Project context"
                hint="The Product owner keeps it current; it is filed in its memory after every turn."
                text={d.context}
                empty="Empty — the Product owner writes it in the first turn."
                onError={onError}
                onSave={(t) => api.poSetContext(d.po.id, t).then(reload)}
            />
            <Section title={<>Sources <Badge>{d.artifacts.length}</Badge></>} hint="Everything the Product owner reads: pages, files, pasted notes.">
                <div className="po-row">
                    <Input type="url" aria-label="Source URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Linear project or issue, ClickUp task, Notion page, Figma link, or any web page URL" />
                    <Button disabled={busy || url.trim().length < 8} onClick={() => void act(async () => { await api.poFetch(d.po.id, url.trim()); setUrl(""); })}>{busy ? "Working…" : "Fetch"}</Button>
                    <Button disabled={busy} onClick={() => fileRef.current?.click()}>Upload</Button>
                    <Button disabled={busy} on={!!paste} onClick={() => setPaste((p) => (p ? null : { title: "", text: "", tell: true }))}>Paste text</Button>
                    <Input ref={fileRef} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; void act(async () => { for (const f of files) await api.poUpload(d.po.id, f); }); }} />
                </div>
                {paste && (
                    <div className="po-paste">
                        <Input value={paste.title} aria-label="Title" onChange={(e) => setPaste({ ...paste, title: e.target.value })} placeholder="Title (optional) — e.g. Call with Austin about density" />
                        <Textarea rows={10} value={paste.text} aria-label="Text" onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste a conversation, notes or any text with context for this project" autoFocus />
                        <Checkbox label="Product owner reads it now and updates the context" title={d.running ? "The Product owner is answering; it reads the source in a later turn" : undefined} checked={paste.tell} onChange={(e) => setPaste({ ...paste, tell: e.target.checked })} />
                        <div className="po-actions">
                            <Button variant="primary" disabled={busy || !paste.text.trim()} onClick={() => void act(async () => { await api.poPaste(d.po.id, paste.title, paste.text, paste.tell); setPaste(null); })}>Add source</Button>
                            <Button onClick={() => setPaste(null)}>Cancel</Button>
                        </div>
                    </div>
                )}
                {d.artifacts.length === 0 ? <Nothing title="No sources yet">Fetch a page, upload a file or paste notes for the Product owner to read.</Nothing> : (
                    <div className="po-folds">{d.artifacts.map((a) => <ArtifactRow key={a.id} poId={d.po.id} a={a} onRemove={() => void act(() => api.poRemoveArtifact(d.po.id, a.id))} />)}</div>
                )}
            </Section>
            <Section title="Memory" hint="Search what this Product owner has filed in its memory.">
                <PalaceSearch wing={d.po.slug} onError={onError} />
            </Section>
            <Section title="Environments" hint={d.po.scope_kind === "env" ? "An environment's own Product owner belongs to that one environment." : "The environments this Product owner works for; the first is its primary one."}>
                <div><PoEnvs d={d} onSaved={reload} onError={onError} /></div>
            </Section>
        </div>
    );
};
