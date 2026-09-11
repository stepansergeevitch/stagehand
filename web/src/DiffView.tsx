import { useEffect, useMemo, useRef, useState } from "react";
import { anchorOf, api, repoColorClass, repoName, type BranchCommit, type DiffFile, type DiffLine, type DiffResponse, type LineComment, type Message, type MessageAnchor } from "./api";
import { Markdown } from "./Markdown";
import { storage } from "./storage";

// A file belongs to a repository when its path is exactly that repo's directory or starts with "<repo>/".
const inRepo = (path: string, repo: string): boolean => !repo || path === repo || path.startsWith(`${repo}/`);

// Which slice of the branch the diff shows: everything vs the base (default, the only view that takes line comments),
// only what is uncommitted, or a hand-picked set of commits.
export type DiffFilter = { kind: "all" } | { kind: "uncommitted" } | { kind: "commits"; shas: string[] };

// Where the diff comes from: a task's worktree (the default) or a Sessions-page session's checkout.
export interface DiffSource {
    diff: (filter?: { shas: string[] } | { uncommitted: true }) => Promise<DiffResponse>;
    commits: () => Promise<{ commits: BranchCommit[]; uncommitted: boolean }>;
}
const taskSource = (taskId: string): DiffSource => ({ diff: (f) => api.diff(taskId, f), commits: () => api.commits(taskId) });
export const sessionSource = (sessionId: string): DiffSource => ({ diff: (f) => api.sessionDiff(sessionId, f), commits: () => api.sessionCommits(sessionId) });

// The branch's own commits (this task's work), with Change message (a fast, conflict-free metadata edit) and Remove
// (a real rewrite the agent performs, since replaying everything after the commit can hit conflicts) per commit, plus
// a force-push once history has been rewritten. Always shows the full branch, independent of the diff filter above.
const CommitManager = ({ taskId, repo, commits, busy: taskBusy, onError }: { taskId: string; repo: string; commits: BranchCommit[]; busy: boolean; onError: (m: string) => void }) => {
    const [editing, setEditing] = useState<string | null>(null);
    const [text, setText] = useState("");
    const [removing, setRemoving] = useState<string | null>(null);
    const [note, setNote] = useState("");
    const [started, setStarted] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState<string | null>(null);
    const [pushing, setPushing] = useState(false);
    const [pushed, setPushed] = useState<string | null>(null);
    if (commits.length === 0) return null;
    const disabled = taskBusy || busy !== null;
    const reword = async (sha: string) => {
        const message = text.trim();
        if (!message) return;
        setBusy(sha);
        try {
            await api.rewordCommit(taskId, sha, repo, message);
            setEditing(null);
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };
    const remove = async (sha: string) => {
        setBusy(sha);
        try {
            await api.removeCommit(taskId, sha, repo, note.trim() || undefined);
            setStarted((s) => new Set(s).add(sha));
            setNote("");
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };
    return (
        <div className="commit-manager">
            {commits.map((c) => (
                <div className="commit-row" key={c.sha}>
                    {editing === c.sha ? (
                        <div className="commit-edit">
                            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void reword(c.sha)} />
                            <div className="actions" style={{ margin: 0 }}>
                                <button className="primary" disabled={busy === c.sha || !text.trim()} onClick={() => void reword(c.sha)}>{busy === c.sha ? "Saving…" : "Save"}</button>
                                <button disabled={busy === c.sha} onClick={() => setEditing(null)}>Cancel</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <code className="commit-sha">{c.short}</code>
                            <span className="commit-subject">{c.subject}</span>
                            <small className="field-hint">{c.author} · {ago(c.at)} ago</small>
                            <span className="commit-actions">
                                <button className="tiny" disabled={disabled} onClick={() => { setEditing(c.sha); setText(c.subject); }}>Change message</button>
                                <button className="tiny danger" disabled={disabled} onClick={() => setRemoving(removing === c.sha ? null : c.sha)}>Remove</button>
                            </span>
                        </>
                    )}
                    {removing === c.sha && !started.has(c.sha) && (
                        <div className="commit-remove">
                            <p className="field-hint">Removes this commit from history entirely (not a revert) — the agent replays everything after it and resolves any conflicts, then re-runs tests. Nothing is pushed; you review the result and push it yourself.</p>
                            <textarea placeholder="Optional note for the agent: why remove it" value={note} onChange={(e) => setNote(e.target.value)} />
                            <div className="actions" style={{ margin: 0 }}>
                                <button className="danger" disabled={disabled} onClick={() => void remove(c.sha)}>{busy === c.sha ? "Starting…" : "Remove this commit"}</button>
                                <button disabled={disabled} onClick={() => { setRemoving(null); setNote(""); }}>Cancel</button>
                            </div>
                        </div>
                    )}
                    {started.has(c.sha) && (
                        <div className="commit-remove started">
                            Removing — the agent is replaying the branch without this commit; the result (and any conflicts it hit) will appear in Chat.
                            <button className="tiny" onClick={() => { setRemoving(null); setStarted((s) => { const n = new Set(s); n.delete(c.sha); return n; }); }}>Dismiss</button>
                        </div>
                    )}
                </div>
            ))}
            <div className="actions" style={{ margin: "8px 0 0" }}>
                <button
                    disabled={disabled || pushing}
                    title="Push the branch with --force-with-lease — needed after Change message or Remove rewrite the history GitHub already has"
                    onClick={() => {
                        if (!confirm(`Force-push ${repoName(repo)} (--force-with-lease)? This updates the PR (if one exists) to the rewritten history.`)) return;
                        setPushing(true);
                        setPushed(null);
                        const done = (r: { result: string }) => setPushed(`${r.result} — the PR (if any) now has this history; its checks start over`);
                        void api
                            .forcePush(taskId, repo)
                            .then(done)
                            .catch(async (e: Error) => {
                                if (/force-pushing discards them/.test(e.message) && confirm(`${e.message}\n\nDiscard them and force-push anyway?`)) {
                                    await api.forcePush(taskId, repo, true).then(done).catch((e2: Error) => onError(e2.message));
                                    return;
                                }
                                onError(e.message);
                            })
                            .finally(() => setPushing(false));
                    }}
                >
                    {pushing ? "Pushing…" : "Force-push rewritten history"}
                </button>
                {pushed && <span className="field-hint" style={{ marginLeft: 8 }}>{pushed}</span>}
            </div>
        </div>
    );
};

const ago = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
};

// A dropdown over the branch's commits: tick any number of them (newest first), or switch to all / uncommitted.
const CommitPicker = ({ commits, uncommitted, filter, onChange }: { commits: BranchCommit[]; uncommitted: boolean; filter: DiffFilter; onChange: (f: DiffFilter) => void }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const picked = new Set(filter.kind === "commits" ? filter.shas : []);
    const toggle = (sha: string) => {
        const next = new Set(picked);
        next.has(sha) ? next.delete(sha) : next.add(sha);
        onChange(next.size === 0 ? { kind: "all" } : { kind: "commits", shas: [...next] });
    };
    const label = filter.kind === "all" ? "All changes" : filter.kind === "uncommitted" ? "Uncommitted only" : `${picked.size} commit${picked.size === 1 ? "" : "s"}`;
    const multiRepo = commits.some((c) => c.repo);
    return (
        <div className="commit-picker" ref={ref}>
            <button className={filter.kind === "all" ? "" : "on"} onClick={() => setOpen((v) => !v)} title="Show the diff of specific commits">{label} ▾</button>
            {open && (
                <div className="commit-menu">
                    <label className="inline commit-row"><input type="radio" checked={filter.kind === "all"} onChange={() => onChange({ kind: "all" })} /> <span>All changes vs base</span></label>
                    <label className="inline commit-row"><input type="radio" checked={filter.kind === "uncommitted"} onChange={() => onChange({ kind: "uncommitted" })} disabled={!uncommitted} /> <span>Uncommitted only{uncommitted ? "" : " (nothing uncommitted)"}</span></label>
                    <div className="commit-menu-head">Commits on the branch · newest first · tick any</div>
                    {commits.length === 0 && <div className="quiet">no commits yet</div>}
                    {commits.map((c) => (
                        <label key={c.sha} className={`inline commit-row ${picked.has(c.sha) ? "picked" : ""}`}>
                            <input type="checkbox" checked={picked.has(c.sha)} onChange={() => toggle(c.sha)} />
                            <span className="commit-text"><code>{c.short}</code> {c.subject}<small>{multiRepo && c.repo ? `${c.repo} · ` : ""}{c.author} · {ago(c.at)} ago</small></span>
                        </label>
                    ))}
                    {picked.size > 0 && <div className="actions" style={{ margin: "6px 0 0" }}><button onClick={() => onChange({ kind: "all" })}>Clear</button><button className="primary" onClick={() => setOpen(false)}>Show {picked.size}</button></div>}
                </div>
            )}
        </div>
    );
};

// Tap a line → write a comment anchored to it. Drafts live in localStorage until the review is sent.
export const commentKey = (c: Pick<LineComment, "path" | "side" | "line">): string => `${c.path}:${c.side}:${c.line}`;

const lineAnchor = (path: string, l: DiffLine): Pick<LineComment, "path" | "side" | "line"> =>
    l.type === "del" ? { path, side: "old", line: l.oldNo ?? 0 } : { path, side: "new", line: l.newNo ?? 0 };

// One editor for both things a line takes: a review comment (Save — kept as a draft until the review is sent) and a
// question for the agent (Ask — sent right away, answered in place). Either button is offered only when allowed.
const CommentEditor = ({ initial, placeholder, onSave, onAsk, onCancel, onDelete }: { initial: string; placeholder: string; onSave?: (t: string) => void; onAsk?: (t: string) => void; onCancel: () => void; onDelete?: () => void }) => {
    const [text, setText] = useState(initial);
    return (
        <div className="line-comment editing">
            <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={placeholder}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) (onSave ?? onAsk)?.(text.trim());
                }}
            />
            <div className="actions">
                {onSave && <button className="primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>Save comment</button>}
                {onAsk && <button className={onSave ? "" : "primary"} disabled={!text.trim()} title="Ask the task's agent about this line; the answer appears here and in Chat" onClick={() => onAsk(text.trim())}>Ask agent</button>}
                <button onClick={onCancel}>Cancel</button>
                {onDelete && <button className="danger" onClick={onDelete}>Delete</button>}
            </div>
        </div>
    );
};

// round > 0 = an earlier Stagehand review round; round 0 = a comment on the GitHub PR (author in `by`).
export interface PriorComment extends LineComment {
    round: number;
    by?: string;
    // GitHub review threads only: the thread was marked resolved.
    resolved?: boolean;
}
const roundLabel = (p: PriorComment): string => (p.round > 0 ? `R${p.round}` : `PR${p.by ? ` · ${p.by}` : ""}${p.resolved ? " · resolved" : ""}`);

// Where something anchored to a line (an earlier round's comment, a chat thread) sits in the current diff. Lines move
// as the branch evolves, so match by the quoted line text (nearest to the original line number) rather than by number
// alone; unmatched ones are "outdated", like GitHub.
const placeAnchored = <T extends MessageAnchor>(file: DiffFile, items: T[]): { byKey: Record<string, T[]>; outdated: T[] } => {
    const byKey: Record<string, T[]> = {};
    const outdated: T[] = [];
    const lines = file.hunks.flatMap((h) => h.lines);
    for (const c of items.filter((p) => p.path === file.path)) {
        const want = c.snippet.trim();
        const candidates = lines.filter((l) => l.text.trim() === want && (c.side === "old" ? l.type === "del" : l.type !== "del"));
        const best = candidates.sort((a, b) => Math.abs((a.newNo ?? a.oldNo ?? 0) - c.line) - Math.abs((b.newNo ?? b.oldNo ?? 0) - c.line))[0];
        if (!best) {
            outdated.push(c);
            continue;
        }
        const key = commentKey(lineAnchor(file.path, best));
        (byKey[key] ??= []).push(c);
    }
    return { byKey, outdated };
};

// A chat message with its anchor unpacked, for placement.
interface ThreadMessage extends MessageAnchor {
    msg: Message;
}
const threadMessages = (messages: Message[]): ThreadMessage[] =>
    messages.flatMap((msg) => {
        const a = anchorOf(msg);
        return a ? [{ ...a, msg }] : [];
    });

const LineThread = ({ items, asking, canAsk, onReply }: { items: ThreadMessage[]; asking: boolean; canAsk: boolean; onReply: () => void }) => (
    <div className="line-thread">
        {items.map(({ msg }) => (
            <div key={msg.id} className={`thread-msg ${msg.role}`}>
                <div className="chat-msg-head">
                    <b>{msg.role === "user" ? "You" : "Agent"}</b>
                    <span className="field-hint">{new Date(msg.created_at).toLocaleString()}</span>
                </div>
                {msg.role === "agent" ? <Markdown source={msg.text} /> : <div>{msg.text}</div>}
            </div>
        ))}
        {asking && <div className="thread-msg agent pending">Agent is answering…</div>}
        {canAsk && !asking && <button className="tiny" onClick={onReply}>Reply</button>}
    </div>
);

const FileDiff = ({
    file,
    comments,
    prior,
    threads,
    canComment,
    canAsk,
    onChange,
    onAsk,
}: {
    file: DiffFile;
    comments: Record<string, LineComment>;
    prior: PriorComment[];
    threads: ThreadMessage[];
    canComment: boolean;
    canAsk: boolean;
    onChange: (key: string, c: LineComment | null) => void;
    onAsk: (anchor: MessageAnchor, text: string) => Promise<void>;
}) => {
    const [editing, setEditing] = useState<string | null>(null);
    // Lines whose question is out with the agent right now (the reply arrives through the messages list).
    const [asking, setAsking] = useState<Set<string>>(new Set());
    const count = Object.values(comments).filter((c) => c.path === file.path).length;
    const placed = useMemo(() => placeAnchored(file, prior), [file, prior]);
    const placedThreads = useMemo(() => placeAnchored(file, threads), [file, threads]);
    const priorCount = prior.filter((p) => p.path === file.path).length;
    const threadCount = Object.keys(placedThreads.byKey).length + placedThreads.outdated.length;
    const interactive = canComment || canAsk;
    const ask = async (key: string, anchor: MessageAnchor, text: string) => {
        setEditing(null);
        setAsking((s) => new Set(s).add(key));
        try {
            await onAsk(anchor, text);
        } finally {
            setAsking((s) => { const n = new Set(s); n.delete(key); return n; });
        }
    };
    return (
        <details className="diff-file" open={file.hunks.length > 0 && file.additions + file.deletions <= 400}>
            <summary>
                <span className={`chip ${file.status === "added" ? "ok" : file.status === "deleted" ? "bad" : ""}`}>{file.status}</span>
                <code className="path">{file.path}</code>
                <span className="mono stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
                {count > 0 && <span className="chip wait">{count} 💬</span>}
                {priorCount > 0 && <span className="chip" title="comments from earlier review rounds">{priorCount} earlier</span>}
                {threadCount > 0 && <span className="chip accent" title="questions asked to the agent on lines of this file">{threadCount} Q&amp;A</span>}
            </summary>
            {file.binary && <div className="empty">binary file</div>}
            {(placed.outdated.length > 0 || placedThreads.outdated.length > 0) && (
                <div className="outdated">
                    {placed.outdated.map((c, i) => (
                        <div key={i} className="line-comment prior outdated-item">
                            <b>{roundLabel(c)}</b> <span className="chip">outdated</span> <code>:{c.line}</code> <code className="snippet">{c.snippet.trim().slice(0, 80)}</code>
                            <div>{c.text}</div>
                        </div>
                    ))}
                    {placedThreads.outdated.map((t) => (
                        <div key={t.msg.id} className="line-comment prior outdated-item">
                            <b>{t.msg.role === "user" ? "You" : "Agent"}</b> <span className="chip">line changed since</span> <code>:{t.line}</code> <code className="snippet">{t.snippet.trim().slice(0, 80)}</code>
                            <div>{t.msg.text}</div>
                        </div>
                    ))}
                </div>
            )}
            {file.hunks.map((h, hi) => (
                <div className="hunk" key={hi}>
                    <div className="hunk-header mono">{h.header}</div>
                    {h.lines.map((l, li) => {
                        const anchor = lineAnchor(file.path, l);
                        const key = commentKey(anchor);
                        const existing = comments[key];
                        const thread = placedThreads.byKey[key];
                        const fullAnchor: MessageAnchor = { ...anchor, snippet: l.text };
                        return (
                            <div key={li}>
                                <div
                                    className={`dl ${l.type} ${existing ? "has-comment" : ""} ${placed.byKey[key] ? "has-prior" : ""} ${thread ? "has-thread" : ""} ${interactive ? "clickable" : ""}`}
                                    onClick={() => interactive && setEditing(editing === key ? null : key)}
                                    title={interactive ? (canComment ? "Tap to comment on, or ask about, this line" : "Tap to ask the agent about this line") : undefined}
                                >
                                    <span className="no">{l.oldNo ?? ""}</span>
                                    <span className="no">{l.newNo ?? ""}</span>
                                    <span className="mark">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                                    <span className="txt">{l.text || " "}</span>
                                </div>
                                {placed.byKey[key]?.map((p, pi) => (
                                    <div key={pi} className={`line-comment prior ${p.resolved ? "resolved" : ""}`} title={p.round > 0 ? `review round ${p.round}` : `GitHub PR comment by ${p.by ?? "?"}${p.resolved ? " (resolved)" : ""}`}>
                                        <b>{roundLabel(p)}</b> {p.text}
                                    </div>
                                ))}
                                {(thread || asking.has(key)) && <LineThread items={thread ?? []} asking={asking.has(key)} canAsk={canAsk} onReply={() => setEditing(key)} />}
                                {existing && editing !== key && (
                                    <div className="line-comment" onClick={() => canComment && setEditing(key)}>
                                        <b>💬</b> {existing.text}
                                    </div>
                                )}
                                {editing === key && (
                                    <CommentEditor
                                        initial={existing?.text ?? ""}
                                        placeholder={canComment && canAsk ? "What should change here? — or a question for the agent (⌘/Ctrl+Enter saves the comment)" : canComment ? "What should change here?" : "Ask the agent about this line…"}
                                        {...(canComment ? { onSave: (text: string) => { onChange(key, { ...anchor, snippet: l.text, text }); setEditing(null); } } : {})}
                                        {...(canAsk ? { onAsk: (text: string) => void ask(key, fullAnchor, text) } : {})}
                                        onCancel={() => setEditing(null)}
                                        {...(existing && canComment ? { onDelete: () => { onChange(key, null); setEditing(null); } } : {})}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
            ))}
        </details>
    );
};

export const useDraftComments = (taskId: string): [Record<string, LineComment>, (key: string, c: LineComment | null) => void, () => void] => {
    const storageKey = `stagehand.review.${taskId}`;
    const [comments, setComments] = useState<Record<string, LineComment>>(() => {
        try {
            return JSON.parse(storage.get(storageKey) ?? "{}") as Record<string, LineComment>;
        } catch {
            return {};
        }
    });
    useEffect(() => {
        try {
            storage.set(storageKey, JSON.stringify(comments));
        } catch {
            /* storage unavailable */
        }
    }, [comments, storageKey]);
    const change = (key: string, c: LineComment | null) =>
        setComments((prev) => {
            const next = { ...prev };
            if (c) next[key] = c;
            else delete next[key];
            return next;
        });
    const clear = () => setComments({});
    return [comments, change, clear];
};

export const DiffView = ({
    taskId,
    source,
    refreshKey,
    comments = {},
    prior = [],
    threads = [],
    canComment = false,
    canAsk = false,
    onChange = () => undefined,
    onAsk = async () => undefined,
    repos = [],
    taskBusy = false,
    onError = () => undefined,
}: {
    // A task's diff (with the commit manager) …
    taskId?: string;
    // … or any other checkout's (a Sessions-page session); one of the two is required.
    source?: DiffSource;
    refreshKey: string;
    comments?: Record<string, LineComment>;
    prior?: PriorComment[];
    // Chat messages anchored to diff lines — shown as threads under the lines they quote.
    threads?: Message[];
    canComment?: boolean;
    canAsk?: boolean;
    onChange?: (key: string, c: LineComment | null) => void;
    onAsk?: (anchor: MessageAnchor, text: string) => Promise<void>;
    // The env's sub-repository directories, for a repo-tabbed view; [] shows the single repo with no tabs.
    repos?: string[];
    // A stage/agent run already owns the worktree — disables Change message / Remove / force-push until it's done.
    taskBusy?: boolean;
    onError?: (m: string) => void;
}) => {
    const src = useMemo(() => source ?? taskSource(taskId ?? ""), [source, taskId]);
    const [diff, setDiff] = useState<DiffResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<DiffFilter>({ kind: "all" });
    const [branch, setBranch] = useState<{ commits: BranchCommit[]; uncommitted: boolean }>({ commits: [], uncommitted: false });
    const [activeRepo, setActiveRepo] = useState(repos[0] ?? "");
    const repo = repos.includes(activeRepo) ? activeRepo : (repos[0] ?? "");
    const scope = taskId ?? source;
    useEffect(() => {
        setFilter({ kind: "all" });
        setActiveRepo(repos[0] ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope]);
    useEffect(() => {
        void src.commits().then(setBranch).catch(() => undefined);
    }, [src, refreshKey]);
    useEffect(() => {
        setDiff(null);
        setError(null);
        const f = filter.kind === "all" ? undefined : filter.kind === "uncommitted" ? { uncommitted: true as const } : { shas: filter.shas };
        void src.diff(f).then(setDiff).catch((e: Error) => setError(e.message));
    }, [src, refreshKey, filter]);
    const threadItems = useMemo(() => threadMessages(threads), [threads]);
    // The commit picker only offers this repository's commits — its shas mean nothing in another checkout.
    const repoCommits = branch.commits.filter((c) => c.repo === repo);
    // Line comments anchor to line numbers of the full diff (the current file); a commit slice numbers lines differently.
    // Questions match by the line's text, so they work in any view.
    const commentsOn = canComment && filter.kind === "all";
    const picker = <CommitPicker commits={repoCommits} uncommitted={branch.uncommitted} filter={filter} onChange={setFilter} />;
    const tabs = repos.length > 1 && (
        <div className="subtabs pr-repo-tabs">
            {repos.map((r) => (
                <button key={r} className={`${r === repo ? "active" : ""} repo-${repoColorClass(r, repos)}`} onClick={() => { setActiveRepo(r); setFilter({ kind: "all" }); }}>{repoName(r)}</button>
            ))}
        </div>
    );
    const commitPanel = taskId && repoCommits.length > 0 && (
        <details className="commit-panel">
            <summary>Commits ({repoCommits.length}) — rename, remove, force-push</summary>
            <CommitManager taskId={taskId} repo={repo} commits={repoCommits} busy={taskBusy} onError={onError} />
        </details>
    );
    if (error) return <>{tabs}{commitPanel}<div className="blocked-box">diff: {error}</div></>;
    if (!diff) return <>{tabs}{commitPanel}<div className="diff"><div className="diff-summary mono">{picker} loading diff…</div></div></>;
    const files = diff.files.filter((f) => inRepo(f.path, repo));
    const groups = diff.groups.map((g) => ({ ...g, files: g.files.filter((f) => inRepo(f.path, repo)) })).filter((g) => g.files.length > 0);
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    return (
        <>
            {tabs}
            {commitPanel}
            <div className="diff">
                <div className="diff-summary mono">
                    {picker}
                    {files.length} file{files.length === 1 ? "" : "s"}{diff.filtered ? "" : ` vs origin/${diff.base}`} · <span className="add">+{adds}</span> <span className="del">−{dels}</span>
                    {commentsOn && <span className="hint"> · tap a line to comment{canAsk ? " or ask" : ""}</span>}
                    {!commentsOn && canAsk && <span className="hint"> · tap a line to ask the agent about it</span>}
                    {canComment && !commentsOn && <span className="hint"> · switch to All changes to comment on lines</span>}
                </div>
                {files.length === 0 && <div className="empty">{diff.filtered ? "Nothing in this selection." : `No changes against ${diff.base} yet.`}</div>}
                {!diff.filtered && (() => {
                    const known = new Set(files.map((f) => f.path));
                    const gone = prior.filter((p) => inRepo(p.path, repo) && !known.has(p.path));
                    return gone.length > 0 ? (
                        <div className="outdated">
                            {gone.map((c, i) => (
                                <div key={i} className="line-comment prior outdated-item">
                                    <b>{roundLabel(c)}</b> <span className="chip">file no longer changed</span> <code>{c.path}:{c.line}</code>
                                    <div>{c.text}</div>
                                </div>
                            ))}
                        </div>
                    ) : null;
                })()}
                {groups.map((g, gi) => (
                    <div key={gi} className="diff-group">
                        {diff.filtered && groups.length > 1 && <div className="diff-group-head mono">{g.label} · {g.files.length} file{g.files.length === 1 ? "" : "s"}</div>}
                        {g.files.map((f) => (
                            <FileDiff key={`${gi}:${f.path}`} file={f} comments={comments} prior={diff.filtered ? [] : prior} threads={threadItems} canComment={commentsOn} canAsk={canAsk} onChange={onChange} onAsk={onAsk} />
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
};
