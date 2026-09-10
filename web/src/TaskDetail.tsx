import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { LabelEditor } from "./Labels";
import { api, checkOutcome, isApprovalGateCheck, labelsOf, parseChecks, pendingQuestions, prRepos, prStateOf, repoName, STAGE_LABEL, STAGE_ORDER, taskLabel, type Account, type MergeMethod, type PrCheck, type PrDraftEntry, type PrState, type QaPass, type QuestionRound, type Stage, type TaskDetail, type Ticket, type TicketAttachment } from "./api";
import { storage } from "./storage";
import { LazyTerminal } from "./LazyTerminal";
import { Chat } from "./Chat";
import { Markdown } from "./Markdown";
import { ServicesPanel } from "./Services";
import { TaskCost } from "./TaskCost";
import { DiffView, useDraftComments, type PriorComment } from "./DiffView";
import type { Env, LineComment, PrComment, PrComments, Review } from "./api";

const isResolved = (c: PrComment): boolean => c.kind === "line" && c.resolved;

// GitHub PR comments of one kind (human or automation): review verdicts, line comments (path:line), general comments.
// Open ones first (oldest first), resolved threads sink to the bottom; a line comment's thread can be resolved/reopened here.
const PrCommentList = ({ title, items, loading, error, hasPr, url, fetchedAt, onRefresh, selected, onToggle, onResolve }: { title: string; items: PrComment[] | null; loading: boolean; error: string | null; hasPr: boolean; url: string | null; fetchedAt: string | null; onRefresh: () => void; selected: Set<number>; onToggle: (id: number) => void; onResolve: (id: number, resolved: boolean) => Promise<void> }) => {
    const [busy, setBusy] = useState<number | null>(null);
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
    // The open tab is routed (part of the URL hash) so a reload lands on the same view.
    tab: Tab;
    setTab: (t: Tab) => void;
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
const NotesCard = ({ detail, onSave }: { detail: TaskDetail; onSave: (notes: string) => Promise<void> }) => {
    const [text, setText] = useState(detail.task.notes ?? "");
    const [editing, setEditing] = useState(false);
    useEffect(() => setText(detail.task.notes ?? ""), [detail.task.id, detail.task.notes]);
    return (
        <section className="card">
            <h2>Your instructions {detail.task.notes ? <span className="chip accent">given to every stage</span> : <span className="chip">none</span>}</h2>
            {!editing && (detail.task.notes ? <div className="md">{detail.task.notes}</div> : <div className="quiet">Extra context for the agents: constraints, where to look, what to skip. Applies to every stage that runs after you save.</div>)}
            {editing && <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Only touch the backend; the FE change ships separately. Use the existing BidRepository." />}
            <div className="actions" style={{ marginBottom: 0 }}>
                {!editing && <button onClick={() => setEditing(true)}>{detail.task.notes ? "Edit" : "Add instructions"}</button>}
                {editing && <button className="primary" onClick={async () => { await onSave(text); setEditing(false); }}>Save</button>}
                {editing && <button onClick={() => { setText(detail.task.notes ?? ""); setEditing(false); }}>Cancel</button>}
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
const ReturnBox = ({ task, pending, onSend, onClose }: { task: TaskDetail["task"]; pending: LineComment[]; onSend: (stage: Stage, notes: string, withComments: boolean) => Promise<void>; onClose: () => void }) => {
    const idx = STAGE_ORDER.indexOf(task.stage);
    const options = RETURNABLE.filter((s) => STAGE_ORDER.indexOf(s) <= idx);
    const [stage, setStage] = useState<Stage>(options[options.length - 1] ?? "design_proposal");
    const [notes, setNotes] = useState("");
    if (options.length === 0) return null;
    const runs = stage !== "user_review";
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
            <textarea placeholder={runs ? "What should change (required)" : "Notes for yourself (optional)"} value={notes} onChange={(e) => setNotes(e.target.value)} />
            {stage === "implementation" && pending.length > 0 && <div className="field-hint">{pending.length} draft line comment(s) from Code changes go along.</div>}
            <div className="actions" style={{ marginBottom: 0 }}>
                <button className="primary" disabled={runs && !notes.trim() && !(stage === "implementation" && pending.length > 0)} onClick={() => void onSend(stage, notes, stage === "implementation")}>Send back to {STAGE_LABEL[stage]}</button>
                <button onClick={onClose}>Cancel</button>
            </div>
        </div>
    );
};

// The agent stopped mid-stage to ask: one answer per question (an option click fills it, free text overrides), then the
// stage resumes in the same session with the answers. Sending with blanks lets the agent decide those itself.
const QuestionsBox = ({ round, onSend }: { round: QuestionRound; onSend: (answers: Record<string, string>) => Promise<void> }) => {
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [sending, setSending] = useState(false);
    useEffect(() => setAnswers({}), [round.id]);
    const set = (id: string, text: string) => setAnswers((a) => ({ ...a, [id]: text }));
    const answered = round.questions.filter((q) => answers[q.id]?.trim()).length;
    const send = () => { setSending(true); void onSend(answers).finally(() => setSending(false)); };
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
                    <textarea value={answers[q.id] ?? ""} onChange={(e) => set(q.id, e.target.value)} placeholder={q.options.length ? "Pick an option above or write your own answer" : "Your answer"} style={{ minHeight: 48 }} />
                </div>
            ))}
            <div className="actions" style={{ marginBottom: 0 }}>
                <button className="primary" disabled={sending || answered === 0} onClick={send}>{sending ? "Sending…" : `Send answers${answered < round.questions.length ? ` (${answered}/${round.questions.length})` : ""}`}</button>
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

const RERUNNABLE: ReadonlySet<Stage> = new Set(["research", "design_proposal", "qa_baseline", "implementation", "manual_qa", "pr_creation_review", "pr_fix"]);
const PR_STAGES: ReadonlySet<Stage> = new Set(["pr_waiting", "pr_fix", "pr_green", "pr_approved", "done"]);

const statusChip = (s: string) => {
    const cls = s === "waiting_user" || s === "blocked" ? "wait" : s === "running" ? "accent" : s === "failed" ? "bad" : s === "done" ? "ok" : s === "rate_limited" ? "warn" : "";
    return <span className={`chip ${cls}`}>{s.replace("_", " ")}</span>;
};

export type Tab = "work" | "runs" | "design" | "code" | "comments" | "chat" | "ticket" | "cost";
export const TASK_TABS: readonly Tab[] = ["work", "runs", "design", "code", "comments", "chat", "ticket", "cost"];

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
    const order = { fail: 0, pending: 1, pass: 2 };
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
                        <span className={`chip ${gate ? "" : o === "pass" ? "ok" : o === "fail" ? "bad" : "warn"}`}>{gate ? "manual gate" : o === "pending" ? (c.status === "IN_PROGRESS" || c.startedAt ? "running" : "queued") : st}</span>
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
const REPO_COLORS = ["accent", "wait", "ok", "warn"] as const;
const RepoChip = ({ repo, repos }: { repo: string; repos: string[] }) => {
    if (repos.length <= 1 && !repo) return null;
    const i = Math.max(0, repos.indexOf(repo));
    return <span className={`chip repo-chip ${REPO_COLORS[i % REPO_COLORS.length]}`} title={repo ? `repository ${repo}/` : "repository"}>{repoName(repo)}</span>;
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

// One repository's PR in the header widget: repo chip, state, number, checks summary, merge controls.
const PrRepoRow = ({ detail, repo, repos, onAction }: { detail: TaskDetail; repo: string; repos: string[]; onAction: Props["onAction"] }) => {
    const { task } = detail;
    const row = prStateOf(detail, repo);
    const o = prOutcome(row);
    const checks = parseChecks(row?.checks_json);
    const gated = checks.filter((c) => !isApprovalGateCheck(c));
    const passed = gated.filter((c) => checkOutcome(c) === "pass").length;
    const live = gated.filter((c) => checkOutcome(c) !== "pass");
    return (
        <div className={`pr-repo ${o.kind}`}>
            <div className="widget-body">
                <RepoChip repo={repo} repos={repos} />
                <span className={`chip ${o.cls}`}>{o.text}</span>
                {row?.url && <a href={row.url} target="_blank" rel="noreferrer">#{row.number} ↗</a>}
                {row?.review_decision && row.review_decision !== "APPROVED" && <span className="chip">{row.review_decision.toLowerCase().replace("_", " ")}</span>}
                {gated.length > 0 && <span className="mono small">{passed}/{gated.length} checks passed{checks.length > gated.length ? ` (+${checks.length - gated.length} gates)` : ""}</span>}
                {row?.url && !row.merged_at && row.state !== "CLOSED" && <MergeControls task={task} row={row} onAction={onAction} />}
                {row?.approved_at && !row.number && task.status !== "running" && (
                    <button className="tiny" title="Push this repository's branch and open its PR now (uses the approved draft; needs the env to allow pushes / PR creation, or a PR opened by hand is picked up by branch)" onClick={() => onAction(() => api.createApprovedPrs(task.id))}>Push & open now</button>
                )}
            </div>
            {row?.url && !row.merged_at && live.length > 0 && <div className="widget-checks"><ChecksList checks={live} compact /></div>}
        </div>
    );
};

// PR status for the header widget: one row per repository, from the stored PR rows (or the draft's repositories).
const PrWidget = ({ detail, onAction }: { detail: TaskDetail; onAction: Props["onAction"] }) => {
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
            {repos.map((repo) => <PrRepoRow key={repo} detail={detail} repo={repo} repos={repos} onAction={onAction} />)}
            {repos.length > 0 && (
                <div className="field-hint">
                    {task.branch && <code className="small">⎇ {task.branch}</code>}{task.branch ? " · " : ""}
                    {lastPoll ? `last poll ${new Date(lastPoll).toLocaleTimeString()} · ` : ""}polls every 2 min
                </div>
            )}
        </section>
    );
};

export const TaskDetailView = ({ detail, accounts, env, onError, feed, terminal, onAction, tab, setTab, onOpenTerminal, onCloseTerminal }: Props) => {
    const { task, runs, design, impl, qaBefore, qaAfter, pr, prFix, research } = detail;
    const tickets = detail.tickets ?? [];
    const qaHistory = detail.qaHistory ?? [];
    const has = (p: string) => detail.artifacts.some((a) => a.path === p);
    const researchMd = useArtifactText(task.id, "research.md", has("research.md"));
    const designMd = useArtifactText(task.id, "design.md", has("design.md"));
    const [notes, setNotes] = useState("");
    const [returning, setReturning] = useState(false);
    const [routeTo, setRouteTo] = useState<"implementation" | "design_proposal">("implementation");
    const [comments, changeComment, clearComments] = useDraftComments(task.id);
    const pending = Object.entries(comments);
    const canComment = task.status === "waiting_user" && task.stage === "user_review";
    const currentIdx = STAGE_ORDER.indexOf(task.stage);
    const skipped = new Set<Stage>(design && design.qa.length === 0 ? ["qa_baseline", "manual_qa"] : []);
    // Waiting on answers to the agent's questions is not a review: the review box stays hidden until they are sent.
    const asking = pendingQuestions(detail);
    const waiting = task.status === "waiting_user" && !asking;
    const [step, setStep] = useState<Stage>(task.stage);
    useEffect(() => {
        setStep(task.stage);
    }, [task.id]);
    useEffect(() => setStep(task.stage), [task.stage]);
    // GitHub PR comments (humans + automation), loaded when a tab needs them; line comments are also shown inline in the diff.
    const [commentsTab, setCommentsTab] = useState<"user" | "pr" | "automation">("user");
    const [selectedComments, setSelectedComments] = useState<Set<number>>(new Set());
    const toggleComment = (id: number) => setSelectedComments((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });
    useEffect(() => setSelectedComments(new Set()), [task.id]);
    // Which repository's PR the comments tab looks at (multi-repo tasks have one PR per repository).
    const prdRepos = (detail.prStates ?? []).filter((r) => r.number).map((r) => r.repo);
    const [ghRepoRaw, setGhRepo] = useState<string | null>(null);
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

    const proposedMd = useMemo(() => (designMd ? splitSections(designMd).sections.find((s) => /^proposed changes/i.test(s.title))?.body.trim() ?? null : null), [designMd]);
    // The explanation section — Root cause (bug) or Approach (feature) — is what the reviewer reads first.
    const explanation = useMemo(() => (designMd ? splitSections(designMd).sections.find((s) => /^(root cause|approach)/i.test(s.title)) ?? null : null), [designMd]);

    // Which workflow steps have something to show (or are the current one).
    const stepHasContent = (s: Stage): boolean => {
        switch (s) {
            case "research": return !!research;
            case "design_proposal": return !!design;
            case "qa_baseline": return !!qaBefore;
            case "implementation": return !!impl;
            case "manual_qa": return !!qaAfter;
            case "user_review": return detail.reviews.some((r) => r.stage === "user_review") || task.stage === "user_review";
            case "pr_creation_review": return !!pr;
            default: return PR_STAGES.has(s) && ((detail.prStates?.length ?? 0) > 0 || s === task.stage);
        }
    };
    const steps = STAGE_ORDER.filter((s, i) => i <= currentIdx && !skipped.has(s) && (stepHasContent(s) || s === task.stage));
    // PR stages share one panel.
    const stepKey = (s: Stage): Stage => (PR_STAGES.has(s) ? "pr_waiting" : s);

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
            <textarea placeholder={canComment ? "General comments (optional if you left line comments in Code changes)" : "Notes for Claude (required for 'Request changes')"} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
                    onClick={() => onAction(async () => { await api.review(task.id, { verdict: "approve", ...(notes ? { notes } : {}) }); clearComments(); setNotes(""); })}
                >
                    {task.stage === "pr_fix" ? "Approve & push" : "Approve"}
                </button>
                <button
                    disabled={!notes.trim() && !(canComment && pending.length > 0)}
                    onClick={() =>
                        onAction(async () => {
                            await api.review(task.id, {
                                verdict: "changes",
                                ...(notes.trim() ? { notes } : {}),
                                ...(task.stage === "user_review" ? { routeTo, comments: pending.map(([, c]) => c) } : {}),
                            });
                            clearComments();
                            setNotes("");
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
                        {explanation && <div className="proposed explanation"><b>{explanation.title}</b><Markdown source={explanation.body.trim()} /></div>}
                        {proposedMd && <div className="proposed"><b>Proposed changes</b><Markdown source={proposedMd} /></div>}
                        <div className="kv">
                            <b>Plan</b><span>{design.plan.length} layer(s): {design.plan.map((p) => p.layer).join(", ")}</span>
                            <b>Tests</b><span>{design.testPlan.reduce((n, t) => n + t.cases.length, 0)} case(s) in {design.testPlan.length} file(s)</span>
                            <b>QA</b><span>{design.qa.length ? `${design.qa.length} scenario(s)` : `none — ${design.qaSkippedReason ?? "no reason given"}`}</span>
                        </div>
                        <div className="actions"><button onClick={() => setTab("design")}>Open the full proposal</button></div>
                    </Card>
                ) : <div className="empty">no design yet</div>;
            case "qa_baseline":
            case "manual_qa":
                return qaPanel ?? <div className="empty">no QA evidence yet</div>;
            case "implementation":
                return impl ? (
                    <Card title="Implementation" badge={<span className={`chip ${impl.gates.tests && impl.gates.typecheck ? "ok" : "bad"}`}>tests {impl.gates.tests ? "✓" : "✗"} · typecheck {impl.gates.typecheck ? "✓" : "✗"}</span>}>
                        <div className="kv">
                            <b>Coverage (new lines)</b><span>{impl.coverageNewLines ?? "—"}%</span>
                            <b>Backend</b><span>{impl.tests.backend ?? "—"}</span>
                            <b>Frontend</b><span>{impl.tests.frontend ?? "—"}</span>
                            <b>Files</b><span>{impl.files.map((f) => <code key={f} style={{ marginRight: 8 }}>{f}</code>)}</span>
                            <b>Commits</b><span>{impl.commits.length ? impl.commits.map((c) => <div key={c}><code>{c}</code></div>) : "none (uncommitted changes)"}</span>
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
                return <PrDraftTabs detail={detail} onAction={onAction} />;
            case "pr_waiting":
                return (
                    <>
                        {task.stage === "pr_fix" && reviewBox}
                        {task.stage === "pr_fix" && prFix?.summary && <Card title="Proposed fix"><Markdown source={prFix.summary} /><div className="actions"><button onClick={() => setTab("code")}>Open Code changes to review the diff</button></div></Card>}
                        <PrPanel detail={detail} onAction={onAction} />
                    </>
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
                <button onClick={() => onAction(() => api.pin(task.id))}>{task.pinned ? "Unpin" : "Pin"}</button>
                {terminal ? <button onClick={onCloseTerminal}>Close terminal</button> : <button disabled={task.status === "running"} onClick={onOpenTerminal}>Open terminal</button>}
                {task.status !== "running" && currentIdx > 0 && <button onClick={() => setReturning((v) => !v)} title="Send the task back to an earlier stage with notes (e.g. after an accidental Approve)">{returning ? "Cancel return" : "Return to a stage…"}</button>}
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
                    onSend={async (stage, text, withComments) => {
                        await onAction(async () => {
                            await api.returnTo(task.id, { stage, ...(text.trim() ? { notes: text } : {}), ...(withComments ? { comments: pending.map(([, c]) => c) } : {}) });
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
                        <ServicesPanel taskId={task.id} env={env} onError={onError} />
                    </section>
                ) : (
                    <section className="card widget"><h2>App</h2><div className="empty">no worktree yet</div></section>
                )}
                <PrWidget detail={detail} onAction={onAction} />
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

            {asking && task.status === "waiting_user" && (
                <QuestionsBox round={asking} onSend={(answers) => onAction(() => api.answerQuestions(task.id, asking.id, answers))} />
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
                                {PR_STAGES.has(s) ? "Pull request" : STAGE_LABEL[s]}{s === task.stage ? " ·" : ""}
                            </button>
                        ))}
                    </div>
                    {task.status === "running" && stepKey(step) === stepKey(task.stage) && (
                        <Card title="Live">
                            <div className="feed">{feed.length === 0 ? <div className="k">waiting for events…</div> : feed.slice(-40).map((l, i) => <div key={i}>{l}</div>)}</div>
                        </Card>
                    )}
                    {waiting && stepKey(step) !== stepKey(task.stage) && task.stage !== "pr_creation_review" && task.stage !== "user_review" && reviewBox}
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
                                <span>{STAGE_LABEL[r.stage]} <small style={{ color: "var(--ink-3)" }}>#{r.attempt}</small></span>
                                {statusChip(r.status)}
                                <span className={r.error ? "err" : ""}>{r.error ?? r.last_event ?? ""}</span>
                                <span className="mono" style={{ color: "var(--ink-3)" }}>{r.num_turns ? `${r.num_turns} turns` : ""}{r.cost_usd ? ` · $${r.cost_usd.toFixed(2)}` : ""}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            )}

            {tab === "design" && (
                design ? (
                    <Card title="Design proposal" badge={<><span className={`chip ${design.classification === "bug" ? "bad" : "accent"}`}>{design.classification}</span>{(design.affectedRepos ?? []).map((r) => <span key={r} className="chip">{r}</span>)}</>}>
                        {task.stage === "design_proposal" && reviewBox}
                        <DesignSections design={design} md={designMd} />
                    </Card>
                ) : <div className="empty">No design proposal yet.</div>
            )}

            {tab === "code" && (
                task.branch && task.worktree_path ? (
                    <Card title="Code changes" badge={pending.length > 0 ? <span className="chip wait">{pending.length} 💬</span> : undefined}>
                        {canComment && <p className="field-hint">Tap a line to leave a comment; send them from the PR comments tab or the review box.</p>}
                        <DiffView taskId={task.id} refreshKey={task.updated_at} comments={comments} prior={prior} canComment={canComment} onChange={changeComment} />
                    </Card>
                ) : <div className="empty">No branch yet.</div>
            )}

            {tab === "comments" && (
                <>
                    {prdRepos.length > 1 && (
                        <div className="subtabs pr-repo-tabs">
                            {prdRepos.map((r, i) => <button key={r} className={`${ghRepo === r ? "active" : ""} repo-${REPO_COLORS[i % REPO_COLORS.length]}`} onClick={() => setGhRepo(r)}>{repoName(r)} <span className="chip">#{prStateOf(detail, r)?.number}</span></button>)}
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
                                        Draft line comments (sent with the next "Request changes" in User Review):
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
                                    <b>{selectedComments.size} comment(s) picked.</b> The agent addresses just these, commits locally, and you review the diff before it's pushed — no re-run of QA or User Review.
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

            {tab === "chat" && <Chat taskId={task.id} messages={detail.messages ?? []} status={task.status} onSent={async () => onAction(async () => undefined)} />}

            {tab === "ticket" && (
                <>
                    <NotesCard detail={detail} onSave={(text) => onAction(() => api.patchTask(task.id, { notes: text.trim() || null }))} />
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
    const reviewing = task.stage === "pr_creation_review" && task.status === "waiting_user";
    const editable = task.status !== "running" && !created;
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(entry.title);
    const [body, setBody] = useState(entry.body);
    const [base, setBase] = useState(pr?.base ?? "");
    const [saving, setSaving] = useState(false);
    const [notes, setNotes] = useState("");
    const [changes, setChanges] = useState(false);
    useEffect(() => {
        if (!editing) {
            setTitle(entry.title);
            setBody(entry.body);
            setBase(pr?.base ?? "");
        }
    }, [entry.title, entry.body, pr?.base, editing]);
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
                    <Markdown source={entry.body} />
                </>
            )}
            {editing && (
                <div className="pr-editor">
                    <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
                    <label>Base branch (shared by every repository) <input value={base} onChange={(e) => setBase(e.target.value)} style={{ maxWidth: 220 }} /></label>
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
                            <textarea placeholder={`What should change in the ${repoName(entry.repo)} description (required)`} value={notes} onChange={(e) => setNotes(e.target.value)} />
                            <div className="actions" style={{ marginBottom: 0 }}>
                                <button className="primary" disabled={!notes.trim()} onClick={() => onAction(async () => { await api.review(task.id, { verdict: "changes", repo: entry.repo, notes }); setNotes(""); setChanges(false); })}>Send back to the drafting agent</button>
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
const PrDraftTabs = ({ detail, onAction }: { detail: TaskDetail; onAction: Props["onAction"] }) => {
    const { task, pr } = detail;
    const drafts = pr?.drafts ?? [];
    const repos = drafts.map((d) => d.repo);
    const [active, setActive] = useState(0);
    useEffect(() => setActive(0), [task.id]);
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
                            <button key={d.repo} className={`${i === active ? "active" : ""} repo-${REPO_COLORS[i % REPO_COLORS.length]}`} onClick={() => setActive(i)}>
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

// Details for the PR stages, one card per repository: checks, review, merge — everything the poller stored.
const PrPanel = ({ detail, onAction }: { detail: TaskDetail; onAction: Props["onAction"] }) => {
    const { task } = detail;
    const repos = prRepos(detail);
    if (repos.length === 0) return <Card title="Pull request"><p>{task.status_line ?? "No pull request yet."}</p></Card>;
    return (
        <>
            {repos.map((repo) => {
                const row = prStateOf(detail, repo);
                const o = prOutcome(row);
                const checks = parseChecks(row?.checks_json);
                return (
                    <Card key={repo} title={<><RepoChip repo={repo} repos={repos} /> Pull request</>} badge={<span className={`chip ${o.cls}`}>{o.text}</span>}>
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
                );
            })}
        </>
    );
};

// design.md is split on its `## ` headings into subtabs; the structured plan / test plan / QA scenarios from design.json
// are merged into the subtab whose heading they belong to, so each section is read in one place.
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

const QaScenarios = ({ design }: { design: NonNullable<TaskDetail["design"]> }) => (
    <>
        {design.qa.length === 0 && <div className="quiet">none — {design.qaSkippedReason ?? "no reason given"}</div>}
        {design.qa.map((s) => (
            <details className="scenario" key={s.id} open>
                <summary>
                    <h3><span className="chip accent">{s.id}</span><span className="scenario-title">{s.title}</span> <code>{s.url}</code> <span className="chip persona">{s.persona}</span></h3>
                </summary>
                {s.seed && s.seed.length > 0 ? (
                    <div className="seed"><b>Seed</b><ul className="plain">{s.seed.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
                ) : (
                    <div className="seed quiet">Seed: nothing beyond a logged-in user</div>
                )}
                <ol style={{ margin: 0, paddingLeft: 20 }}>{s.steps.map((st, i) => <li key={i}>{st.action} → <i>{st.assert}</i> {st.shot && <span className="chip warn">shot</span>}</li>)}</ol>
            </details>
        ))}
    </>
);

const DesignSections = ({ design, md }: { design: NonNullable<TaskDetail["design"]>; md: string | null }) => {
    const parsed = useMemo(() => (md ? splitSections(md) : { intro: "", sections: [] }), [md]);
    // Structured data attaches to the matching markdown section; sections without a markdown twin still get a tab.
    type Part = { key: string; title: string; md?: string; extra?: React.ReactNode };
    const parts: Part[] = parsed.sections.map((s) => ({ key: s.title, title: s.title, md: s.body }));
    // `replace` drops the markdown twin when the structured view is a superset of it (QA scenarios carry title, url,
    // persona, seed and steps), so a section is never shown twice.
    const attach = (test: RegExp, title: string, extra: React.ReactNode, replace = false) => {
        const hit = parts.find((p) => test.test(p.title));
        if (hit) {
            hit.extra = extra;
            if (replace) delete hit.md;
        } else parts.push({ key: title, title, extra });
    };
    attach(/^technical changes|^change|implementation|plan by layer/i, "Plan by layer", (
        <table><tbody>{design.plan.map((p) => <tr key={p.layer}><td><code>{p.layer}</code></td><td><ul className="plain">{p.changes.map((c, i) => <li key={i}>{c}</li>)}</ul></td></tr>)}</tbody></table>
    ));
    // The Tests table in design.md already lists every case, so design.json's testPlan is not repeated here. A pre-template
    // `Run: \`cmd\`` line is shown as a code block like the current template's fenced one.
    const tests = parts.find((p) => /^tests?\b|test plan/i.test(p.title));
    if (tests?.md) tests.md = tests.md.replace(/^(\**Run:?\**)\s*`([^`\n]+)`\s*$/im, "$1\n\n```bash\n$2\n```");
    attach(/qa/i, "QA scenarios", <QaScenarios design={design} />, true);
    // Open on the explanation (Root cause / Approach) when the proposal has one; older proposals open on Proposed changes.
    const [active, setActive] = useState(() => {
        const i = parts.findIndex((p) => /^(root cause|approach)/i.test(p.title));
        return i >= 0 ? i : Math.max(0, parts.findIndex((p) => /^proposed changes/i.test(p.title)));
    });
    const cur = parts[Math.min(active, parts.length - 1)];
    return (
        <>
            {parsed.intro && <Markdown source={parsed.intro} />}
            <div className="subtabs">
                {parts.map((p, i) => <button key={p.key} className={i === active ? "active" : ""} onClick={() => setActive(i)}>{p.title}</button>)}
            </div>
            {cur && (
                <div className="design-section">
                    {cur.md && <Markdown source={cur.md} />}
                    {cur.extra && <div className="design-structured">{cur.extra}</div>}
                </div>
            )}
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
                            <span className="chip accent">{s.id}</span><span className="scenario-title">{s.title}</span> <span>before {chip(b?.outcome)}</span> <span>after {chip(a?.outcome)}</span>
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
