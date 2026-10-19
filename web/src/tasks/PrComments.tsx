import { Fragment, useEffect, useState } from "react";
import { Button, Checkbox, Chip, EmptyState, Icon, Notice } from "@vortex/ds";
import { anchorOf, filesOf, type LineComment, type Message, type MessageAnchor, type PrComment, type Review, type Stage } from "../api";
import { AgentInput, usePendingFiles } from "../AgentInput";
import { MessageFiles } from "../FilePicker";
import { Markdown } from "../Markdown";
import { Panel } from "../components/Panel";
import "./workspace.css";

export const isResolved = (c: PrComment): boolean => c.kind === "line" && c.resolved;

// The chat anchor of a thread under a GitHub PR comment: keyed by the comment id, carrying its position and text.
export const prCommentAnchor = (c: PrComment, repo: string, number: number): MessageAnchor => ({
    path: c.kind === "line" ? c.path : "",
    side: "new",
    line: c.kind === "line" ? (c.line ?? 0) : 0,
    snippet: c.body.trim().slice(0, 600) || (c.kind === "review" ? `Review: ${c.state.toLowerCase().replace("_", " ")}` : ""),
    prComment: { repo, number, id: c.id, author: c.author, url: c.url },
});

// A collapsible chat with the agent right under one PR comment: its earlier exchanges, a question box, the reply
// arrives through the task's messages (same thread key, see MessageAnchor.prComment).
const PrCommentThread = ({ items, canAsk, onAsk }: { items: Message[]; canAsk: boolean; onAsk: (text: string, files: File[]) => Promise<void> }) => {
    const pending = usePendingFiles();
    const [open, setOpen] = useState(items.length > 0);
    const [text, setText] = useState("");
    const [asking, setAsking] = useState(false);
    useEffect(() => {
        if (items.length > 0) setOpen(true);
    }, [items.length]);
    const send = async (): Promise<void> => {
        const t = text.trim();
        if (!t && pending.files.length === 0) return;
        setAsking(true);
        const sent = pending.files;
        try {
            await onAsk(t || "See the attached file(s).", sent);
            setText("");
            pending.clear();
        } finally {
            setAsking(false);
        }
    };
    return (
        <div className="pr-thread">
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Ask the agent about this comment: a chat, nothing is changed">
                <Icon name={open ? "chevronDown" : "chevronRight"} />Ask agent{items.length ? ` (${items.length})` : ""}
            </Button>
            {open && (
                <div className="line-thread flush">
                    {items.map((msg) => (
                        <div key={msg.id} className={`thread-msg ${msg.role}`}>
                            <div className="chat-msg-head">
                                <b>{msg.role === "user" ? "You" : "Agent"}</b>
                                <span className="field-hint">{new Date(msg.created_at).toLocaleString()}</span>
                            </div>
                            {msg.role === "agent" ? <Markdown source={msg.text} /> : <div>{msg.text}</div>}
                            <MessageFiles taskId={msg.task_id} files={filesOf(msg)} />
                        </div>
                    ))}
                    {asking && <div className="thread-msg agent pending">Agent is answering…</div>}
                    {canAsk && !asking && (
                        <>
                            <AgentInput
                                placeholder="Does this make sense? Is it already addressed? What would a fix take? (⌘/Ctrl+Enter sends)"
                                value={text}
                                onChange={setText}
                                pending={pending}
                                rows={2}
                                onKeyDown={(e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                        e.preventDefault();
                                        void send();
                                    }
                                }}
                            />
                            <div className="actions tight">
                                <Button variant="primary" disabled={!text.trim() && pending.files.length === 0} onClick={() => void send()}>Ask</Button>
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
export const PrCommentList = ({ title, items, loading, error, hasPr, url, fetchedAt, onRefresh, selected, onToggle, onResolve, repo, prNumber, threads, canAsk, onAsk }: { title: string; items: PrComment[] | null; loading: boolean; error: string | null; hasPr: boolean; url: string | null; fetchedAt: string | null; onRefresh: () => void; selected: Set<number>; onToggle: (id: number) => void; onResolve: (id: number, resolved: boolean) => Promise<void>; repo: string; prNumber: number | null; threads: Message[]; canAsk: boolean; onAsk: (anchor: MessageAnchor, text: string, files: File[]) => Promise<void> }) => {
    const [busy, setBusy] = useState<number | null>(null);
    const threadOf = (c: PrComment): Message[] => threads.filter((m) => { const a = anchorOf(m)?.prComment; return !!a && a.id === c.id && a.repo === repo; });
    const sorted = items ? [...items].sort((a, b) => Number(isResolved(a)) - Number(isResolved(b)) || a.at.localeCompare(b.at)) : [];
    const resolvedCount = items ? items.filter(isResolved).length : 0;
    return (
        <Panel title={title} badge={items ? <Chip>{items.length - resolvedCount} open{resolvedCount ? ` · ${resolvedCount} resolved` : ""}</Chip> : undefined}>
            {!hasPr && <EmptyState icon="inbox" title="No pull request yet">Comments appear here once it exists.</EmptyState>}
            {hasPr && (
                <div className="actions tight">
                    <Button size="sm" onClick={onRefresh} disabled={loading}><Icon name="refresh" />{loading ? "Loading…" : "Refresh"}</Button>
                    {url && <a href={url} target="_blank" rel="noreferrer">Open on GitHub</a>}
                    {fetchedAt && <span className="field-hint">fetched {new Date(fetchedAt).toLocaleTimeString()}</span>}
                </div>
            )}
            {error && <Notice tone="bad">{error}</Notice>}
            {items && items.length === 0 && <EmptyState icon="checkCircle" title="Nothing here" />}
            {items && items.length > 0 && (
                <div className="gh-comments">
                    {sorted.map((c, i) => (
                        <Fragment key={`${c.kind}-${c.id}`}>
                            {i > 0 && isResolved(c) && !isResolved(sorted[i - 1]!) && <div className="gh-sep">resolved</div>}
                            <div className={`gh-comment ${c.kind} ${selected.has(c.id) ? "picked" : ""} ${isResolved(c) ? "resolved" : ""}`}>
                                <div className="gh-head">
                                    <Checkbox aria-label="Pick this comment to send to the agent" title="Pick this comment to send to the agent" checked={selected.has(c.id)} onChange={() => onToggle(c.id)} />
                                    <b>{c.author}</b>
                                    {c.kind === "review" && <Chip tone={c.state === "APPROVED" ? "ok" : c.state === "CHANGES_REQUESTED" ? "bad" : "neutral"}>{c.state.toLowerCase().replace("_", " ")}</Chip>}
                                    {c.kind === "line" && <code>{c.path}{c.line !== null ? `:${c.line}` : ""}{c.outdated ? " (outdated)" : ""}</code>}
                                    {c.kind === "line" && c.replyTo !== null && <Chip>reply</Chip>}
                                    {c.kind === "line" && (c.resolved ? <Chip tone="ok">resolved</Chip> : <Chip tone="wait">open</Chip>)}
                                    {c.kind === "general" && <Chip>comment</Chip>}
                                    <span className="field-hint">{new Date(c.at).toLocaleString()}</span>
                                    <a href={c.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub"><Icon name="external" /></a>
                                    {c.kind === "line" && c.threadId && c.replyTo === null && (
                                        <Button size="sm" disabled={busy === c.id} title={c.resolved ? "Reopen this review thread on GitHub" : "Mark this review thread resolved on GitHub (as you)"} onClick={() => { setBusy(c.id); void onResolve(c.id, !c.resolved).finally(() => setBusy(null)); }}>
                                            {busy === c.id ? "…" : c.resolved ? "Reopen" : "Resolve"}
                                        </Button>
                                    )}
                                </div>
                                {c.body && <Markdown source={c.body} />}
                                {prNumber !== null && <PrCommentThread items={threadOf(c)} canAsk={canAsk} onAsk={(text, files) => onAsk(prCommentAnchor(c, repo, prNumber), text, files)} />}
                            </div>
                        </Fragment>
                    ))}
                </div>
            )}
        </Panel>
    );
};

export const parseComments = (r: Review): LineComment[] => {
    try {
        return r.comments ? (JSON.parse(r.comments) as LineComment[]) : [];
    } catch {
        return [];
    }
};

// Earlier rounds of this stage's review, so the reviewer can check what was asked before.
export const ReviewHistory = ({ reviews, stage }: { reviews: Review[]; stage: Stage }) => {
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
