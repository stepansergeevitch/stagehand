import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, Icon, Notice } from "@vortex/ds";
import { api, type PoReview, type TaskDetail, type Ticket, type TicketAttachment } from "../api";
import { AgentInput, usePendingFiles } from "../AgentInput";
import { Markdown } from "../Markdown";
import { Panel } from "../components/Panel";
import { fmtBytes, Lightbox, Sub } from "./common";

// The Details tab's ticket part: your instructions for the agents, the Product Owner's brief, and the ticket as fetched.

// Files from the ticket: images inline (tap to inspect), videos playable, anything else a link. The agent sees the
// same files by path in its prompt.
const AttachmentsCard = ({ taskId, items, onZoom }: { taskId: string; items: TicketAttachment[]; onZoom: (z: { src: string; caption: string }) => void }) => (
    <Sub title={`Attachments (${items.length})`}>
        <div className="attachments">
            {items.map((a, i) => {
                const src = a.file ? api.artifactUrl(taskId, a.file) : null;
                const meta = [a.mime, fmtBytes(a.size), a.origin === "attachment" ? null : `from ${a.origin === "comment" ? "a comment" : "the description"}`].filter(Boolean).join(" · ");
                return (
                    <figure key={i} className={`attachment ${a.mime?.startsWith("image/") ? "image" : a.mime?.startsWith("video/") ? "video" : "file"}`}>
                        {src && a.mime?.startsWith("image/") && <img src={src} alt={a.name} title="Click to inspect" onClick={() => onZoom({ src, caption: a.name })} />}
                        {src && a.mime?.startsWith("video/") && <video src={src} controls preload="metadata" />}
                        {src && !a.mime?.startsWith("image/") && !a.mime?.startsWith("video/") && <a className="file-tile" href={src} target="_blank" rel="noreferrer"><Icon name="folder" /> {a.name}</a>}
                        {!src && <div className="file-tile missing"><Icon name="folder" /> {a.name}<span className="field-hint">not downloaded{a.error ? `: ${a.error}` : ""}</span></div>}
                        <figcaption>
                            <span className="name">{src ? <a href={src} target="_blank" rel="noreferrer">{a.name}</a> : a.name}</span>
                            <span className="field-hint">{meta}{a.url && <> · <a href={a.url} target="_blank" rel="noreferrer">source</a></>}</span>
                        </figcaption>
                    </figure>
                );
            })}
        </div>
    </Sub>
);

const TicketCard = ({ taskId, ticket, source }: { taskId: string; ticket: Ticket; source: string }) => {
    const comments = ticket.comments ?? [];
    const attachments = ticket.attachments ?? [];
    const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
    return (
        <Panel
            className="ticket-view"
            title={<>{ticket.id} {ticket.title}</>}
            badge={<>{ticket.status && <Chip>{ticket.status}</Chip>}<Chip>{ticket.source} · {ticket.fetchedVia}</Chip></>}
            actions={ticket.url ? <a href={ticket.url} target="_blank" rel="noreferrer">Open in {source}</a> : undefined}
        >
            {zoom && <Lightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
            {attachments.length > 0 && <AttachmentsCard taskId={taskId} items={attachments} onZoom={setZoom} />}
            {ticket.acceptanceCriteria.length > 0 && (
                <Sub title="Acceptance criteria">
                    <ul className="plain">{ticket.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </Sub>
            )}
            <Sub title="Description">
                {ticket.description.trim() ? <Markdown source={ticket.description} /> : <p className="quiet">No description.</p>}
            </Sub>
            {comments.length > 0 && (
                <Sub title={`Comments (${comments.length})`} open={false}>
                    <div className="gh-comments">
                        {comments.map((c, i) => (
                            <div key={i} className="gh-comment general">
                                <div className="gh-head">
                                    <b>{c.author}</b>
                                    {c.at && <span className="field-hint">{new Date(c.at).toLocaleString()}</span>}
                                </div>
                                <Markdown source={c.body} />
                            </div>
                        ))}
                    </div>
                </Sub>
            )}
            {ticket.parent && (
                <Sub title={<>Parent · {ticket.parent.id} {ticket.parent.title}</>} open={false}>
                    {ticket.parent.description.trim() ? <Markdown source={ticket.parent.description} /> : <p className="quiet">No description.</p>}
                </Sub>
            )}
        </Panel>
    );
};

// The human's own instructions for the task, editable at any time (the next stage run picks the new text up).
export const NotesCard = ({ detail, onSave }: { detail: TaskDetail; onSave: (notes: string, files: File[]) => Promise<void> }) => {
    const [text, setText] = useState(detail.task.notes ?? "");
    const [editing, setEditing] = useState(false);
    const attach = usePendingFiles();
    useEffect(() => setText(detail.task.notes ?? ""), [detail.task.id, detail.task.notes]);
    return (
        <Panel title="Your instructions" hint="Extra context for the agents: constraints, where to look, what to skip. Every stage that runs after you save reads them." badge={detail.task.notes ? <Chip tone="accent">given to every stage</Chip> : <Chip>none</Chip>}>
            {!editing && (detail.task.notes ? <div className="md">{detail.task.notes}</div> : <p className="quiet">No instructions yet.</p>)}
            {editing && <AgentInput value={text} onChange={setText} pending={attach} placeholder="e.g. Only touch the backend; the FE change ships separately. Use the existing BidRepository." />}
            <div className="actions tight">
                {!editing && <Button onClick={() => setEditing(true)}>{detail.task.notes ? "Edit" : "Add instructions"}</Button>}
                {editing && <Button variant="primary" onClick={async () => { await onSave(text, attach.files); attach.clear(); setEditing(false); }}>Save</Button>}
                {editing && <Button onClick={() => { setText(detail.task.notes ?? ""); attach.clear(); setEditing(false); }}>Cancel</Button>}
            </div>
        </Panel>
    );
};

export const TicketView = ({ detail, onFetch }: { detail: TaskDetail; onFetch: () => Promise<void> }) => {
    const { task, ticket } = detail;
    const [state, setState] = useState<"idle" | "fetching" | "failed">("idle");
    const [reason, setReason] = useState<string | null>(null);
    const tried = useRef(false);
    const fetchNow = async () => {
        setState("fetching");
        try {
            await onFetch();
            setState("idle");
        } catch (e) {
            setReason(String((e as Error).message ?? e));
            setState("failed");
        }
    };
    useEffect(() => {
        if (ticket || tried.current) return;
        tried.current = true;
        void fetchNow();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ticket]);
    if (!ticket) {
        const link = task.ticket_url ? <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.ticket_id}</a> : <code>{task.ticket_id}</code>;
        return (
            <Panel title="Ticket">
                {state === "fetching" && <p className="quiet">Fetching {task.ticket_id} from {task.source}…</p>}
                {state !== "fetching" && (
                    <Notice tone="warn">
                        Ticket {link} could not be fetched{reason ? `: ${reason}` : ""}.
                        <div className="actions"><Button size="sm" onClick={() => void fetchNow()}>Fetch again</Button></div>
                    </Notice>
                )}
            </Panel>
        );
    }
    const all = detail.tickets?.length ? detail.tickets : [ticket];
    return (
        <>
            {all.length > 1 && <Notice tone="info">Batch task: {all.length} tickets on one branch, one PR per repository.</Notice>}
            {all.map((t) => <TicketCard key={t.id} taskId={task.id} ticket={{ ...t, url: t.url ?? (t.id === task.ticket_id ? task.ticket_url : null) }} source={task.source} />)}
        </>
    );
};

// The Product Owner's brief on the ticket: written before research, read by the research and design agents.
export const PoBriefCard = ({ task, onError }: { task: TaskDetail["task"]; onError: (m: string) => void }) => {
    const [b, setB] = useState<PoReview | null>(null);
    const load = useCallback(() => void api.poBrief(task.id).then(setB).catch((e: Error) => onError(e.message)), [task.id, onError]);
    useEffect(load, [load, task.updated_at]);
    if (!b) return null;
    return (
        <Panel title="Product owner brief" hint="What to pay attention to beyond the ticket. Research and design read it.">
            {b.status === "failed" && <Notice tone="bad">The brief failed: {b.error}</Notice>}
            {b.text ? <Markdown source={b.text} /> : <p className="quiet">{b.running ? "The Product Owner is writing it…" : "No brief yet. It is written before research starts."}</p>}
            <div className="actions">
                <Button disabled={b.running} onClick={async () => { try { setB(await api.startPoBrief(task.id)); } catch (e) { onError(String((e as Error).message ?? e)); } }}>{b.running ? "Writing…" : b.text ? "Write again" : "Write brief"}</Button>
                {b.at && <span className="field-hint">{b.status} · {new Date(b.at).toLocaleString()}</span>}
            </div>
        </Panel>
    );
};
