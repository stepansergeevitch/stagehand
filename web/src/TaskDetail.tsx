import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LabelEditor } from "./Labels";
import { BranchPicker } from "./BranchPicker";
import { api, baseLabel, checkOutcome, envRepos, isApprovalGateCheck, labelsOf, parseBaseBranch, parseChecks, pendingQuestions, prRepos, prStateOf, repoColorClass, repoName, STAGE_LABEL, STAGE_ORDER, taskLabel, type Account, type MergeMethod, type PrCheck, type PrDraftEntry, type PrState, type QaChange, type QaPass, type QuestionRound, type Stage, type TaskDetail, type Ticket, type TicketAttachment } from "./api";
import { storage } from "./storage";
import { LazyTerminal } from "./LazyTerminal";
import type { TaskTab, TaskView } from "./routes";
import { Chat } from "./Chat";
import { AgentInput, FileChips, usePendingFiles } from "./AgentInput";
import { Markdown } from "./Markdown";
import { ServicesPanel } from "./Services";
import { TaskCost } from "./TaskCost";
import { DiffView, useDraftComments, type PriorComment } from "./DiffView";
import { anchorOf, type Env, type LineComment, type PoDesignReview, type PoReview, type PoReviewComment, type ProductOwner, type Message, type MessageAnchor, type PrComment, type PrComments, type Review } from "./api";

const isResolved = (c: PrComment): boolean => c.kind === "line" && c.resolved;

// The chat anchor of a thread under a GitHub PR comment: keyed by the comment id, carrying its position and text.
const prCommentAnchor = (c: PrComment, repo: string, number: number): MessageAnchor => ({
    path: c.kind === "line" ? c.path : "",
    side: "new",
    line: c.kind === "line" ? (c.line ?? 0) : 0,
    snippet: c.body.trim().slice(0, 600) || (c.kind === "review" ? `Review: ${c.state.toLowerCase().replace("_", " ")}` : ""),
    prComment: { repo, number, id: c.id, author: c.author, url: c.url },
});

// A collapsible chat with the agent right under one PR comment: its earlier exchanges, a question box, the reply
// arrives through the task's messages (same thread key, see MessageAnchor.prComment).
const PrCommentThread = ({ items, canAsk, onAsk }: { items: Message[]; canAsk: boolean; onAsk: (text: string) => Promise<void> }) => {
    const [open, setOpen] = useState(items.length > 0);
    const [text, setText] = useState("");
    const [asking, setAsking] = useState(false);
    useEffect(() => {
        if (items.length > 0) setOpen(true);
    }, [items.length]);
    const send = async (): Promise<void> => {
        const t = text.trim();
        if (!t) return;
        setAsking(true);
        setText("");
        try {
            await onAsk(t);
        } finally {
            setAsking(false);
        }
    };
    return (
        <div className="pr-thread">
            <button className="tiny" onClick={() => setOpen((o) => !o)} title="Ask the agent about this comment — a chat, nothing is changed">
                {open ? "▾" : "▸"} Ask agent{items.length ? ` (${items.length})` : ""}
            </button>
            {open && (
                <div className="line-thread" style={{ marginLeft: 0 }}>
                    {items.map((msg) => (
                        <div key={msg.id} className={`thread-msg ${msg.role}`}>
                            <div className="chat-msg-head">
                                <b>{msg.role === "user" ? "You" : "Agent"}</b>
                                <span className="field-hint">{new Date(msg.created_at).toLocaleString()}</span>
                            </div>
                            {msg.role === "agent" ? <Markdown source={msg.text} /> : <div>{msg.text}</div>}
                        </div>
                    ))}
                    {asking && <div className="thread-msg agent pending">Agent is answering…</div>}
                    {canAsk && !asking && (
                        <>
                            <AgentInput
                                placeholder="Does this make sense? Is it already addressed? What would a fix take? (⌘/Ctrl+Enter sends)"
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
                            <div className="actions" style={{ marginBottom: 0 }}>
                                <button className="primary" disabled={!text.trim()} onClick={() => void send()}>Ask</button>
                            </div>
                        </>
                    )}
                    {!canAsk && !asking && <div className="field-hint">A run owns the agent's session right now — ask once it is idle.</div>}
                </div>
            )}
        </div>
    );
};

// GitHub PR comments of one kind (human or automation): review verdicts, line comments (path:line), general comments.
// Open ones first (oldest first), resolved threads sink to the bottom; a line comment's thread can be resolved/reopened here.
const PrCommentList = ({ title, items, loading, error, hasPr, url, fetchedAt, onRefresh, selected, onToggle, onResolve, repo, prNumber, threads, canAsk, onAsk }: { title: string; items: PrComment[] | null; loading: boolean; error: string | null; hasPr: boolean; url: string | null; fetchedAt: string | null; onRefresh: () => void; selected: Set<number>; onToggle: (id: number) => void; onResolve: (id: number, resolved: boolean) => Promise<void>; repo: string; prNumber: number | null; threads: Message[]; canAsk: boolean; onAsk: (anchor: MessageAnchor, text: string) => Promise<void> }) => {
    const [busy, setBusy] = useState<number | null>(null);
    const threadOf = (c: PrComment): Message[] => threads.filter((m) => { const a = anchorOf(m)?.prComment; return !!a && a.id === c.id && a.repo === repo; });
    const sorted = items ? [...items].sort((a, b) => Number(isResolved(a)) - Number(isResolved(b)) || a.at.localeCompare(b.at)) : [];
    const resolvedCount = items ? items.filter(isResolved).length : 0;
    return (
        <Card title={title} badge={items ? <span className="chip">{items.length - resolvedCount} open{resolvedCount ? ` · ${resolvedCount} resolved` : ""}</span> : undefined}>
            {!hasPr && <div className="empty">No pull request yet — comments appear here once it exists.</div>}
            {hasPr && (
                <div className="actions" style={{ marginTop: 0 }}>
                    <button onClick={onRefresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
                    {url && <a href={url} target="_blank" rel="noreferrer">open PR ↗</a>}
                    {fetchedAt && <span className="field-hint">fetched {new Date(fetchedAt).toLocaleTimeString()}</span>}
                </div>
            )}
            {error && <div className="blocked-box">{error}</div>}
            {items && items.length === 0 && <div className="empty">nothing here</div>}
            {items && items.length > 0 && (
                <div className="gh-comments">
                    {sorted.map((c, i) => (
                        <Fragment key={`${c.kind}-${c.id}`}>
                            {i > 0 && isResolved(c) && !isResolved(sorted[i - 1]!) && <div className="gh-sep">resolved</div>}
                            <div className={`gh-comment ${c.kind} ${selected.has(c.id) ? "picked" : ""} ${isResolved(c) ? "resolved" : ""}`}>
                                <div className="gh-head">
                                    <label className="inline" title="Pick this comment to send to the agent">
                                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => onToggle(c.id)} />
                                    </label>
                                    <b>{c.author}</b>
                                    {c.kind === "review" && <span className={`chip ${c.state === "APPROVED" ? "ok" : c.state === "CHANGES_REQUESTED" ? "bad" : ""}`}>{c.state.toLowerCase().replace("_", " ")}</span>}
                                    {c.kind === "line" && <code>{c.path}{c.line !== null ? `:${c.line}` : ""}{c.outdated ? " (outdated)" : ""}</code>}
                                    {c.kind === "line" && c.replyTo !== null && <span className="chip">reply</span>}
                                    {c.kind === "line" && (c.resolved ? <span className="chip ok">resolved</span> : <span className="chip wait">open</span>)}
                                    {c.kind === "general" && <span className="chip">comment</span>}
                                    <span className="field-hint">{new Date(c.at).toLocaleString()}</span>
                                    <a href={c.url} target="_blank" rel="noreferrer">↗</a>
                                    {c.kind === "line" && c.threadId && c.replyTo === null && (
                                        <button
                                            className="tiny"
                                            disabled={busy === c.id}
                                            title={c.resolved ? "Reopen this review thread on GitHub" : "Mark this review thread resolved on GitHub (as you)"}
                                            onClick={() => { setBusy(c.id); void onResolve(c.id, !c.resolved).finally(() => setBusy(null)); }}
                                        >
                                            {busy === c.id ? "…" : c.resolved ? "Reopen" : "Resolve"}
                                        </button>
                                    )}
                                </div>
                                {c.body && <Markdown source={c.body} />}
                                {prNumber !== null && <PrCommentThread items={threadOf(c)} canAsk={canAsk} onAsk={(text) => onAsk(prCommentAnchor(c, repo, prNumber), text)} />}
                            </div>
                        </Fragment>
                    ))}
                </div>
            )}
        </Card>
    );
};

const parseComments = (r: Review): LineComment[] => {
    try {
        return r.comments ? (JSON.parse(r.comments) as LineComment[]) : [];
    } catch {
        return [];
    }
};

// Earlier rounds of this stage's review, so the reviewer can check what was asked before.
const ReviewHistory = ({ reviews, stage }: { reviews: Review[]; stage: Stage }) => {
    const rounds = reviews.filter((r) => r.stage === stage && r.verdict === "changes");
    if (rounds.length === 0) return null;
    return (
        <div className="review-history">
            {rounds.map((r, i) => {
                const cs = parseComments(r);
                return (
                    <details key={r.id}>
                        <summary>Round {i + 1} · {new Date(r.created_at).toLocaleString()} · {cs.length} line comment{cs.length === 1 ? "" : "s"}{r.notes ? " · notes" : ""}</summary>
                        {r.notes && <div className="md">{r.notes}</div>}
                        {cs.length > 0 && (
                            <ul className="plain">
                                {cs.map((c, j) => <li key={j}><code>{c.path}:{c.line}</code> {c.text}</li>)}
                            </ul>
                        )}
                    </details>
                );
            })}
        </div>
    );
};

interface Props {
    detail: TaskDetail;
    accounts: Account[];
    env: Env | undefined;
    onError: (m: string) => void;
    feed: string[];
    terminal: string | null;
    onAction: (fn: () => Promise<unknown>) => Promise<void>;
    // What the task view shows (tab, step, section, repository, diff scope) is routed — part of the URL hash — so a
    // reload lands on the same view and a link names it; every view change goes through onView.
    view: TaskView;
    onView: (v: TaskView) => void;
    onOpenTerminal: () => Promise<void>;
    onCloseTerminal: () => void;
}

const useArtifactText = (taskId: string, rel: string, exists: boolean): string | null => {
    const [text, setText] = useState<string | null>(null);
    useEffect(() => {
        if (!exists) return;
        void fetch(api.artifactUrl(taskId, rel)).then((r) => (r.ok ? r.text() : null)).then(setText);
    }, [taskId, rel, exists]);
    return text;
};

const Card = ({ title, badge, children }: { title: React.ReactNode; badge?: React.ReactNode; children: React.ReactNode }) => (
    <section className="card">
        <h2>{title} {badge}</h2>
        {children}
    </section>
);

// A collapsible sub-heading inside a card (open by default).
const Sub = ({ title, open = true, children }: { title: React.ReactNode; open?: boolean; children: React.ReactNode }) => (
    <details className="sub" open={open}>
        <summary><h3>{title}</h3></summary>
        <div className="sub-body">{children}</div>
    </details>
);

// The ticket as it was fetched from ClickUp/Linear: everything Claude was given, unabridged. Without a stored copy the tab
// tries one server-side fetch (REST token only, never an agent run) and otherwise shows a plain message with the link.
const fmtBytes = (n: number | null): string => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`);

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
                        {src && !a.mime?.startsWith("image/") && !a.mime?.startsWith("video/") && <a className="file-tile" href={src} target="_blank" rel="noreferrer">📎 {a.name}</a>}
                        {!src && <div className="file-tile missing">📎 {a.name}<span className="field-hint">not downloaded{a.error ? `: ${a.error}` : ""}</span></div>}
                        <figcaption>
                            <span className="name">{src ? <a href={src} target="_blank" rel="noreferrer">{a.name}</a> : a.name}</span>
                            <span className="field-hint">{meta}{a.url && <> · <a href={a.url} target="_blank" rel="noreferrer">source ↗</a></>}</span>
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
        <section className="card ticket-view">
            {zoom && <Lightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
            <h2>{ticket.id} {ticket.title}</h2>
            <div className="sub">
                {ticket.status && <span className="chip">{ticket.status}</span>}
                <span className="chip">{ticket.source} · {ticket.fetchedVia}</span>
                {ticket.url && <a href={ticket.url} target="_blank" rel="noreferrer">open in {source} ↗</a>}
            </div>
            {attachments.length > 0 && <AttachmentsCard taskId={taskId} items={attachments} onZoom={setZoom} />}
            {ticket.acceptanceCriteria.length > 0 && (
                <Sub title="Acceptance criteria">
                    <ul className="plain">{ticket.acceptanceCriteria.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </Sub>
            )}
            <Sub title="Description">
                {ticket.description.trim() ? <Markdown source={ticket.description} /> : <div className="empty">no description</div>}
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
                    {ticket.parent.description.trim() ? <Markdown source={ticket.parent.description} /> : <div className="empty">no description</div>}
                </Sub>
            )}
        </section>
    );
};

// The human's own instructions for the task, editable at any time (the next stage run picks the new text up).
const NotesCard = ({ detail, onSave }: { detail: TaskDetail; onSave: (notes: string, files: File[]) => Promise<void> }) => {
    const [text, setText] = useState(detail.task.notes ?? "");
    const [editing, setEditing] = useState(false);
    const attach = usePendingFiles();
    useEffect(() => setText(detail.task.notes ?? ""), [detail.task.id, detail.task.notes]);
    return (
        <section className="card">
            <h2>Your instructions {detail.task.notes ? <span className="chip accent">given to every stage</span> : <span className="chip">none</span>}</h2>
            {!editing && (detail.task.notes ? <div className="md">{detail.task.notes}</div> : <div className="quiet">Extra context for the agents: constraints, where to look, what to skip. Applies to every stage that runs after you save.</div>)}
            {editing && <AgentInput value={text} onChange={setText} pending={attach} placeholder="e.g. Only touch the backend; the FE change ships separately. Use the existing BidRepository." />}
            <div className="actions" style={{ marginBottom: 0 }}>
                {!editing && <button onClick={() => setEditing(true)}>{detail.task.notes ? "Edit" : "Add instructions"}</button>}
                {editing && <button className="primary" onClick={async () => { await onSave(text, attach.files); attach.clear(); setEditing(false); }}>Save</button>}
                {editing && <button onClick={() => { setText(detail.task.notes ?? ""); attach.clear(); setEditing(false); }}>Cancel</button>}
            </div>
        </section>
    );
};

const TicketView = ({ detail, onFetch }: { detail: TaskDetail; onFetch: () => Promise<void> }) => {
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
        const link = task.ticket_url ? <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.ticket_id} ↗</a> : <code>{task.ticket_id}</code>;
        return (
            <section className="card">
                <h2>Ticket</h2>
                {state === "fetching" && <p className="quiet">Fetching {task.ticket_id} from {task.source}…</p>}
                {state !== "fetching" && (
                    <div className="blocked-box">
                        Ticket {link} could not be fetched{reason ? `: ${reason}` : ""}.
                        <div className="actions"><button onClick={() => void fetchNow()}>Fetch again</button></div>
                    </div>
                )}
            </section>
        );
    }
    const all = detail.tickets?.length ? detail.tickets : [ticket];
    return (
        <>
            {all.length > 1 && <p className="field-hint">Batch task: {all.length} tickets on one branch, one PR per repository.</p>}
            {all.map((t) => <TicketCard key={t.id} taskId={task.id} ticket={{ ...t, url: t.url ?? (t.id === task.ticket_id ? task.ticket_url : null) }} source={task.source} />)}
        </>
    );
};

// Stages a task can be sent back to with notes (from any non-running state — e.g. after an accidental Approve).
const RETURNABLE: Stage[] = ["design_proposal", "implementation", "user_review", "pr_creation_review"];
const ReturnBox = ({ task, pending, onSend, onClose }: { task: TaskDetail["task"]; pending: LineComment[]; onSend: (stage: Stage, notes: string, withComments: boolean, skipQa: boolean, files: File[]) => Promise<void>; onClose: () => void }) => {
    const idx = STAGE_ORDER.indexOf(task.stage);
    const options = RETURNABLE.filter((s) => STAGE_ORDER.indexOf(s) <= idx);
    const [stage, setStage] = useState<Stage>(options[options.length - 1] ?? "design_proposal");
    const [notes, setNotes] = useState("");
    const [skipQa, setSkipQa] = useState(false);
    const attach = usePendingFiles();
    if (options.length === 0) return null;
    const runs = stage !== "user_review";
    // Returning to a stage before User Review means the QA stages would run again on the way back; offer to skip them once.
    const qaAhead = runs && STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf("user_review");
    return (
        <div className="review-box">
            <b>Send the task back</b> — later stages run again after it.
            <label style={{ display: "block", margin: "6px 0" }}>
                Return to{" "}
                <select value={stage} onChange={(e) => setStage(e.target.value as Stage)}>
                    {options.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}{s === task.stage ? " (current)" : ""}</option>)}
                </select>
                <span className="field-hint">{runs ? `${STAGE_LABEL[stage]} runs again with your notes as reviewer notes.` : "User Review waits for you again; no agent runs."}</span>
            </label>
            <AgentInput placeholder={runs ? "What should change (required)" : "Notes for yourself (optional)"} value={notes} onChange={setNotes} pending={attach} />
            {stage === "implementation" && pending.length > 0 && <div className="field-hint">{pending.length} draft line comment(s) from Code changes go along.</div>}
            {qaAhead && (
                <label className="inline" style={{ display: "block", margin: "6px 0" }}>
                    <input type="checkbox" checked={skipQa} onChange={(e) => setSkipQa(e.target.checked)} /> Skip Manual QA this pass — go straight to User Review after {STAGE_LABEL[stage === "design_proposal" ? "implementation" : stage]} (you QA by hand)
                </label>
            )}
            <div className="actions" style={{ marginBottom: 0 }}>
                <button className="primary" disabled={runs && !notes.trim() && attach.files.length === 0 && !(stage === "implementation" && pending.length > 0)} onClick={() => void onSend(stage, notes, stage === "implementation", qaAhead && skipQa, attach.files)}>Send back to {STAGE_LABEL[stage]}</button>
                <button onClick={onClose}>Cancel</button>
            </div>
        </div>
    );
};

// The agent stopped mid-stage to ask: one answer per question (an option click fills it, free text overrides), then the
// stage resumes in the same session with the answers. Sending with blanks lets the agent decide those itself.
// Files (a screenshot, an export) can go with the answers: pasted or dropped on any answer box, or attached — the agent
// gets them by path together with the answers.
const QuestionsBox = ({ round, onSend }: { round: QuestionRound; onSend: (answers: Record<string, string>, files: File[]) => Promise<void> }) => {
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [sending, setSending] = useState(false);
    const pending = usePendingFiles();
    useEffect(() => setAnswers({}), [round.id]);
    const set = (id: string, text: string) => setAnswers((a) => ({ ...a, [id]: text }));
    const answered = round.questions.filter((q) => answers[q.id]?.trim()).length;
    const send = () => { setSending(true); void onSend(answers, pending.files).then(() => pending.clear()).finally(() => setSending(false)); };
    return (
        <div className="review-box questions-box">
            <b>{STAGE_LABEL[round.stage]} — the agent has {round.questions.length === 1 ? "a question" : `${round.questions.length} questions`} for you.</b>
            <span className="field-hint">It stopped at this point; your answers go back into the same session and the stage continues. Blank answers mean "you decide".</span>
            {round.questions.map((q, i) => (
                <div key={q.id} className="question">
                    <div className="question-text"><span className="chip accent">{i + 1}</span> {q.text}</div>
                    {q.context && <div className="question-context">{q.context}</div>}
                    {q.options.length > 0 && (
                        <div className="question-options">
                            {q.options.map((o) => <button key={o} className={answers[q.id] === o ? "on" : ""} onClick={() => set(q.id, answers[q.id] === o ? "" : o)}>{o}</button>)}
                        </div>
                    )}
                    <AgentInput value={answers[q.id] ?? ""} onChange={(v) => set(q.id, v)} pending={pending} chips="none" placeholder={q.options.length ? "Pick an option above or write your own answer" : "Your answer"} style={{ minHeight: 48 }} />
                </div>
            ))}
            <FileChips pending={pending} disabled={sending} />
            <div className="actions" style={{ marginBottom: 0 }}>
                <button className="primary" disabled={sending || (answered === 0 && pending.files.length === 0)} onClick={send}>{sending ? "Sending…" : `Send answers${answered < round.questions.length ? ` (${answered}/${round.questions.length})` : ""}`}</button>
                <button disabled={sending} onClick={() => { if (confirm("Let the agent decide every unanswered question itself and continue?")) send(); }}>Let the agent decide</button>
            </div>
        </div>
    );
};

// Status lines that ask for a login carry the app URL; make it clickable so a closed automation window is not a dead end.
const Linkified = ({ text }: { text: string }) => {
    const parts = text.split(/(https?:\/\/[^\s)]+)/g);
    return <>{parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : <span key={i}>{p}</span>))}</>;
};

const RERUNNABLE: ReadonlySet<Stage> = new Set(["research", "design_proposal", "qa_baseline", "implementation", "code_review", "manual_qa", "pr_creation_review", "pr_fix"]);
const PR_STAGES: ReadonlySet<Stage> = new Set(["pr_waiting", "pr_fix", "pr_green", "pr_approved", "done"]);

const statusChip = (s: string) => {
    const cls = s === "waiting_user" || s === "blocked" ? "wait" : s === "running" ? "accent" : s === "failed" ? "bad" : s === "done" ? "ok" : s === "rate_limited" ? "warn" : "";
    return <span className={`chip ${cls}`}>{s.replace("_", " ")}</span>;
};

export type Tab = TaskTab;

const elapsed = (fromIso: string | undefined, toIso?: string | undefined): string => {
    if (!fromIso) return "";
    const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
    if (ms < 0) return "";
    const m = Math.floor(ms / 60_000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m >= 1 ? `${m}m ${Math.floor((ms % 60_000) / 1000)}s` : `${Math.floor(ms / 1000)}s`;
};

// Every check GitHub reported for the PR head, with its outcome, a link to its log, and how long a running one has been going.
const ChecksList = ({ checks, compact }: { checks: PrCheck[]; compact?: boolean }) => {
    const [, tick] = useState(0);
    const running = checks.some((c) => checkOutcome(c) === "pending" && c.startedAt);
    useEffect(() => {
        if (!running) return;
        const t = setInterval(() => tick((n) => n + 1), 10_000);
        return () => clearInterval(t);
    }, [running]);
    if (checks.length === 0) return <span className="quiet">none reported yet</span>;
    const order = { fail: 0, pending: 1, cancelled: 2, pass: 3 };
    const sorted = [...checks].sort((a, b) => order[checkOutcome(a)] - order[checkOutcome(b)] || (a.name ?? a.context ?? "").localeCompare(b.name ?? b.context ?? ""));
    return (
        <ul className={`plain checks ${compact ? "compact" : ""}`}>
            {sorted.map((c, i) => {
                const o = checkOutcome(c);
                const gate = isApprovalGateCheck(c);
                const url = c.detailsUrl ?? c.targetUrl;
                const label = c.name ?? c.context ?? "check";
                const st = (c.conclusion ?? c.state ?? c.status ?? "pending").toLowerCase().replace(/_/g, " ");
                return (
                    <li key={i} className={`check ${o} ${gate ? "gate" : ""}`}>
                        <span className={`chip ${gate ? "" : o === "pass" ? "ok" : o === "fail" ? "bad" : o === "cancelled" ? "" : "warn"}`}>{gate ? "manual gate" : o === "pending" ? (c.status === "IN_PROGRESS" || c.startedAt ? "running" : "queued") : st}</span>
                        {url ? <a href={url} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>}
                        {o === "pending" && c.startedAt && <span className="field-hint">{elapsed(c.startedAt)}</span>}
                        {o !== "pending" && c.startedAt && c.completedAt && <span className="field-hint">{elapsed(c.startedAt, c.completedAt)}</span>}
                        {!compact && c.workflowName && c.workflowName !== label && <span className="field-hint">{c.workflowName}</span>}
                    </li>
                );
            })}
        </ul>
    );
};

const MERGE_KEY = "stagehand.mergeMethod";

// A repository's name as a coloured chip — the same colour for the same repo everywhere, so the PR rows, tabs and
// comments of one repository are recognisable at a glance.
const RepoChip = ({ repo, repos }: { repo: string; repos: string[] }) => {
    if (repos.length <= 1 && !repo) return null;
    return <span className={`chip repo-chip ${repoColorClass(repo, repos)}`} title={repo ? `repository ${repo}/` : "repository"}>{repoName(repo)}</span>;
};

const prOutcome = (row: PrState | undefined): { kind: "none" | "manual" | "failed" | "pending" | "approved" | "green" | "merged" | "closed"; text: string; cls: string } => {
    if (!row?.number) return row?.approved_at ? { kind: "manual", text: "approved — not on GitHub yet", cls: "warn" } : { kind: "none", text: "not created yet", cls: "" };
    if (row.merged_at) return { kind: "merged", text: "merged", cls: "ok" };
    if (row.state === "CLOSED") return { kind: "closed", text: "closed", cls: "bad" };
    const gated = parseChecks(row.checks_json).filter((c) => !isApprovalGateCheck(c));
    const failed = gated.filter((c) => checkOutcome(c) === "fail").length;
    const pending = gated.filter((c) => checkOutcome(c) === "pending").length;
    if (failed) return { kind: "failed", text: `${failed} check(s) failing`, cls: "bad" };
    if (pending) return { kind: "pending", text: `${pending} check(s) running`, cls: "warn" };
    if (gated.length === 0 && row.pushed_at && Date.now() - new Date(row.pushed_at).getTime() < 10 * 60_000) return { kind: "pending", text: "waiting for checks to start", cls: "warn" };
    if (row.review_decision === "APPROVED") return { kind: "approved", text: "approved", cls: "ok" };
    return { kind: "green", text: gated.length ? "checks green" : "no checks", cls: "accent" };
};

const MergeControls = ({ task, row, onAction }: { task: TaskDetail["task"]; row: PrState; onAction: Props["onAction"] }) => {
    const [method, setMethod] = useState<MergeMethod>(() => (storage.get(MERGE_KEY) as MergeMethod | null) ?? "squash");
    const [deleteBranch, setDeleteBranch] = useState(true);
    const checks = parseChecks(row.checks_json).filter((c) => !isApprovalGateCheck(c));
    const failing = checks.filter((c) => checkOutcome(c) === "fail").length;
    const pending = checks.filter((c) => checkOutcome(c) === "pending").length;
    const warn = failing ? `${failing} check(s) are failing` : pending ? `${pending} check(s) still running` : row.review_decision === "CHANGES_REQUESTED" ? "a reviewer requested changes" : row.review_decision !== "APPROVED" ? "not approved yet" : null;
    return (
        <span className="merge-controls">
            <select value={method} onChange={(e) => { setMethod(e.target.value as MergeMethod); storage.set(MERGE_KEY, e.target.value); }} title="Merge method">
                <option value="squash">squash</option>
                <option value="merge">merge commit</option>
                <option value="rebase">rebase</option>
            </select>
            <label className="inline" title="Delete the remote branch after merging"><input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> delete branch</label>
            <button
                className="primary"
                disabled={task.status === "running"}
                title={warn ? `Merge anyway — ${warn}` : "Merge the pull request as you"}
                onClick={() => {
                    if (!confirm(`Merge ${repoName(row.repo)} #${row.number} (${method})${deleteBranch ? " and delete the remote branch" : ""}?${warn ? `\n\nNote: ${warn}.` : ""}`)) return;
                    void onAction(() => api.mergePr(task.id, { repo: row.repo, method, deleteBranch }));
                }}
            >
                Merge{warn ? " ⚠" : ""}
            </button>
        </span>
    );
};

// The repository's branch and the base it diffs against / its PR targets, editable in place: one repository's base
// can be moved (e.g. onto the trunk once the parent's PR for that repository merged) at any stage, PR draft or not.
// The stored value is a plain branch (every repository) or a per-repo map; editing one repository keeps the others.
const BaseLine = ({ task, repo, repos, onAction }: { task: TaskDetail["task"]; repo: string; repos: string[]; onAction: Props["onAction"] }) => {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState("");
    const bases = parseBaseBranch(task.base_branch);
    const base = typeof bases === "string" ? bases : bases?.[repo];
    const save = () => {
        const next: Record<string, string> = typeof bases === "string" ? Object.fromEntries(repos.map((r) => [r, bases])) : { ...(bases ?? {}) };
        if (value.trim()) next[repo] = value.trim();
        else delete next[repo];
        void onAction(() => api.patchTask(task.id, { baseBranch: Object.keys(next).length ? next : null })).then(() => setEditing(false));
    };
    return (
        <div className="branch-line field-hint">
            <code className="small">⎇ {task.branch}</code>
            {!editing && <code className="small" title="base branch — the branch this repository diffs against and its PR targets (the env default when none is set)"> → {base ?? "env default"}</code>}
            {!editing && task.status !== "running" && (
                <button className="tiny" title="Change this repository's base branch (then use Rebase onto latest base on the Code changes tab)" onClick={() => { setValue(base ?? ""); setEditing(true); }}>change</button>
            )}
            {editing && (
                <>
                    <BranchPicker envId={task.env_id} repo={repo} value={value} onChange={setValue} placeholder="env default" style={{ maxWidth: 260 }} />
                    <button className="tiny" onClick={save}>Save</button>
                    <button className="tiny" onClick={() => setEditing(false)}>×</button>
                </>
            )}
        </div>
    );
};

// One repository's PR in the header widget: repo chip, state, number, checks summary, merge controls.
// The header stays compact even when a PR has a long checks list: show at most this many, then a "show N more" that
// jumps to the full per-repo view on the Pull request tab.
const HEADER_CHECKS_LIMIT = 5;

const PrRepoRow = ({ detail, repo, repos, onAction, onOpenInTab }: { detail: TaskDetail; repo: string; repos: string[]; onAction: Props["onAction"]; onOpenInTab: (repo: string) => void }) => {
    const { task } = detail;
    const row = prStateOf(detail, repo);
    const o = prOutcome(row);
    const checks = parseChecks(row?.checks_json);
    const gated = checks.filter((c) => !isApprovalGateCheck(c));
    // Cancelled checks don't count toward "N/M passed" (not a failure, but not a pass either) — shown separately.
    const cancelled = gated.filter((c) => checkOutcome(c) === "cancelled").length;
    const countable = gated.length - cancelled;
    const passed = gated.filter((c) => checkOutcome(c) === "pass").length;
    const live = gated.filter((c) => checkOutcome(c) !== "pass" && checkOutcome(c) !== "cancelled");
    const extra = live.length - HEADER_CHECKS_LIMIT;
    return (
        <div className={`pr-repo ${o.kind}`}>
            <div className="widget-body">
                <RepoChip repo={repo} repos={repos} />
                <span className={`chip ${o.cls}`}>{o.text}</span>
                {row?.url && <a href={row.url} target="_blank" rel="noreferrer">#{row.number} ↗</a>}
                {row?.review_decision && row.review_decision !== "APPROVED" && <span className="chip">{row.review_decision.toLowerCase().replace("_", " ")}</span>}
                {gated.length > 0 && <span className="mono small">{passed}/{countable} checks passed{cancelled ? ` (${cancelled} cancelled)` : ""}{checks.length > gated.length ? ` (+${checks.length - gated.length} gates)` : ""}</span>}
                {row?.url && !row.merged_at && row.state !== "CLOSED" && <MergeControls task={task} row={row} onAction={onAction} />}
                {row?.approved_at && !row.number && task.status !== "running" && (
                    <button className="tiny" title="Push this repository's branch and open its PR now (uses the approved draft; needs the env to allow pushes / PR creation, or a PR opened by hand is picked up by branch)" onClick={() => onAction(() => api.createApprovedPrs(task.id))}>Push & open now</button>
                )}
            </div>
            {/* This repository's branch and the base it targets, right under its PR line (grouped per repository). */}
            {task.branch && <BaseLine task={task} repo={repo} repos={repos} onAction={onAction} />}
            {row?.url && !row.merged_at && live.length > 0 && (
                <div className="widget-checks">
                    <ChecksList checks={live.slice(0, HEADER_CHECKS_LIMIT)} compact />
                    {extra > 0 && <button className="tiny" onClick={() => onOpenInTab(repo)}>show {extra} more on the Pull request tab</button>}
                </div>
            )}
        </div>
    );
};

// PR status for the header widget: one row per repository, from the stored PR rows (or the draft's repositories).
const PrWidget = ({ detail, onAction, onOpenInTab }: { detail: TaskDetail; onAction: Props["onAction"]; onOpenInTab: (repo: string) => void }) => {
    const { task, pr } = detail;
    const repos = prRepos(detail);
    const rows = detail.prStates ?? [];
    const [refreshing, setRefreshing] = useState(false);
    const anyOpen = rows.some((r) => r.url && !r.merged_at);
    const lastPoll = rows.map((r) => r.updated_at).sort().pop();
    let placeholder: React.ReactNode = null;
    if (repos.length === 0) {
        if (task.stage === "pr_creation_review") placeholder = <span className="chip wait">{task.status === "waiting_user" ? "drafts ready — review per repository" : "drafting"}</span>;
        else if (PR_STAGES.has(task.stage)) placeholder = <span className="chip warn">not created yet</span>;
        else if (pr) placeholder = <span className="chip">draft</span>;
        else placeholder = <span className="chip">none yet</span>;
    }
    return (
        <section className="card widget">
            <h2>
                Pull request{repos.length > 1 ? "s" : ""}
                {anyOpen && (
                    <button className="tiny" disabled={refreshing} title="Re-read checks, review decisions and comments from GitHub now" onClick={() => { setRefreshing(true); void onAction(() => api.refreshPr(task.id)).finally(() => setRefreshing(false)); }}>
                        {refreshing ? "…" : "↻ refresh"}
                    </button>
                )}
            </h2>
            {placeholder && (
                <div className="widget-body">
                    {placeholder}
                    {PR_STAGES.has(task.stage) && task.status_line && <span className="small">{task.status_line}</span>}
                    {task.branch && <code className="small">⎇ {task.branch}</code>}
                </div>
            )}
            {repos.map((repo) => <PrRepoRow key={repo} detail={detail} repo={repo} repos={repos} onAction={onAction} onOpenInTab={onOpenInTab} />)}
            {repos.length > 0 && (
                <div className="field-hint">
                    {lastPoll ? `last poll ${new Date(lastPoll).toLocaleTimeString()} · ` : ""}polls every 2 min
                </div>
            )}
        </section>
    );
};

export const TaskDetailView = ({ detail, accounts, env, onError, feed, terminal, onAction, view, onView, onOpenTerminal, onCloseTerminal }: Props) => {
    const { task, runs, design, impl, qaBefore, qaAfter, pr, prFix, research } = detail;
    const review = detail.review ?? null;
    const tab = view.tab;
    const setTab = (t: Tab) => onView({ tab: t });
    const tickets = detail.tickets ?? [];
    const qaHistory = detail.qaHistory ?? [];
    const has = (p: string) => detail.artifacts.some((a) => a.path === p);
    const researchMd = useArtifactText(task.id, "research.md", has("research.md"));
    const designMd = useArtifactText(task.id, "design.md", has("design.md"));
    const [notes, setNotes] = useState("");
    const [returning, setReturning] = useState(false);
    const [routeTo, setRouteTo] = useState<"implementation" | "design_proposal">("implementation");
    // User Review only: skip the browser QA stages on the way back this once (the human QA's by hand).
    const [skipQa, setSkipQa] = useState(false);
    const [comments, changeComment, clearComments] = useDraftComments(task.id);
    const pending = Object.entries(comments);
    const canComment = task.status === "waiting_user" && task.stage === "user_review";
    // Product Owners, for the header's picker and the Product owner review tab.
    const [owners, setOwners] = useState<ProductOwner[]>([]);
    useEffect(() => { void api.productOwners().then(setOwners).catch(() => setOwners([])); }, [task.id]);
    // At a PR stage, Code-changes line comments go to a PR-fix round of their own (the box above the diff).
    const canCommentPr = task.status !== "running" && ["pr_waiting", "pr_fix", "pr_green", "pr_approved"].includes(task.stage);
    const [localNotes, setLocalNotes] = useState("");
    const attach = usePendingFiles();
    const currentIdx = STAGE_ORDER.indexOf(task.stage);
    // QA stages that will not run: no browser scenarios in the design, or the human asked to skip QA this pass.
    const skipped = new Set<Stage>(design && design.qa.length === 0 ? ["qa_baseline", "manual_qa"] : task.skip_qa ? ["manual_qa", ...(STAGE_ORDER.indexOf(task.stage) < STAGE_ORDER.indexOf("implementation") ? ["qa_baseline" as Stage] : [])] : []);
    // Waiting on answers to the agent's questions is not a review: the review box stays hidden until they are sent.
    const asking = pendingQuestions(detail);
    const waiting = task.status === "waiting_user" && !asking;
    // GitHub PR comments (humans + automation), loaded when a tab needs them; line comments are also shown inline in the diff.
    const commentsTab: "user" | "pr" | "automation" = view.tab === "comments" ? view.sub ?? "user" : "user";
    const setCommentsTab = (sub: typeof commentsTab) => onView({ tab: "comments", sub, ...(view.tab === "comments" && view.repo ? { repo: view.repo } : {}) });
    const [selectedComments, setSelectedComments] = useState<Set<number>>(new Set());
    const toggleComment = (id: number) => setSelectedComments((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });
    useEffect(() => setSelectedComments(new Set()), [task.id]);
    // Which repository's PR the comments tab looks at (multi-repo tasks have one PR per repository).
    const prdRepos = (detail.prStates ?? []).filter((r) => r.number).map((r) => r.repo);
    const ghRepoRaw = view.tab === "comments" ? view.repo ?? null : null;
    const setGhRepo = (repo: string) => onView({ tab: "comments", sub: commentsTab, repo });
    const ghRepo = ghRepoRaw !== null && prdRepos.includes(ghRepoRaw) ? ghRepoRaw : (prdRepos[0] ?? null);
    const ghRow = ghRepo !== null ? prStateOf(detail, ghRepo) : undefined;
    const [gh, setGh] = useState<PrComments | null>(null);
    const [ghLoading, setGhLoading] = useState(false);
    const [ghError, setGhError] = useState<string | null>(null);
    const loadGh = async () => {
        if (ghRepo === null) return;
        setGhLoading(true);
        setGhError(null);
        try {
            setGh(await api.prComments(task.id, ghRepo));
        } catch (e) {
            setGhError(String((e as Error).message ?? e));
        } finally {
            setGhLoading(false);
        }
    };
    useEffect(() => {
        setGh(null);
        if ((tab === "comments" || tab === "code") && ghRepo !== null) void loadGh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task.id, tab, ghRepo, ghRow?.number]);
    const prior: PriorComment[] = [
        ...detail.reviews
            .filter((r) => r.stage === "user_review" && r.verdict === "changes")
            .flatMap((r, i) => parseComments(r).map((c) => ({ ...c, round: i + 1 }))),
        ...(gh ? [...gh.human, ...gh.automation] : [])
            .filter((c): c is Extract<PrComment, { kind: "line" }> => c.kind === "line" && c.line !== null)
            .map((c) => ({ path: c.path, line: c.line ?? 0, side: c.side, snippet: c.snippet, text: c.body, round: 0, by: c.author, resolved: c.resolved })),
    ];

    // The Work tab's summary of the proposal: the problem, then the approach (a proposal in the older template: its
    // Decision, then its Root cause / Approach).
    const problemMd = useMemo(() => (designMd ? splitSections(designMd).sections.find((s) => /^(problem statement|decision)/i.test(s.title)) ?? null : null), [designMd]);
    const explanation = useMemo(() => (designMd ? splitSections(designMd).sections.find((s) => /^suggested approach/i.test(s.title)) ?? splitSections(designMd).sections.find((s) => /^(root cause|approach)/i.test(s.title)) ?? null : null), [designMd]);

    // Which workflow steps have something to show (or are the current one).
    const stepHasContent = (s: Stage): boolean => {
        switch (s) {
            case "research": return !!research;
            case "design_proposal": return !!design;
            case "qa_baseline": return !!qaBefore;
            case "implementation": return !!impl;
            case "code_review": return !!review;
            case "manual_qa": return !!qaAfter;
            case "user_review": return detail.reviews.some((r) => r.stage === "user_review") || task.stage === "user_review";
            default: return false;
        }
    };
    // PR stages (draft review through merge) live on their own top-level tab now, not as a Work step.
    // The QA baseline is part of the design proposal (it runs inside that stage, and Manual QA shows it next to the
    // after-state), so it is no step of its own.
    const stepKey = (s: Stage): Stage => (s === "qa_baseline" ? "design_proposal" : s);
    const steps = STAGE_ORDER.filter((s, i) => i <= currentIdx && s !== "qa_baseline" && !skipped.has(s) && s !== "pr_creation_review" && !PR_STAGES.has(s) && (stepHasContent(s) || s === stepKey(task.stage)));
    // The Work step shown: the routed one when it is a step of this task, else the current stage.
    const step: Stage = view.tab === "work" && view.step && steps.includes(view.step) ? view.step : stepKey(task.stage);
    const setStep = (s: Stage) => onView({ tab: "work", step: s });
    // Jump to the Pull request tab, optionally focusing one repository (from the header's "show more" or a Work pointer).
    // "Rebase onto latest base" — from the header button and from the Code changes base-drift banner.
    // Every repository by default; `repos` narrows it to the ticked ones (multi-repo envs).
    const startRebase = (repos?: string[]) => {
        const base = baseLabel(task, env) ?? env?.base_branch ?? "the base branch";
        const scope = repos?.length ? ` (${repos.map(repoName).join(", ")} only)` : "";
        if (confirm(`Rebase ${task.branch}${scope} onto the latest base (${base})?\n\nA plain git rebase first; the agent resolves conflicts and re-runs checks only where needed. If the branch is on GitHub and this env allows pushes, Stagehand force-pushes it afterwards (with lease).`)) void onAction(() => api.rebase(task.id, repos));
    };
    const envRepoList = envRepos(env);
    const [rebasePick, setRebasePick] = useState<string[]>([]);
    const prFocusRepo = view.tab === "pr" ? view.repo ?? null : null;
    const setPrFocusRepo = (repo: string) => onView({ tab: "pr", repo });
    const openPrTab = (repo?: string) => onView({ tab: "pr", ...(repo ? { repo } : {}) });

    const reviewBox = waiting && (
        <div className="review-box">
            <b>{STAGE_LABEL[task.stage]} — your call.</b>
            {task.stage === "user_review" && (
                <label style={{ display: "block", margin: "6px 0" }}>
                    On changes, send back to{" "}
                    <select value={routeTo} onChange={(e) => setRouteTo(e.target.value as typeof routeTo)}>
                        <option value="implementation">Implementation</option>
                        <option value="design_proposal">Design Proposal</option>
                    </select>
                </label>
            )}
            {task.stage === "user_review" && (
                <label className="inline" style={{ display: "block", margin: "6px 0" }}>
                    <input type="checkbox" checked={skipQa} onChange={(e) => setSkipQa(e.target.checked)} /> Skip Manual QA this pass — come straight back here after the agent's changes (you QA by hand)
                </label>
            )}
            <AgentInput placeholder={canComment ? "General comments (optional if you left line comments in Code changes)" : "Notes for Claude (required for 'Request changes')"} value={notes} onChange={setNotes} pending={attach} />
            {canComment && pending.length > 0 && (
                <div className="pending-comments">
                    {pending.length} line comment{pending.length === 1 ? "" : "s"} to send:
                    <ul className="plain">
                        {pending.map(([k, c]) => (
                            <li key={k}><code>{c.path}:{c.line}</code>{c.text} <button className="danger" onClick={() => changeComment(k, null)} title="remove">×</button></li>
                        ))}
                    </ul>
                </div>
            )}
            <div className="actions">
                <button
                    className="primary"
                    onClick={() => onAction(async () => { const files = await api.uploadFiles(task.id, attach.files); await api.review(task.id, { verdict: "approve", ...(notes ? { notes } : {}), ...(files.length ? { files } : {}) }); clearComments(); setNotes(""); attach.clear(); })}
                >
                    {task.stage === "pr_fix" ? "Approve & push" : "Approve"}
                </button>
                <button
                    disabled={!notes.trim() && attach.files.length === 0 && !(canComment && pending.length > 0)}
                    onClick={() =>
                        onAction(async () => {
                            const files = await api.uploadFiles(task.id, attach.files);
                            await api.review(task.id, {
                                verdict: "changes",
                                ...(notes.trim() ? { notes } : {}),
                                ...(files.length ? { files } : {}),
                                ...(task.stage === "user_review" ? { routeTo, comments: pending.map(([, c]) => c), ...(skipQa ? { skipQa: true } : {}) } : {}),
                            });
                            clearComments();
                            setNotes("");
                            attach.clear();
                        })
                    }
                >
                    Request changes{canComment && pending.length > 0 ? ` (${pending.length})` : ""}
                </button>
                {task.stage === "user_review" && <button onClick={() => setTab("code")}>Open Code changes to comment on lines</button>}
            </div>
            <ReviewHistory reviews={detail.reviews} stage={task.stage} />
        </div>
    );

    const qaPanel = design && (qaBefore || qaAfter) && (
        <Card title="QA evidence">
            {task.status !== "running" && (
                <div className="actions" style={{ marginTop: 0 }}>
                    <button onClick={() => onAction(() => api.rerun(task.id, "qa_baseline"))}>Re-run QA baseline</button>
                    {currentIdx >= STAGE_ORDER.indexOf("manual_qa") && <button onClick={() => onAction(() => api.rerun(task.id, "manual_qa"))}>Re-run Manual QA</button>}
                </div>
            )}
            {qaHistory.length > 0 && (
                <Sub title={`Earlier automatic fix attempts (${qaHistory.length})`} open={false}>
                    <p className="field-hint">Manual QA failed and was sent straight back to Implementation these times before the current result; the agent saw this same trail so it didn't need to re-run QA to rediscover it.</p>
                    {qaHistory.map(({ attempt, data }) => (
                        <div key={attempt} className="kv" style={{ marginBottom: 8 }}>
                            <b>Attempt {attempt}</b>
                            <span>
                                {!data
                                    ? "(could not read)"
                                    : data.scenarios.filter((s) => s.outcome === "fail").length
                                      ? data.scenarios.filter((s) => s.outcome === "fail").map((s) => `${s.id} — ${s.observation}`).join("; ")
                                      : "no scenario failures recorded"}
                            </span>
                        </div>
                    ))}
                </Sub>
            )}
            <QaChanges taskId={task.id} running={task.status === "running"} onAction={onAction} />
            <QaGallery taskId={task.id} design={design} before={qaBefore} after={qaAfter} />
        </Card>
    );

    const stepPanel = (s: Stage): React.ReactNode => {
        switch (stepKey(s)) {
            case "research":
                return research ? (
                    <Card title="Research" badge={<span className={`chip ${research.classification === "bug" ? "bad" : "accent"}`}>{research.classification}</span>}>
                        <div className="kv"><b>Summary</b><span>{research.summary}</span><b>Branch</b><code>{research.branchName}</code><b>Areas</b><span>{(research.affectedAreas ?? []).join(", ") || "—"}</span></div>
                        {researchMd && <Sub title="research.md" open={false}><Markdown source={researchMd} /></Sub>}
                    </Card>
                ) : <div className="empty">no research yet</div>;
            case "design_proposal":
                return design ? (
                    <Card title="Design proposal" badge={<><span className={`chip ${design.classification === "bug" ? "bad" : "accent"}`}>{design.classification}</span>{(design.affectedRepos ?? []).map((r) => <span key={r} className="chip">{r}</span>)}</>}>
                        {problemMd && <div className="proposed decision"><b>{problemMd.title}</b><Markdown source={problemMd.body.trim()} /></div>}
                        {explanation && <div className="proposed explanation"><b>{explanation.title}</b><Markdown source={explanation.body.trim()} /></div>}
                        <div className="kv">
                            <b>Plan</b><span>{design.plan.length} layer(s): {design.plan.map((p) => p.layer).join(", ")}</span>
                            <b>Tests</b><span>{design.testPlan.reduce((n, t) => n + t.cases.length, 0)} case(s) in {design.testPlan.length} file(s)</span>
                            <b>QA</b><span>{design.qa.length ? `${design.qa.length} scenario(s)` : `none — ${design.qaSkippedReason ?? "no reason given"}`}</span>
                            {design.qa.length > 0 && <><b>Baseline</b><span>{task.stage === "qa_baseline" ? <b>running now</b> : qaBefore ? `ran on ${qaBefore.scenarios.length} scenario(s)` : "not run yet"}</span></>}
                        </div>
                        <div className="actions">
                            <button onClick={() => setTab("design")}>Open the full proposal</button>
                            {design.qa.length > 0 && <button onClick={() => onView({ tab: "design", section: "qa" })}>QA tests and baseline</button>}
                        </div>
                    </Card>
                ) : <div className="empty">no design yet</div>;
            case "qa_baseline":
            case "manual_qa":
                return qaPanel ?? <div className="empty">no QA evidence yet</div>;
            case "code_review":
                return review ? (
                    <Card title="Code review" badge={<><span className={`chip ${review.findings.some((f) => f.status === "open" && (f.severity === "P0" || f.severity === "P1")) ? "bad" : "ok"}`}>{review.findings.filter((f) => f.status === "open").length} open</span><span className="chip">{review.findings.filter((f) => f.status === "fixed").length} fixed</span></>}>
                        <p className="field-hint">{review.summary} — gstack's pre-landing checklist applied by a fresh session; fixed findings are committed on the branch, open ones are yours to judge, suppressed ones are low-confidence and kept for calibration.</p>
                        {(["open", "fixed", "suppressed"] as const).map((st) => {
                            const rows = review.findings.filter((f) => f.status === st);
                            if (!rows.length) return null;
                            return (
                                <Sub key={st} title={`${st === "open" ? "Open" : st === "fixed" ? "Fixed" : "Suppressed (low confidence)"} (${rows.length})`} open={st !== "suppressed"}>
                                    {rows.map((f) => (
                                        <div key={f.id} className="kv" style={{ marginBottom: 10 }}>
                                            <b><span className={`chip ${f.severity === "P0" || f.severity === "P1" ? "bad" : f.severity === "P2" ? "warn" : ""}`}>{f.severity}</span> {f.confidence}/10</b>
                                            <span>
                                                <div><b>{f.title}</b> <code>{f.file}{f.line ? `:${f.line}` : ""}</code>{f.category ? <span className="chip" style={{ marginLeft: 6 }}>{f.category}</span> : null}{f.commit ? <code style={{ marginLeft: 6 }}>{f.commit.slice(0, 7)}</code> : null}</div>
                                                {f.detail && <div style={{ fontSize: 13 }}>{f.detail}</div>}
                                                {f.quote && <pre style={{ fontSize: 12, margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{f.quote}</pre>}
                                            </span>
                                        </div>
                                    ))}
                                </Sub>
                            );
                        })}
                    </Card>
                ) : <div className="empty">no review yet</div>;
            case "implementation":
                return impl ? (
                    // impl.json can be partial while Implementation is still running (the agent writes notes first) — never assume a field.
                    <Card
                        title="Implementation"
                        badge={
                            impl.gates ? (
                                <span className={`chip ${impl.gates.tests && impl.gates.typecheck ? "ok" : "bad"}`}>tests {impl.gates.tests ? "✓" : "✗"} · typecheck {impl.gates.typecheck ? "✓" : "✗"}</span>
                            ) : (
                                <span className="chip wait">in progress</span>
                            )
                        }
                    >
                        <div className="kv">
                            <b>Coverage (new lines)</b><span>{impl.coverageNewLines ?? "—"}%</span>
                            <b>Backend</b><span>{impl.tests?.backend ?? "—"}</span>
                            <b>Frontend</b><span>{impl.tests?.frontend ?? "—"}</span>
                            <b>Files</b><span>{(impl.files ?? []).map((f) => <code key={f} style={{ marginRight: 8 }}>{f}</code>)}</span>
                            <b>Commits</b><span>{impl.commits?.length ? impl.commits.map((c) => <div key={c}><code>{c}</code></div>) : "none (uncommitted changes)"}</span>
                        </div>
                        {impl.notes && <Sub title="Notes from the implementer" open={false}><Markdown source={impl.notes} /></Sub>}
                        <div className="actions"><button onClick={() => setTab("code")}>Open Code changes</button></div>
                    </Card>
                ) : <div className="empty">no implementation yet</div>;
            case "user_review":
                return (
                    <>
                        {task.stage === "user_review" ? reviewBox : <Card title="User Review"><ReviewHistory reviews={detail.reviews} stage="user_review" /><div className="actions"><button onClick={() => setTab("comments")}>PR comments</button></div></Card>}
                    </>
                );
            case "pr_creation_review":
            case "pr_waiting":
            case "pr_fix":
            case "pr_green":
            case "pr_approved":
            case "done":
                // Draft review through merge now lives on its own top-level tab, not here.
                return (
                    <Card title="Pull request">
                        <p>{STAGE_LABEL[task.stage]} — tracked on the <button className="tiny" onClick={() => openPrTab()}>Pull request tab</button>.</p>
                    </Card>
                );
            default:
                return null;
        }
    };

    return (
        <>
            <h1>{taskLabel(task)} {task.title ?? ""}</h1>
            <div className="sub">
                {statusChip(task.status)}
                <LabelEditor labels={labelsOf(task)} onChange={(next) => onAction(() => api.patchTask(task.id, { labels: next }))} />
                <span>{STAGE_LABEL[task.stage]}</span>
                {task.ticket_url ? <a href={task.ticket_url} target="_blank" rel="noreferrer">{task.source} ↗</a> : <span>{task.source}</span>}
                {task.model && <span className="chip">{task.model}</span>}
                <span>session {task.session_id.slice(0, 8)}</span>
                {owners.length > 0 && (
                    <label title="The Product Owner whose project this ticket belongs to: it can review the design proposal">
                        product owner{" "}
                        <select value={task.product_owner_id ?? ""} onChange={(e) => onAction(() => api.setTaskProductOwner(task.id, e.target.value || null))}>
                            <option value="">none</option>
                            {owners.filter((o) => o.env_id === task.env_id).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                        </select>
                    </label>
                )}
                <label>
                    account{" "}
                    <select value={task.account_id ?? ""} onChange={(e) => onAction(() => api.setAccount(task.id, e.target.value))}>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                </label>
            </div>
            <div className="actions">
                {task.status === "running" && <button className="danger" onClick={() => onAction(() => api.stop(task.id))}>Stop</button>}
                {(task.status === "failed" || task.status === "stopped" || task.status === "blocked") && (
                    <button className="primary" onClick={() => onAction(() => api.retry(task.id))}>{task.status === "blocked" ? "Re-run stage" : "Retry stage"}</button>
                )}
                {task.stage === "manual_qa" && task.status !== "running" && (
                    <button title="Go on to User Review without this Manual QA pass (no after-state evidence) — for a pass stuck on the environment; you QA by hand there" onClick={() => onAction(() => api.skipManualQa(task.id))}>
                        Skip Manual QA
                    </button>
                )}
                <button onClick={() => onAction(() => api.pin(task.id))}>{task.pinned ? "Unpin" : "Pin"}</button>
                {terminal ? <button onClick={onCloseTerminal}>Close terminal</button> : <button disabled={task.status === "running"} onClick={onOpenTerminal}>Open terminal</button>}
                {task.status !== "running" && currentIdx > 0 && <button onClick={() => setReturning((v) => !v)} title="Send the task back to an earlier stage with notes (e.g. after an accidental Approve)">{returning ? "Cancel return" : "Return to a stage…"}</button>}
                {task.status !== "running" && task.branch && task.worktree_path && (
                    <span className="rebase-group">
                        <button
                            title="Every repository: a plain git rebase of this task's own commits onto the latest base first (seconds); the task's agent takes over only where that conflicts. If the branch is on GitHub and this env allows pushes, Stagehand then force-pushes it with lease, the PR checks restart, and tasks stacked on this branch are rebased in turn"
                            onClick={() => startRebase()}
                        >
                            Rebase onto latest base
                        </button>
                        {envRepoList.length > 1 && (
                            <details className="rebase-pick">
                                <summary title="Rebase only some repositories">▾</summary>
                                <div className="rebase-pick-menu">
                                    {envRepoList.map((r) => (
                                        <label key={r} className="inline">
                                            <input type="checkbox" checked={rebasePick.includes(r)} onChange={(e) => setRebasePick((p) => (e.target.checked ? [...p, r] : p.filter((x) => x !== r)))} /> {repoName(r)}
                                        </label>
                                    ))}
                                    <button className="tiny" disabled={rebasePick.length === 0} onClick={() => startRebase(rebasePick)}>Rebase {rebasePick.length ? rebasePick.map(repoName).join(" + ") : "selected"}</button>
                                </div>
                            </details>
                        )}
                    </span>
                )}
                {task.status !== "running" && task.worktree_path && (
                    <button
                        title="Stop BE/FE, close their Chrome tabs, run the env's cleanup command, remove the worktree and local branch; the task and its history stay"
                        onClick={() => {
                            if (!confirm(`Clean up ${task.ticket_id}? BE/FE stop, the worktree and local branch ${task.branch ?? ""} are removed. Pushed commits and the PR are untouched.`)) return;
                            void onAction(async () => {
                                try {
                                    await api.cleanup(task.id);
                                } catch (e) {
                                    const msg = String((e as Error).message ?? e);
                                    if (/nowhere else/.test(msg) && confirm(`${msg}\n\nDiscard them and clean up anyway?`)) await api.cleanup(task.id, true);
                                    else throw e;
                                }
                            });
                        }}
                    >
                        Clean up
                    </button>
                )}
                {task.status !== "running" && (
                    <button
                        className="danger"
                        title="Stop BE/FE, close their Chrome tabs, run the env's cleanup command, remove the worktree/branch, then forget this task"
                        onClick={() => {
                            if (!confirm(`Delete task ${task.ticket_id}? This cleans up (BE/FE, Chrome tabs, worktree, local branch) the same way "Clean up" does, then removes the task itself. The PR (if any) stays on GitHub.`)) return;
                            void onAction(async () => {
                                try {
                                    await api.deleteTask(task.id);
                                } catch (e) {
                                    const msg = String((e as Error).message ?? e);
                                    if (/nowhere else/.test(msg) && confirm(`${msg}\n\nDiscard them and delete anyway?`)) await api.deleteTask(task.id, false, true);
                                    else throw e;
                                }
                            });
                        }}
                    >
                        Delete
                    </button>
                )}
            </div>
            {returning && (
                <ReturnBox
                    task={task}
                    pending={pending.map(([, c]) => c)}
                    onClose={() => setReturning(false)}
                    onSend={async (stage, text, withComments, skipQa, fileList) => {
                        await onAction(async () => {
                            const files = await api.uploadFiles(task.id, fileList);
                            await api.returnTo(task.id, { stage, ...(text.trim() ? { notes: text } : {}), ...(files.length ? { files } : {}), ...(withComments ? { comments: pending.map(([, c]) => c) } : {}), ...(skipQa ? { skipQa: true } : {}) });
                            if (withComments) clearComments();
                        });
                        setReturning(false);
                    }}
                />
            )}

            <div className="widgets">
                {task.worktree_path ? (
                    <section className="card widget">
                        <h2>App</h2>
                        <ServicesPanel taskId={task.id} env={env} busy={task.status === "running"} onError={onError} onFixStarted={() => void onAction(async () => undefined)} />
                    </section>
                ) : (
                    <section className="card widget"><h2>App</h2><div className="empty">no worktree yet</div></section>
                )}
                <PrWidget detail={detail} onAction={onAction} onOpenInTab={openPrTab} />
            </div>

            <div className="timeline">
                {STAGE_ORDER.map((s, i) => {
                    const runnable = RERUNNABLE.has(s) && i <= currentIdx && task.status !== "running" && !skipped.has(s);
                    return (
                        <span key={s} className={`stage ${i < currentIdx ? "past" : i === currentIdx ? "current" : ""} ${skipped.has(s) ? "skipped" : ""}`}>
                            {STAGE_LABEL[s]}
                            {runnable && (
                                <button
                                    className="rerun"
                                    title={`Re-run ${STAGE_LABEL[s]} (archives its previous output)`}
                                    onClick={() => { if (confirm(`Re-run ${STAGE_LABEL[s]}? Later stages will run again after it.`)) void onAction(() => api.rerun(task.id, s)); }}
                                >
                                    ↻
                                </button>
                            )}
                        </span>
                    );
                })}
            </div>

            {detail.onBase && (
                <div className="review-box">
                    <b>The worktree is on base code for the QA baseline.</b> The baseline records what the app does without this change, so the branch (with its uncommitted work stashed and its migrations rolled back) is switched out for the pass. Code changes and the dev servers show the base until it ends; then the branch, its stash and its migrations come back.
                </div>
            )}
            {asking && task.status === "waiting_user" && (
                <QuestionsBox round={asking} onSend={(answers, files) => onAction(async () => api.answerQuestions(task.id, asking.id, answers, await api.uploadFiles(task.id, files)))} />
            )}
            {task.status === "blocked" && (
                <div className="blocked-box">
                    <b>Blocked.</b> <Linkified text={task.status_line ?? ""} />
                    {(() => {
                        const failing = (detail.prStates ?? []).filter((r) => r.number && parseChecks(r.checks_json).some((c) => !isApprovalGateCheck(c) && checkOutcome(c) === "fail"));
                        return failing.length > 0 ? (
                            <div className="actions" style={{ marginBottom: 0 }}>
                                {failing.map((r) => <button key={r.repo} className="primary" onClick={() => onAction(() => api.fixCi(task.id, r.repo))}>Fix CI{failing.length > 1 || r.repo ? ` on ${repoName(r.repo)}` : ""}</button>)}
                                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>The agent proposes a fix and commits it locally — nothing is pushed until you review the diff and approve.</span>
                            </div>
                        ) : null;
                    })()}
                    {/log ?in/i.test(task.status_line ?? "") && !/waiting for you/.test(task.status_line ?? "") && (
                        <div className="actions" style={{ marginBottom: 0 }}>
                            <button className="primary" onClick={() => onAction(() => api.qaLogin(task.id))}>Log in for QA</button>
                            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Opens the app in the QA Chrome profile; you log in there, Stagehand watches the tab (and moves an Auth0 return from localhost:3000 to the app's port), then re-runs the stage. No agent, no cost.</span>
                        </div>
                    )}
                    {/Relaunch Chrome for QA/.test(task.status_line ?? "") && (
                        <div className="actions" style={{ marginBottom: 0 }}>
                            <button className="primary" onClick={() => onAction(() => api.relaunchChrome(task.id))}>Relaunch Chrome for QA</button>
                            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Quits Chrome and reopens it with the switches that keep a covered window rendering (your tabs restore), then retries this stage. Needed once per Chrome start.</span>
                        </div>
                    )}
                </div>
            )}
            {task.status === "rate_limited" && (
                <div className="blocked-box">
                    <b>Rate limited.</b> {task.status_line}
                    {(() => {
                        const at = [...runs].reverse().find((r) => r.resume_at)?.resume_at;
                        if (!at) return null;
                        const ms = new Date(at).getTime() - Date.now();
                        const local = new Date(at).toLocaleString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
                        return <span className="chip warn" style={{ marginLeft: 8 }}>{ms > 0 ? `auto-resume at ${local} (in ${Math.ceil(ms / 60000)} min)` : "resuming…"}</span>;
                    })()}
                </div>
            )}

            <div className="tabs" role="tablist">
                {([
                    ["work", "Work"],
                    ["runs", `Runs (${runs.length})`],
                    ["design", "Design proposal"],
                    ["code", `Code changes${pending.length ? ` (${pending.length} 💬)` : ""}`],
                    ["pr", `Pull request${prRepos(detail).length > 1 ? "s" : ""}`],
                    ["comments", `PR comments${prior.length || pending.length ? ` (${prior.length + pending.length})` : ""}`],
                    ["chat", `Chat${detail.messages?.length ? ` (${detail.messages.length})` : ""}`],
                    ["ticket", `Ticket${tickets.length > 1 ? `s (${tickets.length})` : ""}${task.notes ? " · notes" : ""}`],
                    ["cost", "Cost"],
                ] as Array<[Tab, string]>).map(([t, label]) => (
                    <button key={t} role="tab" className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{label}</button>
                ))}
            </div>

            {tab === "work" && (
                <>
                    <div className="subtabs">
                        {steps.map((s) => (
                            <button key={s} className={stepKey(step) === stepKey(s) ? "active" : ""} onClick={() => setStep(s)}>
                                {PR_STAGES.has(s) ? "Pull request" : STAGE_LABEL[s]}{s === stepKey(task.stage) ? " ·" : ""}
                            </button>
                        ))}
                    </div>
                    {task.status === "running" && stepKey(step) === stepKey(task.stage) && (
                        <Card title="Live">
                            <div className="feed">{feed.length === 0 ? <div className="k">waiting for events…</div> : feed.slice(-40).map((l, i) => <div key={i}>{l}</div>)}</div>
                        </Card>
                    )}
                    {waiting && stepKey(step) !== stepKey(task.stage) && task.stage !== "pr_creation_review" && task.stage !== "pr_fix" && task.stage !== "user_review" && reviewBox}
                    {stepPanel(step)}
                    {terminal && (
                        <Card title={<>Terminal <code>{terminal}</code></>}>
                            <LazyTerminal session={terminal} />
                        </Card>
                    )}
                </>
            )}

            {tab === "runs" && (
                <Card title="Runs">
                    <div className="runs">
                        {runs.length === 0 && <div className="empty">none yet</div>}
                        {[...runs].reverse().map((r) => (
                            <div className="run" key={r.id}>
                                <span>{STAGE_LABEL[r.stage]} <small style={{ color: "var(--ink-3)" }}>#{r.attempt}</small>{r.shard && <span className="chip" title="one shard of a QA pass that ran its scenarios in parallel">{r.shard}</span>}</span>
                                {statusChip(r.status)}
                                <span className={r.error ? "err" : ""}>{r.error ?? r.last_event ?? ""}</span>
                                <span className="mono" style={{ color: "var(--ink-3)" }}>{r.model ? `${r.model} · ` : ""}{r.num_turns ? `${r.num_turns} turns` : ""}{r.cost_usd ? ` · $${r.cost_usd.toFixed(2)}` : ""}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            )}

            {tab === "design" && (
                design ? (
                    <Card title="Design proposal" badge={<><span className={`chip ${design.classification === "bug" ? "bad" : "accent"}`}>{design.classification}</span>{(design.affectedRepos ?? []).map((r) => <span key={r} className="chip">{r}</span>)}</>}>
                        {task.stage === "design_proposal" && reviewBox}
                        <DesignTabs task={task} owner={owners.find((o) => o.id === task.product_owner_id) ?? null} design={design} md={designMd} before={qaBefore} section={view.tab === "design" ? view.section : undefined} onSection={(s) => onView({ tab: "design", section: s })} onAction={onAction} onError={onError} />
                    </Card>
                ) : <div className="empty">No design proposal yet.</div>
            )}

            {tab === "code" && (
                task.branch && task.worktree_path ? (
                    <Card title="Code changes" badge={pending.length > 0 ? <span className="chip wait">{pending.length} 💬</span> : undefined}>
                        <p className="field-hint">
                            {canComment ? "Tap a line to leave a review comment (sent from the PR comments tab or the review box), or ask the agent about it" : canCommentPr ? "Tap a line to leave a comment for the agent to address in a PR-fix round (nothing is posted to GitHub), or ask the agent about it" : "Tap a line to ask the agent about it"}
                            {task.status === "running" ? " — questions wait until the current run is over." : " — the answer appears under the line and in Chat."}
                        </p>
                        {canCommentPr && pending.length > 0 && (
                            <div className="review-box" style={{ marginBottom: 10 }}>
                                <b>{pending.length} line comment{pending.length === 1 ? "" : "s"} for the agent.</b> It addresses them, commits locally, and you review the diff before it's pushed.
                                <ul className="plain">{pending.map(([k, c]) => <li key={k}><code>{c.path}:{c.line}</code>{c.text} <button className="danger" onClick={() => changeComment(k, null)} title="remove">×</button></li>)}</ul>
                                <AgentInput placeholder="General notes (optional)" value={localNotes} onChange={setLocalNotes} />
                                <div className="actions" style={{ marginBottom: 0 }}>
                                    <button
                                        className="primary"
                                        onClick={() => void onAction(async () => { await api.fixLocalComments(task.id, { ...(localNotes.trim() ? { notes: localNotes } : {}), comments: pending.map(([, c]) => c) }); clearComments(); setLocalNotes(""); })}
                                    >
                                        Ask agent to address {pending.length} comment{pending.length === 1 ? "" : "s"}
                                    </button>
                                </div>
                            </div>
                        )}
                        <DiffView
                            taskId={task.id}
                            refreshKey={task.updated_at}
                            view={{ ...(view.tab === "code" && view.repo ? { repo: view.repo } : {}), ...(view.tab === "code" && view.scope ? { filter: view.scope } : {}) }}
                            onView={(v) => onView({ tab: "code", ...(v.repo ? { repo: v.repo } : {}), ...(v.filter.kind !== "all" ? { scope: v.filter } : {}) })}
                            comments={comments}
                            prior={prior}
                            canComment={canComment || canCommentPr}
                            onChange={changeComment}
                            repos={envRepos(env)}
                            taskBusy={task.status === "running"}
                            onError={onError}
                            threads={(detail.messages ?? []).filter((m) => m.anchor && !anchorOf(m)?.prComment)}
                            canAsk={task.status !== "running"}
                            onAsk={(anchor, text, files) => onAction(async () => api.sendMessage(task.id, text, anchor, await api.uploadFiles(task.id, files)))}
                            onRebase={task.branch ? startRebase : undefined}
                        />
                    </Card>
                ) : <div className="empty">No branch yet.</div>
            )}

            {tab === "pr" && (
                <>
                    {task.stage === "pr_creation_review" ? (
                        <PrDraftTabs detail={detail} onAction={onAction} focusRepo={prFocusRepo} onFocusRepo={setPrFocusRepo} />
                    ) : (
                        <>
                            {task.stage === "pr_fix" && reviewBox}
                            {task.stage === "pr_fix" && prFix?.summary && <Card title="Proposed fix"><Markdown source={prFix.summary} /><div className="actions"><button onClick={() => setTab("code")}>Open Code changes to review the diff</button></div></Card>}
                            <PrPanel detail={detail} onAction={onAction} focusRepo={prFocusRepo} onFocusRepo={setPrFocusRepo} />
                            {/* A repository whose draft was never approved (the task moved on when another repository's PR opened): still reviewable here. */}
                            {(pr?.drafts ?? []).some((d) => !prStateOf(detail, d.repo)?.number) && (
                                <>
                                    <div className="blocked-box"><b>A pull request is still to be opened.</b> Review and approve the remaining draft below; the task's other PR{prRepos(detail).length > 2 ? "s are" : " is"} unaffected.</div>
                                    <PrDraftTabs detail={detail} onAction={onAction} focusRepo={(pr?.drafts ?? []).find((d) => !prStateOf(detail, d.repo)?.number)?.repo ?? null} />
                                </>
                            )}
                        </>
                    )}
                </>
            )}

            {tab === "comments" && (
                <>
                    {prdRepos.length > 1 && (
                        <div className="subtabs pr-repo-tabs">
                            {prdRepos.map((r) => <button key={r} className={`${ghRepo === r ? "active" : ""} repo-${repoColorClass(r, prdRepos)}`} onClick={() => setGhRepo(r)}>{repoName(r)} <span className="chip">#{prStateOf(detail, r)?.number}</span></button>)}
                        </div>
                    )}
                    <div className="subtabs">
                        <button className={commentsTab === "user" ? "active" : ""} onClick={() => setCommentsTab("user")}>Human · User comments</button>
                        <button className={commentsTab === "pr" ? "active" : ""} onClick={() => setCommentsTab("pr")}>Human · PR comments{gh ? ` (${gh.human.length})` : ""}</button>
                        <button className={commentsTab === "automation" ? "active" : ""} onClick={() => setCommentsTab("automation")}>Automation comments{gh ? ` (${gh.automation.length})` : ""}</button>
                    </div>
                    {commentsTab === "user" && (
                        task.stage === "user_review" && waiting ? reviewBox : (
                            <Card title="Your comments before the PR">
                                {pending.length > 0 && (
                                    <div className="pending-comments">
                                        Draft line comments ({canCommentPr ? "sent from the box on Code changes" : "sent with the next \"Request changes\" in User Review"}):
                                        <ul className="plain">{pending.map(([k, c]) => <li key={k}><code>{c.path}:{c.line}</code>{c.text} <button className="danger" onClick={() => changeComment(k, null)} title="remove">×</button></li>)}</ul>
                                    </div>
                                )}
                                <ReviewHistory reviews={detail.reviews} stage="user_review" />
                                {!detail.reviews.some((r) => r.stage === "user_review") && pending.length === 0 && <div className="empty">No review comments yet.</div>}
                            </Card>
                        )
                    )}
                    {commentsTab !== "user" && (
                        <>
                            {selectedComments.size > 0 && (
                                <div className="review-box" style={{ marginBottom: 10 }}>
                                    <b>{selectedComments.size} comment(s) picked.</b> The agent addresses just these, commits locally, and you review the diff before it's pushed — no re-run of QA or User Review. To only ask what it thinks of a comment, use "Ask agent" under that comment.
                                    <div className="actions" style={{ marginBottom: 0 }}>
                                        <button
                                            className="primary"
                                            disabled={task.status === "running"}
                                            onClick={() => void onAction(async () => { await api.fixComments(task.id, ghRepo ?? "", [...selectedComments]); setSelectedComments(new Set()); })}
                                        >
                                            Ask agent to address {selectedComments.size} comment(s)
                                        </button>
                                        <button onClick={() => setSelectedComments(new Set())}>Clear selection</button>
                                    </div>
                                </div>
                            )}
                            <PrCommentList
                                title={`${commentsTab === "pr" ? "Comments" : "Automation comments"} on the ${ghRepo ? repoName(ghRepo) : ""} pull request`}
                                items={gh ? (commentsTab === "pr" ? gh.human : gh.automation) : null}
                                loading={ghLoading}
                                error={ghError}
                                hasPr={!!ghRow?.url}
                                url={ghRow?.url ?? null}
                                fetchedAt={gh?.fetchedAt ?? null}
                                onRefresh={() => void loadGh()}
                                selected={selectedComments}
                                onToggle={toggleComment}
                                repo={ghRepo ?? ""}
                                prNumber={gh?.number ?? null}
                                threads={(detail.messages ?? []).filter((m) => !!anchorOf(m)?.prComment)}
                                canAsk={task.status !== "running"}
                                onAsk={(anchor, text) => onAction(async () => { await api.sendMessage(task.id, text, anchor); })}
                                onResolve={async (id, resolved) => {
                                    try {
                                        const next = await api.resolvePrComment(task.id, ghRepo ?? "", id, resolved);
                                        if (next) setGh(next);
                                    } catch (e) {
                                        onError(String((e as Error).message ?? e));
                                    }
                                }}
                            />
                        </>
                    )}
                </>
            )}

            {tab === "chat" && <Chat taskId={task.id} messages={detail.messages ?? []} status={task.status} onSent={async () => onAction(async () => undefined)} onOpenCode={() => setTab("code")} />}

            {tab === "ticket" && (
                <>
                    <NotesCard detail={detail} onSave={(text, files) => onAction(async () => api.patchTask(task.id, { notes: text.trim() || null, files: await api.uploadFiles(task.id, files) }))} />
                    {task.product_owner_id && <PoBriefCard task={task} onError={(m) => void onAction(async () => { throw new Error(m); })} />}
                    <TicketView detail={detail} onFetch={async () => { await api.fetchTicket(task.id); await onAction(async () => undefined); }} />
                </>
            )}
            {tab === "cost" && <TaskCost taskId={task.id} refreshKey={task.updated_at} />}
        </>
    );
};

// One repository's drafted PR: read view, or an editor with the markdown source beside the rendered preview. Saving
// rewrites that repository's entry in pr.json; approving pushes/opens that repository's PR right away.
const PrDraftEntryView = ({ detail, entry, repos, onAction }: { detail: TaskDetail; entry: PrDraftEntry; repos: string[]; onAction: Props["onAction"] }) => {
    const { task, pr } = detail;
    const row = prStateOf(detail, entry.repo);
    const created = !!row?.number;
    const approved = !!row?.approved_at;
    // Drafts are reviewed during PR Creation Review — and a draft whose PR never opened stays reviewable from the later PR stages.
    const reviewing = (task.stage === "pr_creation_review" && task.status === "waiting_user") || (!created && task.status !== "running" && (task.stage === "pr_waiting" || task.stage === "pr_fix" || task.stage === "pr_green"));
    const editable = task.status !== "running" && !created;
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(entry.title);
    const [body, setBody] = useState(entry.body);
    // This repository's PR base: the entry's own (a per-repo stack) or the draft's shared one.
    const [base, setBase] = useState(entry.base ?? pr?.base ?? "");
    const [saving, setSaving] = useState(false);
    const [notes, setNotes] = useState("");
    const [changes, setChanges] = useState(false);
    const attach = usePendingFiles();
    useEffect(() => {
        if (!editing) {
            setTitle(entry.title);
            setBody(entry.body);
            setBase(entry.base ?? pr?.base ?? "");
        }
    }, [entry.title, entry.body, entry.base, pr?.base, editing]);
    const dirty = title !== entry.title || body !== entry.body || base !== (pr?.base ?? "");
    const o = prOutcome(row);
    return (
        <Card
            title={<><RepoChip repo={entry.repo} repos={repos} /> PR draft</>}
            badge={
                <>
                    {created && <span className={`chip ${o.cls}`}>{row?.url ? <a href={row.url} target="_blank" rel="noreferrer">#{row.number} {o.text} ↗</a> : o.text}</span>}
                    {!created && approved && <span className="chip warn" title="Approved; Stagehand could not push or open it itself — see the status line">approved · {o.text}</span>}
                    {!created && !approved && reviewing && <span className="chip wait">awaiting your approval</span>}
                    {editable && !editing && <button className="tiny" onClick={() => setEditing(true)}>Edit</button>}
                </>
            }
        >
            {!editing && (
                <>
                    <div className="kv"><b>Title</b><span>{entry.title}</span><b>Base</b><code>{pr?.base}</code></div>
                    {entry.stackedOn && (
                        <div className="review-box" style={{ marginTop: 6 }}>
                            <b>Stacked PR.</b> Base <code>{pr?.base}</code> is open as <a href={entry.stackedOn.url} target="_blank" rel="noreferrer">#{entry.stackedOn.number} {entry.stackedOn.title} ↗</a> — that one merges first; GitHub retargets this PR to the trunk afterwards and the task follows. The body will open with a "Stacked on #{entry.stackedOn.number}" line.
                        </div>
                    )}
                    {!entry.stackedOn && entry.stackNote && (
                        <div className="blocked-box" style={{ marginTop: 6 }}>
                            <b>Base has no PR.</b> {entry.stackNote}
                        </div>
                    )}
                    <Markdown source={entry.body} />
                </>
            )}
            {editing && (
                <div className="pr-editor">
                    <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                    <label>Base branch{repos.length > 1 ? ` for ${repoName(entry.repo)}` : ""} <BranchPicker envId={task.env_id} repo={entry.repo} value={base} onChange={setBase} style={{ maxWidth: 320 }} /></label>
                    <div className="pr-editor-panes">
                        <div className="pr-editor-pane">
                            <div className="pr-editor-head">Markdown</div>
                            <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
                        </div>
                        <div className="pr-editor-pane preview">
                            <div className="pr-editor-head">Preview</div>
                            <div className="pr-editor-preview"><Markdown source={body || "*(empty)*"} /></div>
                        </div>
                    </div>
                    <div className="actions" style={{ marginBottom: 0 }}>
                        <button className="primary" disabled={saving || !title.trim() || !dirty} onClick={() => { setSaving(true); void onAction(() => api.patchPrDraft(task.id, { repo: entry.repo, title: title.trim(), body, base })).then(() => setEditing(false)).finally(() => setSaving(false)); }}>{saving ? "Saving…" : "Save draft"}</button>
                        <button disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
                        {dirty && <span className="field-hint">unsaved edits{approved ? " — saving withdraws the approval until you approve again" : ""}</span>}
                    </div>
                </div>
            )}
            {reviewing && !created && !editing && (
                <div className="review-box" style={{ marginTop: 12, marginBottom: 0 }}>
                    <b>{repoName(entry.repo)} — your call.</b>
                    {!approved && (
                        <div className="actions">
                            <button className="primary" onClick={() => onAction(() => api.review(task.id, { verdict: "approve", repo: entry.repo }))}>Approve & create {repoName(entry.repo)} PR</button>
                            <button onClick={() => setChanges((v) => !v)}>{changes ? "Cancel" : "Request changes"}</button>
                        </div>
                    )}
                    {approved && <div className="field-hint" style={{ marginTop: 6 }}>Approved. {task.status_line}</div>}
                    {changes && (
                        <>
                            <AgentInput placeholder={`What should change in the ${repoName(entry.repo)} description (required)`} value={notes} onChange={setNotes} pending={attach} />
                            <div className="actions" style={{ marginBottom: 0 }}>
                                <button className="primary" disabled={!notes.trim()} onClick={() => onAction(async () => { const files = await api.uploadFiles(task.id, attach.files); await api.review(task.id, { verdict: "changes", repo: entry.repo, notes, ...(files.length ? { files } : {}) }); setNotes(""); attach.clear(); setChanges(false); })}>Send back to the drafting agent</button>
                                <span className="field-hint">The agent redrafts this repository's PR (others are copied through unchanged); drafts not yet approved go back to pending.</span>
                            </div>
                        </>
                    )}
                </div>
            )}
        </Card>
    );
};

// PR Creation Review: one tab per repository; each draft is edited and approved on its own.
const PrDraftTabs = ({ detail, onAction, focusRepo, onFocusRepo }: { detail: TaskDetail; onAction: Props["onAction"]; focusRepo?: string | null; onFocusRepo?: (repo: string) => void }) => {
    const { task, pr } = detail;
    const drafts = pr?.drafts ?? [];
    const repos = drafts.map((d) => d.repo);
    // The open repository is routed (focusRepo); without a router, the first one.
    const [localActive, setLocalActive] = useState(0);
    const active = onFocusRepo ? Math.max(0, repos.indexOf(focusRepo ?? "")) : localActive;
    const setActive = (i: number) => (onFocusRepo ? onFocusRepo(repos[i] ?? "") : setLocalActive(i));
    if (drafts.length === 0) return <div className="empty">no draft yet</div>;
    const approvedCount = drafts.filter((d) => prStateOf(detail, d.repo)?.approved_at).length;
    const cur = drafts[Math.min(active, drafts.length - 1)]!;
    return (
        <>
            {pr?.legacy && drafts.length > 1 && (
                <div className="blocked-box">
                    <b>This draft predates per-repository PRs:</b> one description was written (on the first repository's template) and is shown under every repository. Redraft so each repository gets its own description on its own template.
                    {task.status !== "running" && (
                        <div className="actions" style={{ marginBottom: 0 }}>
                            <button className="primary" onClick={() => { if (confirm("Redraft the pull requests per repository? The current draft is archived.")) void onAction(() => api.rerun(task.id, "pr_creation_review")); }}>Redraft per repository</button>
                        </div>
                    )}
                </div>
            )}
            {drafts.length > 1 && (
                <div className="subtabs pr-repo-tabs">
                    {drafts.map((d, i) => {
                        const row = prStateOf(detail, d.repo);
                        const o = prOutcome(row);
                        return (
                            <button key={d.repo} className={`${i === active ? "active" : ""} repo-${repoColorClass(d.repo, repos)}`} onClick={() => setActive(i)}>
                                {repoName(d.repo)} <span className={`chip ${row?.approved_at ? o.cls || "ok" : "wait"}`}>{row?.number ? `#${row.number}` : row?.approved_at ? "approved" : "pending"}</span>
                            </button>
                        );
                    })}
                    <span className="field-hint" style={{ alignSelf: "center", marginTop: 0 }}>{approvedCount}/{drafts.length} approved · the task moves on once every repository is approved</span>
                </div>
            )}
            {task.stage === "pr_creation_review" && <ReviewHistory reviews={detail.reviews} stage="pr_creation_review" />}
            <PrDraftEntryView key={cur.repo} detail={detail} entry={cur} repos={repos} onAction={onAction} />
        </>
    );
};

// Batched PR jobs: tick what the agent should do in ONE run — rebase onto the latest base (mechanical first), fix the
// failing checks, address picked PR comments, follow free-text instructions — then review the diff once and push once.
const PrJobsCard = ({ detail, repos, onAction }: { detail: TaskDetail; repos: string[]; onAction: Props["onAction"] }) => {
    const { task } = detail;
    const [rebase, setRebase] = useState(false);
    const [rebaseRepos, setRebaseRepos] = useState<string[]>(repos);
    const [fixCi, setFixCi] = useState(false);
    const [instructions, setInstructions] = useState("");
    const attach = usePendingFiles();
    const [comments, setComments] = useState<Record<string, PrComments | null>>({});
    const [picked, setPicked] = useState<Set<string>>(() => new Set());
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const failing = repos.map((r) => ({ repo: r, n: parseChecks(prStateOf(detail, r)?.checks_json).filter((c) => !isApprovalGateCheck(c) && checkOutcome(c) === "fail").length })).filter((x) => x.n > 0);
    const withPr = repos.filter((r) => prStateOf(detail, r)?.number);
    useEffect(() => {
        let alive = true;
        for (const r of withPr) void api.prComments(task.id, r).then((c) => alive && setComments((m) => ({ ...m, [r]: c }))).catch(() => undefined);
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [task.id, withPr.join(",")]);
    const commentKey = (repo: string, id: number) => `${repo}:${id}`;
    const allComments = withPr.flatMap((r) => [...(comments[r]?.human ?? []), ...(comments[r]?.automation ?? [])].filter((c) => !(c.kind === "line" && c.resolved)).map((c) => ({ repo: r, c })));
    const jobs = (rebase ? 1 : 0) + (fixCi && failing.length ? 1 : 0) + (picked.size ? 1 : 0) + (instructions.trim() || attach.files.length ? 1 : 0);
    const run = async () => {
        setBusy(true);
        setNote(null);
        const byRepo = new Map<string, number[]>();
        for (const key of picked) {
            const [repo = "", id = ""] = key.split(":");
            byRepo.set(repo, [...(byRepo.get(repo) ?? []), Number(id)]);
        }
        try {
            await onAction(async () => {
                const files = await api.uploadFiles(task.id, attach.files);
                const r = await api.prJobs(task.id, {
                    rebase: rebase ? { repos: rebaseRepos.length === repos.length ? undefined : rebaseRepos } : null,
                    fixCi: fixCi ? {} : null,
                    comments: [...byRepo].map(([repo, ids]) => ({ repo, ids })),
                    ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
                    ...(files.length ? { files } : {}),
                });
                setNote(r.started ? `started: ${r.note}` : r.note);
                if (r.started) {
                    setPicked(new Set());
                    setInstructions("");
                    attach.clear();
                }
            });
        } finally {
            setBusy(false);
        }
    };
    const idle = task.status !== "running";
    return (
        <Card title="Batch jobs for the agent" badge={jobs ? <span className="chip accent">{jobs} job{jobs === 1 ? "" : "s"}</span> : undefined}>
            <p className="field-hint">Tick what to do in one agent session; it commits as it goes, you review the diff once, then one push. The rebase runs mechanically first — only conflicts reach the agent.</p>
            <div className="pr-jobs">
                <label className="inline">
                    <input type="checkbox" checked={rebase} onChange={(e) => setRebase(e.target.checked)} /> Rebase onto latest base
                    {rebase && repos.length > 1 && (
                        <span className="pr-jobs-sub">
                            {repos.map((r) => (
                                <label key={r} className="inline">
                                    <input type="checkbox" checked={rebaseRepos.includes(r)} onChange={(e) => setRebaseRepos((p) => (e.target.checked ? [...p, r] : p.filter((x) => x !== r)))} /> {repoName(r)}
                                </label>
                            ))}
                        </span>
                    )}
                </label>
                <label className="inline" title={failing.length ? failing.map((f) => `${repoName(f.repo)}: ${f.n} failing`).join(" · ") : "no failing checks right now"}>
                    <input type="checkbox" checked={fixCi} disabled={!failing.length} onChange={(e) => setFixCi(e.target.checked)} /> Fix failing CI
                    {failing.length > 0 && <span className="chip bad">{failing.map((f) => `${repos.length > 1 ? `${repoName(f.repo)} ` : ""}${f.n}`).join(" · ")}</span>}
                </label>
                <div className="pr-jobs-comments">
                    <span>Address PR comments{allComments.length ? ` (${picked.size}/${allComments.length} picked)` : withPr.length ? " — none open" : " — no PR yet"}</span>
                    {allComments.length > 0 && (
                        <>
                            <button className="tiny" onClick={() => setPicked(new Set(allComments.map((x) => commentKey(x.repo, x.c.id))))}>all</button>
                            <button className="tiny" onClick={() => setPicked(new Set())}>none</button>
                        </>
                    )}
                    {allComments.map(({ repo, c }) => {
                        const key = commentKey(repo, c.id);
                        const text = c.kind === "line" ? `${c.path}:${c.line ?? "?"} — ${c.body}` : c.kind === "review" ? `review (${c.state.toLowerCase()}): ${c.body || "(no text)"}` : c.body;
                        return (
                            <label key={key} className="inline pr-jobs-comment" title={text}>
                                <input type="checkbox" checked={picked.has(key)} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(key); else n.delete(key); return n; })} />
                                {repos.length > 1 && <RepoChip repo={repo} repos={repos} />}
                                <b>{c.author}</b> <span className="pr-jobs-comment-text">{text.slice(0, 140)}{text.length > 140 ? "…" : ""}</span>
                            </label>
                        );
                    })}
                </div>
                <label>Custom instructions (optional)
                    <AgentInput value={instructions} onChange={setInstructions} pending={attach} placeholder="Anything else the agent should do in the same run…" rows={3} />
                </label>
                <div className="pr-jobs-actions">
                    <button className="primary" disabled={!idle || busy || jobs === 0} onClick={() => void run()}>{busy ? "Starting…" : `Run ${jobs || ""} job${jobs === 1 ? "" : "s"} in one session`}</button>
                    {!idle && <span className="field-hint">a run is in progress</span>}
                    {note && <span className="field-hint">{note}</span>}
                </div>
            </div>
        </Card>
    );
};

// Details for the PR stages, one card per repository: checks, review, merge — everything the poller stored.
// Details for the PR stages: one tab per repository (not stacked cards), each with its own checks, review, merge state.
const PrPanel = ({ detail, onAction, focusRepo, onFocusRepo }: { detail: TaskDetail; onAction: Props["onAction"]; focusRepo?: string | null; onFocusRepo?: (repo: string) => void }) => {
    const { task } = detail;
    const repos = prRepos(detail);
    const [localActive, setLocalActive] = useState(0);
    const active = onFocusRepo ? Math.max(0, repos.indexOf(focusRepo ?? "")) : localActive;
    const setActive = (i: number) => (onFocusRepo ? onFocusRepo(repos[i] ?? "") : setLocalActive(i));
    if (repos.length === 0) return <Card title="Pull request"><p>{task.status_line ?? "No pull request yet."}</p></Card>;
    const repo = repos[Math.min(active, repos.length - 1)]!;
    const row = prStateOf(detail, repo);
    const o = prOutcome(row);
    const checks = parseChecks(row?.checks_json);
    return (
        <>
            {repos.length > 1 && (
                <div className="subtabs pr-repo-tabs">
                    {repos.map((r, i) => {
                        const rRow = prStateOf(detail, r);
                        const rO = prOutcome(rRow);
                        return (
                            <button key={r} className={`${i === active ? "active" : ""} repo-${repoColorClass(r, repos)}`} onClick={() => setActive(i)}>
                                {repoName(r)} <span className={`chip ${rO.cls}`}>{rRow?.number ? `#${rRow.number}` : rO.text}</span>
                            </button>
                        );
                    })}
                </div>
            )}
            <PrJobsCard detail={detail} repos={repos} onAction={onAction} />
            <Card title={<><RepoChip repo={repo} repos={repos} /> Pull request</>} badge={<span className={`chip ${o.cls}`}>{o.text}</span>}>
                {task.branch && (() => {
                    const bases = parseBaseBranch(task.base_branch);
                    const base = typeof bases === "string" ? bases : bases?.[repo];
                    return (
                        <div className="branch-line field-hint">
                            <code className="small">⎇ {task.branch}</code>
                            {base && <code className="small" title="base branch — the branch this repository's PR targets"> → {base}</code>}
                        </div>
                    );
                })()}
                {!row?.url && <p className="quiet">{row?.approved_at ? "Approved; not on GitHub yet — see the status line for what is left to do by hand." : "Not created yet."}</p>}
                {row?.url && (
                    <div className="kv">
                        <b>PR</b><a href={row.url} target="_blank" rel="noreferrer">#{row.number} ↗</a>
                        <b>Review</b><span>{row.review_decision ? row.review_decision.toLowerCase().replace("_", " ") : "no decision yet"}</span>
                        <b>Merged</b><span>{row.merged_at ? new Date(row.merged_at).toLocaleString() : row.state === "CLOSED" ? "closed without merge" : "not yet"}</span>
                        <b>Checks</b>
                        <span>
                            <ChecksList checks={checks} />
                            {o.kind === "failed" && task.status !== "running" && (
                                <div className="actions" style={{ margin: "8px 0 0" }}>
                                    <button className="primary" onClick={() => onAction(() => api.fixCi(task.id, repo))}>Fix CI on {repoName(repo)}</button>
                                </div>
                            )}
                        </span>
                        <b>Last poll</b><span>{new Date(row.updated_at).toLocaleString()}{row.pushed_at ? ` · last push ${new Date(row.pushed_at).toLocaleString()}` : ""}</span>
                    </div>
                )}
            </Card>
        </>
    );
};

// design.md split on its `## ` headings, for the Work tab's summary of the proposal.
interface MdSection { title: string; body: string }
const splitSections = (md: string): { intro: string; sections: MdSection[] } => {
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

// One QA scenario as the reviewer reads it: the steps, the baseline's outcome with its evidence, and the seed and
// teardown folded away (rarely read).
const QaTests = ({ taskId, design, before }: { taskId: string; design: NonNullable<TaskDetail["design"]>; before: QaPass | null }) => {
    const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
    const chip = (o?: string) =>
        o ? <span className={`chip ${o === "pass" ? "ok" : o === "fail" ? "bad" : o === "needs_human" ? "wait" : "warn"}`}>baseline {o === "needs_human" ? "check yourself" : o}</span> : <span className="chip">no baseline yet</span>;
    if (design.qa.length === 0) return <div className="quiet"><b>No QA scenarios</b> — {design.qaSkippedReason ?? "no reason given"}</div>;
    return (
        <>
            {zoom && <Lightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
            {before?.blockers.length ? (
                <div className="qa-blockers"><span className="qa-obs-label"><b>Baseline blockers</b></span><ul className="qa-obs-text">{before.blockers.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
            ) : null}
            {design.qa.map((s) => {
                const b = before?.scenarios.find((x) => x.id === s.id);
                const setup = [...(s.teardown ?? []).map((x) => ({ kind: "Teardown", x })), ...(s.seed ?? []).map((x) => ({ kind: "Seed", x }))];
                return (
                    <details className="scenario" key={s.id} open>
                        <summary>
                            <h3>
                                <span className="chip accent">{s.id}</span>{s.kind === "api" && <span className="chip">API</span>}<b className="scenario-title">{s.title}</b> <code>{s.url}</code> <span className="chip persona">{s.persona}</span>{" "}
                                {s.baseline === false ? <span className="chip" title="The journey does not exist before the change: the baseline records it as a failure by construction">new surface — no baseline</span> : chip(b?.outcome)}
                            </h3>
                        </summary>
                        <ol className="qa-steps">
                            {s.steps.map((st, i) => (
                                <li key={i}>
                                    <b>Do:</b> {s.kind === "api" ? <code>{st.action}</code> : st.action}
                                    <br />
                                    <b>Expect:</b> {st.assert} {st.shot && <span className="chip warn">shot</span>}
                                </li>
                            ))}
                        </ol>
                        {b?.observation && (
                            <div className="qa-obs">
                                <div className="qa-obs-row">
                                    <span className="qa-obs-label"><b>Baseline saw</b></span>
                                    <ul className="qa-obs-text">{b.observation.split(/;\s+/).map((frag, i) => <li key={i}>{frag}</li>)}</ul>
                                </div>
                            </div>
                        )}
                        {b?.log && <pre className="qa-log">{b.log}</pre>}
                        {b && b.shots.length > 0 && (
                            <div className="gallery" style={{ marginTop: 8 }}>
                                {b.shots.map((sh) => (
                                    <figure key={sh.step}>
                                        <img src={api.artifactUrl(taskId, sh.file)} alt="" onClick={() => setZoom({ src: api.artifactUrl(taskId, sh.file), caption: `${s.id} · baseline · step ${sh.step} · ${s.steps[sh.step - 1]?.assert ?? ""}` })} title="Click to inspect" />
                                        <figcaption><b>step {sh.step}</b> · {s.steps[sh.step - 1]?.assert}</figcaption>
                                    </figure>
                                ))}
                            </div>
                        )}
                        {setup.length > 0 ? (
                            <details className="seed">
                                <summary><b>Seed</b> — {s.seed?.length ?? 0} step(s){s.teardown?.length ? `, ${s.teardown.length} teardown` : ""}</summary>
                                <ul className="plain">{setup.map((x, i) => <li key={i}><b>{x.kind}:</b> <code>{x.x}</code></li>)}</ul>
                            </details>
                        ) : (
                            <div className="seed quiet">Seed: nothing beyond a logged-in user</div>
                        )}
                    </details>
                );
            })}
        </>
    );
};

// "Product owner review": on request, the task's Product Owner reviews the proposal as product; the review is editable
// here and goes to the design agent as the notes of another round.
// The Product Owner's brief on the ticket: written before research, read by the research and design agents.
const PoBriefCard = ({ task, onError }: { task: TaskDetail["task"]; onError: (m: string) => void }) => {
    const [b, setB] = useState<PoReview | null>(null);
    const load = useCallback(() => void api.poBrief(task.id).then(setB).catch((e: Error) => onError(e.message)), [task.id, onError]);
    useEffect(load, [load, task.updated_at]);
    if (!b) return null;
    return (
        <section className="card">
            <h2>Product Owner brief <span className="field-hint">— what to pay attention to beyond the ticket; research and design read it</span></h2>
            {b.status === "failed" && <div className="blocked-box">The brief failed: {b.error}</div>}
            {b.text ? <Markdown source={b.text} /> : <div className="quiet">{b.running ? "The Product Owner is writing it…" : "No brief yet. It is written before research starts."}</div>}
            <div className="actions">
                <button disabled={b.running} onClick={async () => { try { setB(await api.startPoBrief(task.id)); } catch (e) { onError(String((e as Error).message ?? e)); } }}>{b.running ? "Writing…" : b.text ? "Write again" : "Write brief"}</button>
                {b.at && <span className="field-hint">{b.status} · {new Date(b.at).toLocaleString()}</span>}
            </div>
        </section>
    );
};

const SEVERITY_CHIP: Record<PoReviewComment["severity"], string> = { high: "bad", medium: "warn", low: "" };

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
                    <label className="inline" title={c.withdrawn ? "The Product Owner withdrew this comment" : "Send this comment in the next design round"}>
                        <input type="checkbox" checked={!!c.include && !c.withdrawn} disabled={c.withdrawn || busy} onChange={(e) => onPick(e.target.checked)} />
                    </label>
                )}
                <span className={`chip ${SEVERITY_CHIP[c.severity]}`}>{c.severity}</span>
                <span className="chip">{c.area}</span>
                {c.laterTicket && <span className="chip accent" title="This task's design makes this later ticket harder; the comment says what to change here">for {c.laterTicket}</span>}
                <b>{c.id} · {c.title}</b>
                {c.withdrawn && <span className="chip">withdrawn</span>}

            </div>
            <Markdown source={c.body} />
            {note !== null ? (
                <div className="po-human-note">
                    <AgentInput placeholder="Your note on this comment — it goes to the design agent with it" value={note} onChange={setNote} rows={3} />
                    <div className="actions" style={{ marginBottom: 0 }}>
                        <button className="primary" onClick={() => void onNote(note.trim() || null).then(() => setNote(null))}>Save note</button>
                        <button onClick={() => setNote(null)}>Cancel</button>
                    </div>
                </div>
            ) : c.note ? (
                <div className="po-human-note">
                    <div className="chat-msg-head"><b>Your note</b></div>
                    <Markdown source={c.note} />
                    {!closed && (
                        <div className="actions" style={{ marginBottom: 0 }}>
                            <button className="tiny" onClick={() => setNote(c.note ?? "")}>Edit</button>
                            <button className="tiny danger" onClick={() => void onNote(null)}>Delete</button>
                        </div>
                    )}
                </div>
            ) : null}
            {!closed && note === null && !c.note && <button className="tiny" onClick={() => setNote("")}>+ Add note</button>}{" "}
            {(!closed || c.thread.length > 0) && <button className="tiny" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"} {closed ? "Discussion" : "Discuss with Product owner"}{c.thread.length ? ` (${c.thread.length})` : ""}</button>}
            {open && (
                <div className="line-thread" style={{ marginLeft: 0 }}>
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
                            <div className="actions" style={{ marginBottom: 0 }}>
                                <button className="primary" disabled={!text.trim() || busy} title={busy ? "The Product Owner is busy with this review" : undefined} onClick={() => void send()}>Ask</button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

const PoReviewPanel = ({ task, owner, onAction, onError }: { task: TaskDetail["task"]; owner: ProductOwner | null; onAction: Props["onAction"]; onError: (m: string) => void }) => {
    const [r, setR] = useState<PoDesignReview | null>(null);
    const load = useCallback(() => void api.poReview(task.id).then(setR).catch((e: Error) => onError(e.message)), [task.id, onError]);
    useEffect(load, [load, task.updated_at]);
    if (!owner) return <div className="empty">No Product Owner for this task. Pick one in the header (<b>product owner</b>) to get a product review of the proposal.</div>;
    if (!r) return <div className="empty">loading…</div>;
    const canSend = task.stage === "design_proposal" && task.status === "waiting_user";
    const rev = r.review;
    const picked = rev?.comments.filter((c) => c.include && !c.withdrawn) ?? [];
    const order = { high: 0, medium: 1, low: 2 } as const;
    const comments = [...(rev?.comments ?? [])].sort((a, b) => Number(a.withdrawn) - Number(b.withdrawn) || order[a.severity] - order[b.severity]);
    const reviewing = r.running && !r.asking;
    const call = async (fn: () => Promise<PoDesignReview>) => { try { setR(await fn()); } catch (e) { onError(String((e as Error).message ?? e)); } };
    return (
        <div className="po-review">
            <div className="actions" style={{ marginTop: 0 }}>
                <button className="primary" disabled={r.running} onClick={() => void call(() => api.startPoReview(task.id))}>{reviewing ? "The Product Owner is reviewing…" : rev ? "Review again by Product owner" : "Review by Product owner"}</button>
                <span className="field-hint">{owner.title}{r.at ? ` · ${r.status ?? ""} ${new Date(r.at).toLocaleString()}` : ""}</span>
            </div>
            {r.status === "failed" && <div className="blocked-box">The review failed: {r.error}</div>}
            {rev && (
                <>
                    <div className="po-verdict">
                        <span className={`chip ${rev.verdict === "approve" ? "ok" : "warn"}`}>{rev.verdict === "approve" ? "approve" : "changes"}</span> <b>{rev.summary}</b>
                    </div>
                    {rev.sentAt ? (
                        <>
                            <div className="review-box">
                                <b>Sent to the agent {new Date(rev.sentAt).toLocaleString()}</b> — {rev.comments.filter((c) => c.sentAt).length} sent, {rev.comments.filter((c) => !c.sentAt).length} skipped. This review is closed; review the new proposal again when it is ready.
                            </div>
                            {[["Sent", comments.filter((c) => c.sentAt)], ["Skipped", comments.filter((c) => !c.sentAt)]].map(([label, list]) =>
                                (list as PoReviewComment[]).length ? (
                                    <div key={label as string}>
                                        <h3>{label as string} ({(list as PoReviewComment[]).length})</h3>
                                        {(list as PoReviewComment[]).map((c) => <PoReviewCommentCard key={c.id} c={c} busy asking={false} closed onPick={() => undefined} onNote={async () => undefined} onAsk={async () => undefined} />)}
                                    </div>
                                ) : null,
                            )}
                        </>
                    ) : comments.length === 0 ? <div className="quiet">No comments.</div> : comments.map((c) => (
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
                    {!rev.sentAt && <div className="actions">
                        <button className="primary" disabled={!canSend || r.running || picked.length === 0} title={canSend ? "Another design round with the picked comments as the notes" : "The proposal must be waiting for your review"} onClick={() => void onAction(async () => { await api.sendPoReview(task.id); })}>
                            Send {picked.length} comment{picked.length === 1 ? "" : "s"} to agent
                        </button>
                        <span className="field-hint">{rev.comments.length - picked.length} skipped this round</span>
                    </div>}
                </>
            )}
        </div>
    );
};

// The design tab: the proposal as one document, the QA tests with their baseline, and the Product owner review.
const DesignTabs = ({ task, owner, design, md, before, section, onSection, onAction, onError }: { task: TaskDetail["task"]; owner: ProductOwner | null; design: NonNullable<TaskDetail["design"]>; md: string | null; before: QaPass | null; section?: string; onSection: (s: string) => void; onAction: Props["onAction"]; onError: (m: string) => void }) => {
    const active = section === "qa" ? "qa" : section === "po" ? "po" : "proposal";
    const body = useMemo(() => (md ?? "").replace(/^#\s[^\n]*\n/, ""), [md]);
    const ran = design.qa.filter((s) => before?.scenarios.some((x) => x.id === s.id)).length;
    return (
        <>
            <div className="subtabs">
                <button className={active === "proposal" ? "active" : ""} onClick={() => onSection("proposal")}>Proposal</button>
                <button className={active === "qa" ? "active" : ""} onClick={() => onSection("qa")}>QA tests <span className="chip">{design.qa.length}</span>{design.qa.length > 0 && <span className="chip">{ran ? `baseline ${ran}/${design.qa.length}` : "no baseline"}</span>}</button>
                <button className={active === "po" ? "active" : ""} onClick={() => onSection("po")}>Product owner review{owner ? "" : " · none"}</button>
            </div>
            <div className="design-section">
                {active === "proposal" ? (md ? <Markdown source={body} /> : <div className="empty">design.md is missing</div>) : active === "qa" ? <QaTests taskId={task.id} design={design} before={before} /> : <PoReviewPanel task={task} owner={owner} onAction={onAction} onError={onError} />}
            </div>
        </>
    );
};

// Full-size view of one screenshot: first click fits it to the viewport width, a second click shows it 1:1 (scrollable).
const Lightbox = ({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) => {
    const [natural, setNatural] = useState(false);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="lightbox" onClick={onClose}>
            <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
                <span>{caption}</span>
                <span className="lightbox-actions">
                    <button onClick={() => setNatural((v) => !v)}>{natural ? "Fit to width" : "Actual size"}</button>
                    <a href={src} target="_blank" rel="noreferrer">Open in a tab ↗</a>
                    <button onClick={onClose} aria-label="Close">×</button>
                </span>
            </div>
            <img src={src} alt="" className={natural ? "natural" : ""} onClick={(e) => { e.stopPropagation(); setNatural((v) => !v); }} />
        </div>
    );
};

// The corrections applied to design.json during QA (a seed, step, assert or whole scenario), by the human's answer or by
// Jev, each revertible: the next pass then runs the original again.
const QaChanges = ({ taskId, running, onAction }: { taskId: string; running: boolean; onAction: (fn: () => Promise<unknown>) => Promise<void> }) => {
    const [changes, setChanges] = useState<QaChange[]>([]);
    const load = () => void api.qaChanges(taskId).then((r) => setChanges(r.changes)).catch(() => setChanges([]));
    useEffect(load, [taskId, running]);
    if (!changes.length) return null;
    const what = (c: QaChange): string => (c.kind === "scenario" ? "scenario rewritten" : `${c.kind} ${c.index + 1}`);
    return (
        <Sub title={<>Scenario changes during QA <span className="chip">{changes.length}</span></>} open={false}>
            <div className="qa-changes">
                {changes.map((c) => (
                    <div className="qa-change" key={c.id}>
                        <span className="chip accent">{c.scenario}</span> <b>{what(c)}</b>{" "}
                        <span className={`chip ${c.by === "jev" ? "ok" : ""}`} title={c.jev ? `legit ${Math.round(c.jev.legit * 100)} %, weakens ${Math.round(c.jev.weakens * 100)} %, read as ${c.jev.kind}` : "approved by you"}>{c.by === "jev" ? "Jev-approved" : "your answer"}</span>{" "}
                        <span className="field-hint">{new Date(c.at).toLocaleString()}</span>
                        {c.revertedAt && <span className="chip warn">reverted</span>}
                        {c.reason && <div className="field-hint">{c.reason}</div>}
                        <details>
                            <summary>before / after</summary>
                            <pre className="qa-change-diff">{JSON.stringify(c.before, null, 2)}</pre>
                            <pre className="qa-change-diff">{JSON.stringify(c.after, null, 2)}</pre>
                        </details>
                        {!c.revertedAt && <button className="tiny" disabled={running} onClick={() => void onAction(async () => { await api.revertQaChange(taskId, c.id); load(); })}>Revert</button>}
                    </div>
                ))}
            </div>
        </Sub>
    );
};

const QaGallery = ({ taskId, design, before, after }: { taskId: string; design: NonNullable<TaskDetail["design"]>; before: QaPass | null; after: QaPass | null }) => {
    const [zoom, setZoom] = useState<{ src: string; caption: string } | null>(null);
    const shot = (file: string | undefined, caption: string, missing: string) =>
        file ? <img src={api.artifactUrl(taskId, file)} alt="" onClick={() => setZoom({ src: api.artifactUrl(taskId, file), caption })} title="Click to inspect" /> : <div className="empty">{missing}</div>;
    return (
    <>
        {zoom && <Lightbox src={zoom.src} caption={zoom.caption} onClose={() => setZoom(null)} />}
        {[before, after].map((p) => p?.blockers.length ? (
            <div key={p.pass} className="qa-blockers"><span className="qa-obs-label">{p.pass} blockers</span><ul className="qa-obs-text">{p.blockers.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
        ) : null)}
        {design.qa.map((s) => {
            const b = before?.scenarios.find((x) => x.id === s.id);
            const a = after?.scenarios.find((x) => x.id === s.id);
            const shots = s.steps.map((st, i) => (st.shot ? i + 1 : null)).filter((x): x is number => x !== null);
            const chip = (o?: string) =>
                o ? <span className={`chip ${o === "pass" ? "ok" : o === "fail" ? "bad" : o === "needs_human" ? "wait" : "warn"}`}>{o === "needs_human" ? "check yourself" : o}</span> : <span className="chip">—</span>;
            // A "pass" whose own observation talks about errors deserves a second look (the runner may have rationalised an env problem away).
            const suspicious = (p?: { outcome: string; observation: string }) =>
                p?.outcome === "pass" && /\berror|exception|unauthori[sz]ed|forbidden|denied|could not|couldn't|failed|4\d\d\b|5\d\d\b/i.test(p.observation);
            return (
                <details className="scenario" key={s.id} open>
                    <summary>
                        <h3>
                            <span className="chip accent">{s.id}</span>{s.kind === "api" && <span className="chip">API</span>}<span className="scenario-title">{s.title}</span> <span>before {chip(b?.outcome)}{b?.superseded && <span className="chip warn" title={`The scenario changed after the baseline pass (change ${b.superseded}); this before result no longer pairs with the after pass until the baseline re-run replaces it`}>baseline superseded</span>}</span> <span>after {chip(a?.outcome)}</span>
                            {a?.jev && <span className={`chip ${a.jev.verdict === "pass" ? "ok" : "warn"}`} title={`Jev's grade of the runner's observation against the asserts (pass needs 85); the runner said ${a.jev.runner}`}>Jev {a.jev.grade}/100</span>}
                            {(suspicious(b) || suspicious(a)) && <span className="chip warn" title="The runner marked this pass but its observation mentions an error — check the screenshots">⚠ observation mentions an error</span>}
                        </h3>
                    </summary>
                    {a?.outcome === "needs_human" && (
                        <div className="review-box" style={{ marginTop: 8 }}>
                            <b>Please verify this one yourself.</b> {a.observation}
                        </div>
                    )}
                    {(b?.observation || a?.observation) && (
                        <div className="qa-obs">
                            {[b, a].map((p) => p?.observation ? (
                                <div key={p === b ? "before" : "after"} className="qa-obs-row">
                                    <span className="qa-obs-label">{p === b ? "Before" : "After"} {chip(p.outcome)}</span>
                                    <ul className="qa-obs-text">{p.observation.split(/;\s+/).map((frag, i) => <li key={i}>{frag}</li>)}</ul>
                                </div>
                            ) : null)}
                        </div>
                    )}
                    {(b?.log || a?.log) && (
                        <div className="gallery" style={{ marginTop: 8 }}>
                            {[b, a].map((p) => (
                                <figure key={p === b ? "before" : "after"}>
                                    {p?.log ? <pre className="qa-log">{p.log}</pre> : <div className="empty">no {p === b ? "before" : "after"} output</div>}
                                    <figcaption>{p === b ? "before" : "after"} · commands and output</figcaption>
                                </figure>
                            ))}
                        </div>
                    )}
                    {shots.map((step) => {
                        const bf = b?.shots?.find((x) => x.step === step)?.file;
                        const af = a?.shots?.find((x) => x.step === step)?.file;
                        return (
                            <div className="gallery" key={step} style={{ marginTop: 8 }}>
                                <figure>{shot(bf, `${s.id} · before · step ${step} · ${s.steps[step - 1]?.assert ?? ""}`, "no before shot")}<figcaption>before · step {step} · {s.steps[step - 1]?.assert}</figcaption></figure>
                                <figure>{shot(af, `${s.id} · after · step ${step} · ${s.steps[step - 1]?.assert ?? ""}`, "no after shot")}<figcaption>after · step {step}</figcaption></figure>
                            </div>
                        );
                    })}
                </details>
            );
        })}
    </>
    );
};
