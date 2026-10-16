import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Checkbox, Chip, EmptyState, Icon, Notice, Skeleton, Tab, TabList, type Tone } from "@vortex/ds";
import { api, type LineComment, type MessageAnchor, type PoDesignReview, type PoReviewComment, type ProductOwner, type QaPass, type TaskDetail } from "../api";
import { AgentInput } from "../AgentInput";
import { AnnotatedMarkdown } from "../components/AnnotatedMarkdown";
import { threadMessages } from "../components/LineThread";
import { Markdown } from "../Markdown";
import type { DesignSection } from "../routes";
import { QaTests } from "./Qa";
import "./workspace.css";

type Act = (fn: () => Promise<unknown>) => Promise<void>;

// design.md split on its `## ` headings, for the Work tab's summary of the proposal.
export interface MdSection { title: string; body: string }
export const splitSections = (md: string): { intro: string; sections: MdSection[] } => {
    const lines = md.split("\n");
    const sections: MdSection[] = [];
    let intro: string[] = [];
    let cur: MdSection | null = null;
    let fence = false;
    for (const line of lines) {
        if (/^```/.test(line)) fence = !fence;
        const h = !fence ? /^##\s+(.+?)\s*$/.exec(line) : null;
        if (h) {
            if (cur) sections.push(cur);
            cur = { title: h[1]!.replace(/^\d+[.)]\s*/, ""), body: "" };
            continue;
        }
        if (cur) cur.body += `${line}\n`;
        else intro.push(line);
    }
    if (cur) sections.push(cur);
    // Drop the H1 title line from the intro; what remains (if anything) is shown above the tabs.
    intro = intro.filter((l) => !/^#\s/.test(l));
    return { intro: intro.join("\n").trim(), sections };
};

const SEVERITY_TONE: Record<PoReviewComment["severity"], Tone> = { high: "bad", medium: "warn", low: "neutral" };

// One review comment: pick it for the next round, read it, discuss it with the PO.
// `closed`: the review was sent — the card only shows the comment, the note and the discussion.
const PoReviewCommentCard = ({ c, busy, asking, closed = false, onPick, onNote, onAsk }: { c: PoReviewComment; busy: boolean; asking: boolean; closed?: boolean; onPick: (v: boolean) => void; onNote: (note: string | null) => Promise<void>; onAsk: (text: string) => Promise<void> }) => {
    const [open, setOpen] = useState(c.thread.length > 0);
    const [note, setNote] = useState<string | null>(null);
    const [text, setText] = useState("");
    const send = async (): Promise<void> => {
        const t = text.trim();
        if (!t) return;
        setText("");
        await onAsk(t);
    };
    return (
        <div className={`po-comment-card${c.withdrawn ? " withdrawn" : ""}${c.include && !closed ? " picked" : ""}${closed ? " closed" : ""}`}>
            <div className="po-comment-top">
                {!closed && (
                    <Checkbox aria-label="Send this comment in the next design round" title={c.withdrawn ? "The Product Owner withdrew this comment" : "Send this comment in the next design round"} checked={!!c.include && !c.withdrawn} disabled={c.withdrawn || busy} onChange={(e) => onPick(e.target.checked)} />
                )}
                <Chip tone={SEVERITY_TONE[c.severity]}>{c.severity}</Chip>
                <Chip>{c.area}</Chip>
                {c.laterTicket && <Chip tone="accent" title="This task's design makes this later ticket harder; the comment says what to change here">for {c.laterTicket}</Chip>}
                <b>{c.id} · {c.title}</b>
                {c.withdrawn && <Chip>withdrawn</Chip>}

            </div>
            <Markdown source={c.body} />
            {note !== null ? (
                <div className="po-human-note">
                    <AgentInput placeholder="Your note on this comment — it goes to the design agent with it" value={note} onChange={setNote} rows={3} />
                    <div className="actions tight">
                        <Button variant="primary" onClick={() => void onNote(note.trim() || null).then(() => setNote(null))}>Save note</Button>
                        <Button onClick={() => setNote(null)}>Cancel</Button>
                    </div>
                </div>
            ) : c.note ? (
                <div className="po-human-note">
                    <div className="chat-msg-head"><b>Your note</b></div>
                    <Markdown source={c.note} />
                    {!closed && (
                        <div className="actions tight">
                            <Button size="sm" onClick={() => setNote(c.note ?? "")}>Edit</Button>
                            <Button size="sm" variant="danger" onClick={() => void onNote(null)}>Delete</Button>
                        </div>
                    )}
                </div>
            ) : null}
            {!closed && note === null && !c.note && <Button size="sm" onClick={() => setNote("")}>Add note</Button>}{" "}
            {(!closed || c.thread.length > 0) && <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name={open ? "chevronDown" : "chevronRight"} />{closed ? "Discussion" : "Discuss with the Product owner"}{c.thread.length ? ` (${c.thread.length})` : ""}</Button>}
            {open && (
                <div className="line-thread flush">
                    {c.thread.map((m, i) => (
                        <div key={i} className={`thread-msg ${m.role === "po" ? "agent" : "user"}`}>
                            <div className="chat-msg-head"><b>{m.role === "user" ? "You" : "Product Owner"}</b> <span className="field-hint">{new Date(m.at).toLocaleString()}</span></div>
                            {m.role === "po" ? <Markdown source={m.text} /> : <div>{m.text}</div>}
                        </div>
                    ))}
                    {asking && <div className="thread-msg agent pending">The Product Owner is answering…</div>}
                    {!asking && !closed && (
                        <>
                            <AgentInput
                                placeholder="Push back, ask why, or ask what a fix looks like (⌘/Ctrl+Enter sends)"
                                value={text}
                                onChange={setText}
                                rows={2}
                                onKeyDown={(e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                        e.preventDefault();
                                        void send();
                                    }
                                }}
                            />
                            <div className="actions tight">
                                <Button variant="primary" disabled={!text.trim() || busy} title={busy ? "The Product Owner is busy with this review" : undefined} onClick={() => void send()}>Ask</Button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

const PoReviewPanel = ({ task, owner, onPicked, onAction, onError }: { task: TaskDetail["task"]; owner: ProductOwner | null; onPicked: (n: number) => void; onAction: Act; onError: (m: string) => void }) => {
    const [r, setR] = useState<PoDesignReview | null>(null);
    const load = useCallback(() => void api.poReview(task.id).then(setR).catch((e: Error) => onError(e.message)), [task.id, onError]);
    useEffect(load, [load, task.updated_at]);
    // Before the early returns: a hook after them runs on some renders only ("Rendered more hooks than during the previous render").
    useEffect(() => { if (r) onPicked(pickedOf(r)); }, [r, onPicked]);
    if (!owner) return <EmptyState icon="user" title="No Product owner for this task">Pick one under Details, Setup to get a product review of the proposal.</EmptyState>;
    if (!r) return <Skeleton height={64} />;
    const canSend = task.stage === "design_proposal" && task.status === "waiting_user";
    const rev = r.review;
    const picked = rev?.comments.filter((c) => c.include && !c.withdrawn) ?? [];
    const order = { high: 0, medium: 1, low: 2 } as const;
    const comments = [...(rev?.comments ?? [])].sort((a, b) => Number(a.withdrawn) - Number(b.withdrawn) || order[a.severity] - order[b.severity]);
    const reviewing = r.running && !r.asking;
    const call = async (fn: () => Promise<PoDesignReview>) => { try { setR(await fn()); } catch (e) { onError(String((e as Error).message ?? e)); } };
    return (
        <div className="po-review">
            <div className="actions tight">
                <Button variant="primary" disabled={r.running} onClick={() => void call(() => api.startPoReview(task.id))}>{reviewing ? "The Product owner is reviewing…" : rev ? "Review again by the Product owner" : "Review by the Product owner"}</Button>
                <span className="field-hint">{owner.title}{r.at ? ` · ${r.status ?? ""} ${new Date(r.at).toLocaleString()}` : ""}</span>
            </div>
            {r.status === "failed" && <Notice tone="bad">The review failed: {r.error}</Notice>}
            {rev && (
                <>
                    <div className="po-verdict">
                        <Chip tone={rev.verdict === "approve" ? "ok" : "warn"}>{rev.verdict === "approve" ? "approve" : "changes"}</Chip> <b>{rev.summary}</b>
                    </div>
                    {rev.sentAt ? (
                        <>
                            <Notice tone="info">
                                <b>Sent to the agent {new Date(rev.sentAt).toLocaleString()}</b> — {rev.comments.filter((c) => c.sentAt).length} sent, {rev.comments.filter((c) => !c.sentAt).length} skipped. This review is closed; review the new proposal again when it is ready.
                            </Notice>
                            {[["Sent", comments.filter((c) => c.sentAt)], ["Skipped", comments.filter((c) => !c.sentAt)]].map(([label, list]) =>
                                (list as PoReviewComment[]).length ? (
                                    <div key={label as string}>
                                        <h3>{label as string} ({(list as PoReviewComment[]).length})</h3>
                                        {(list as PoReviewComment[]).map((c) => <PoReviewCommentCard key={c.id} c={c} busy asking={false} closed onPick={() => undefined} onNote={async () => undefined} onAsk={async () => undefined} />)}
                                    </div>
                                ) : null,
                            )}
                        </>
                    ) : comments.length === 0 ? <p className="quiet">No comments.</p> : comments.map((c) => (
                        <PoReviewCommentCard
                            key={c.id}
                            c={c}
                            busy={r.running}
                            asking={r.asking === c.id}
                            onPick={(v) => void call(() => api.patchPoReviewComment(task.id, c.id, { include: v }))}
                            onNote={(note) => call(() => api.patchPoReviewComment(task.id, c.id, { note }))}
                            onAsk={(text) => call(() => api.askPoReviewComment(task.id, c.id, text))}
                        />
                    ))}
                    {!rev.sentAt && (
                        <div className="field-hint">
                            {picked.length} picked, {rev.comments.length - picked.length} skipped — {canSend ? "the picked comments go to the agent with Request changes, together with your own comments." : "the proposal must be waiting for your review to send them."}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

// The design tab: the proposal as one document, the QA tests with their baseline, and the Product owner review.
export const DESIGN_DOC = "design.md";
// Unsent, picked, not withdrawn comments of the Product Owner's review: what Request changes takes along.
export const pickedOf = (r: PoDesignReview): number => (r.review && !r.review.sentAt ? r.review.comments.filter((c) => c.include && !c.withdrawn).length : 0);

export const DesignTabs = ({ annot, onPicked, task, owner, design, md, before, section, onSection, onAction, onError }: { annot: { comments: Record<string, LineComment>; threads: ReturnType<typeof threadMessages>; canComment: boolean; canAsk: boolean; onChange: (key: string, c: LineComment | null) => void; onAsk: (anchor: MessageAnchor, text: string, files: File[]) => Promise<void> }; onPicked: (n: number) => void; task: TaskDetail["task"]; owner: ProductOwner | null; design: NonNullable<TaskDetail["design"]>; md: string | null; before: QaPass | null; section?: DesignSection; onSection: (s: DesignSection) => void; onAction: Act; onError: (m: string) => void }) => {
    const active = section ?? "proposal";
    const body = useMemo(() => (md ?? "").replace(/^#\s[^\n]*\n/, ""), [md]);
    return (
        <>
            <TabList variant="pill">
                <Tab active={active === "proposal"} onClick={() => onSection("proposal")}>Proposal</Tab>
                <Tab active={active === "qa"} onClick={() => onSection("qa")}>QA tests <Badge>{design.qa.length}</Badge></Tab>
                <Tab active={active === "po"} onClick={() => onSection("po")}>Product owner review</Tab>
            </TabList>
            <div className="design-section">
                {active === "proposal" ? (md ? <AnnotatedMarkdown source={body} path={DESIGN_DOC} comments={annot.comments} threads={annot.threads} canComment={annot.canComment} canAsk={annot.canAsk} onChange={annot.onChange} onAsk={annot.onAsk} /> : <EmptyState icon="alert" title="design.md is missing" />) : active === "qa" ? <QaTests taskId={task.id} design={design} before={before} /> : <PoReviewPanel task={task} owner={owner} onPicked={onPicked} onAction={onAction} onError={onError} />}
            </div>
        </>
    );
};
