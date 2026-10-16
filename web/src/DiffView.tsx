import { useEffect, useMemo, useRef, useState } from "react";
import { anchorOf, api, repoColorClass, repoName, type BranchCommit, type DiffFile, type DiffLine, type DiffResponse, type FileReviewState, type LineComment, type Message, type MessageAnchor } from "./api";
import { Markdown } from "./Markdown";
import { storage } from "./storage";
import type { CodeScope, DiffRoute } from "./routes";
import { AgentInput, usePendingFiles } from "./AgentInput";
import { CommentEditor } from "./components/CommentEditor";
import { LineThread, threadMessages, type ThreadMessage } from "./components/LineThread";

// A test file by the common conventions of any stack: a tests / __tests__ / spec directory, test_*.py / *_test.py,
// *.test.* / *.spec.*, *_test.go, *Test.java / *Tests.cs, conftest.py.
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)\//i;
const TEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test\.[a-z0-9]+|[^/]+\.(test|spec)\.[a-z0-9]+|[^/]+(Test|Tests)\.(java|kt|cs|scala)|conftest\.py)$/;
export const isTestFile = (path: string): boolean => TEST_DIR.test(path) || TEST_FILE.test(path);

// A file belongs to a repository when its path is exactly that repo's directory or starts with "<repo>/".
const inRepo = (path: string, repo: string): boolean => !repo || path === repo || path.startsWith(`${repo}/`);

// Which slice of the branch the diff shows: everything vs the base (default, the only view that takes line comments),
// only what is uncommitted, or a hand-picked set of commits.
export type DiffFilter = CodeScope;

// Where the diff comes from: a task's worktree (the default) or a Sessions-page session's checkout.
export interface DiffSource {
    // `file`: one path in full — how a collapsed (generated / very large) file's hunks are fetched on request.
    diff: (filter?: { shas: string[] } | { uncommitted: true }, file?: string) => Promise<DiffResponse>;
    commits: () => Promise<{ commits: BranchCommit[]; uncommitted: boolean; dirty?: string[] }>;
}
const taskSource = (taskId: string): DiffSource => ({ diff: (f, file) => api.diff(taskId, f, file), commits: () => api.commits(taskId) });
export const sessionSource = (sessionId: string): DiffSource => ({ diff: (f, file) => api.sessionDiff(sessionId, f, file), commits: () => api.sessionCommits(sessionId) });

const ago = (iso: string): string => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
};

// The branch's commits, one list: tick any number of them, then View shows their diff, or (a task) Delete removes them
// from history in one agent run (a real rewrite: everything after them is replayed, conflicts resolved, tests re-run;
// nothing is pushed). Change message is a conflict-free metadata edit per commit; Force-push publishes a rewritten
// history. All changes / Uncommitted switch the diff back.
const CommitList = ({ taskId, repo, commits, uncommitted, filter, onFilter, busy: taskBusy, onError }: {
    taskId?: string;
    repo: string;
    commits: BranchCommit[];
    uncommitted: boolean;
    filter: DiffFilter;
    onFilter: (f: DiffFilter) => void;
    busy: boolean;
    onError: (m: string) => void;
}) => {
    const shown = filter.kind === "commits" ? filter.shas : [];
    const [picked, setPicked] = useState<Set<string>>(() => new Set(shown));
    useEffect(() => setPicked(new Set(filter.kind === "commits" ? filter.shas : [])), [filter.kind === "commits" ? filter.shas.join(",") : filter.kind]); // eslint-disable-line react-hooks/exhaustive-deps
    const [editing, setEditing] = useState<string | null>(null);
    const [text, setText] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [squashing, setSquashing] = useState<string | null>(null);
    const [note, setNote] = useState("");
    const attach = usePendingFiles();
    const [started, setStarted] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [pushed, setPushed] = useState<string | null>(null);
    const disabled = taskBusy || busy !== null;
    const toggle = (sha: string) => setPicked((p) => {
        const n = new Set(p);
        if (n.has(sha)) n.delete(sha);
        else n.add(sha);
        return n;
    });
    const sel = commits.filter((c) => picked.has(c.sha));
    const allPicked = commits.length > 0 && sel.length === commits.length;
    const run = async (key: string, fn: () => Promise<void>) => {
        setBusy(key);
        try {
            await fn();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setBusy(null);
        }
    };
    const reword = (sha: string) => run(sha, async () => {
        if (!taskId || !text.trim()) return;
        await api.rewordCommit(taskId, sha, repo, text.trim());
        setEditing(null);
    });
    // Squash: only a consecutive run (the server checks it too); the list is newest first, so picked rows must be
    // adjacent in it. The message defaults to the oldest picked commit's.
    const idx = sel.map((c) => commits.indexOf(c));
    const consecutive = sel.length >= 2 && Math.max(...idx) - Math.min(...idx) === sel.length - 1;
    const oldestPicked = sel.reduce<BranchCommit | undefined>((o, c) => (!o || commits.indexOf(c) > commits.indexOf(o) ? c : o), undefined);
    const squash = () => run("squash", async () => {
        if (!taskId || !squashing?.trim() || !consecutive) return;
        await api.squashCommits(taskId, sel.map((c) => c.sha), repo, squashing.trim());
        setSquashing(null);
        setPicked(new Set());
        if (filter.kind === "commits") onFilter({ kind: "all" });
    });
    const remove = () => run("delete", async () => {
        if (!taskId || !sel.length) return;
        await api.removeCommits(taskId, sel.map((c) => c.sha), repo, note.trim() || undefined, await api.uploadFiles(taskId, attach.files));
        setStarted(sel.length === 1 ? `commit ${sel[0]!.short}` : `${sel.length} commits`);
        setDeleting(false);
        setNote("");
        attach.clear();
        setPicked(new Set());
    });
    const forcePush = () => {
        if (!taskId || !confirm(`Force-push ${repoName(repo)} (--force-with-lease)? This updates the PR (if one exists) to the rewritten history.`)) return;
        setPushed(null);
        const done = (r: { result: string }) => setPushed(`${r.result} — the PR (if any) now has this history; its checks start over`);
        void run("push", async () => {
            await api.forcePush(taskId, repo).then(done).catch(async (e: Error) => {
                if (/force-pushing discards them/.test(e.message) && confirm(`${e.message}\n\nDiscard them and force-push anyway?`)) {
                    await api.forcePush(taskId, repo, true).then(done);
                    return;
                }
                throw e;
            });
        });
    };
    const label = filter.kind === "all" ? "all changes vs base" : filter.kind === "uncommitted" ? "uncommitted changes only" : `${shown.length} commit${shown.length === 1 ? "" : "s"}`;
    return (
        <details className="commit-panel" open={filter.kind === "commits" || undefined}>
            <summary>Commits ({commits.length}) · showing {label}</summary>
            <div className="commit-list">
                <div className="commit-toolbar">
                    <label className="inline"><input type="checkbox" checked={allPicked} disabled={!commits.length} onChange={() => setPicked(allPicked ? new Set() : new Set(commits.map((c) => c.sha)))} /> {sel.length ? `${sel.length} picked` : "Pick commits"}</label>
                    <button className="primary tiny" disabled={!sel.length} onClick={() => onFilter({ kind: "commits", shas: sel.map((c) => c.sha) })}>View{sel.length ? ` ${sel.length}` : ""}</button>
                    <button className="tiny" disabled={filter.kind === "all"} onClick={() => onFilter({ kind: "all" })}>All changes</button>
                    <button className="tiny" disabled={!uncommitted || filter.kind === "uncommitted"} onClick={() => onFilter({ kind: "uncommitted" })}>Uncommitted only</button>
                    {taskId && (
                        <>
                            <span className="dt-spacer" />
                            <button className="tiny" disabled={disabled || !consecutive} title={sel.length >= 2 && !consecutive ? "only consecutive commits can be squashed" : "Squash the picked consecutive commits into one (files end exactly as they are; nothing is pushed)"} onClick={() => setSquashing((v) => (v === null ? oldestPicked?.subject ?? "" : null))}>Squash{consecutive ? ` ${sel.length}` : ""}</button>
                            <button className="tiny danger" disabled={disabled || !sel.length} onClick={() => setDeleting((d) => !d)}>Delete{sel.length ? ` ${sel.length}` : ""}</button>
                            <button className="tiny" disabled={disabled} title="Push the branch with --force-with-lease — needed after Change message, Squash or Delete rewrite the history GitHub already has" onClick={forcePush}>{busy === "push" ? "Pushing…" : "Force-push"}</button>
                        </>
                    )}
                </div>
                {squashing !== null && consecutive && (
                    <div className="commit-remove">
                        <b>Squash {sel.length} commits into one</b>
                        <input autoFocus value={squashing} onChange={(e) => setSquashing(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void squash()} placeholder="Commit message" />
                        <div className="actions" style={{ margin: 0 }}>
                            <button className="primary" disabled={disabled || !squashing.trim()} onClick={() => void squash()}>{busy === "squash" ? "Squashing…" : "Squash"}</button>
                            <button disabled={disabled} onClick={() => setSquashing(null)}>Cancel</button>
                        </div>
                    </div>
                )}
                {deleting && sel.length > 0 && (
                    <div className="commit-remove">
                        <b>Remove {sel.length === 1 ? `commit ${sel[0]!.short}` : `${sel.length} commits`} from history</b> — not a revert: the agent replays everything after them, resolves conflicts and re-runs tests. Nothing is pushed.
                        <AgentInput placeholder="Optional note for the agent: why remove them" value={note} onChange={setNote} pending={attach} />
                        <div className="actions" style={{ margin: 0 }}>
                            <button className="danger" disabled={disabled} onClick={() => void remove()}>{busy === "delete" ? "Starting…" : "Remove from history"}</button>
                            <button disabled={disabled} onClick={() => { setDeleting(false); setNote(""); }}>Cancel</button>
                        </div>
                    </div>
                )}
                {started && (
                    <div className="commit-remove started">
                        Removing {started} — the agent is replaying the branch; the result (and any conflicts it hit) will appear in Chat.
                        <button className="tiny" onClick={() => setStarted(null)}>Dismiss</button>
                    </div>
                )}
                {pushed && <div className="field-hint">{pushed}</div>}
                {commits.length === 0 && <div className="quiet">no commits yet</div>}
                {commits.map((c) => (
                    <div className={`commit-row ${picked.has(c.sha) ? "picked" : ""} ${shown.includes(c.sha) ? "shown" : ""}`} key={c.sha}>
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
                                <input type="checkbox" aria-label={`pick ${c.short}`} checked={picked.has(c.sha)} onChange={() => toggle(c.sha)} />
                                <code className="commit-sha">{c.short}</code>
                                <span className="commit-subject">{c.subject}</span>
                                <small className="field-hint">{c.author} · {ago(c.at)} ago</small>
                                {taskId && <span className="commit-actions"><button className="tiny" disabled={disabled} onClick={() => { setEditing(c.sha); setText(c.subject); }}>Change message</button></span>}
                            </>
                        )}
                    </div>
                ))}
            </div>
        </details>
    );
};

// Tap a line → write a comment anchored to it. Drafts live in localStorage until the review is sent.
export const commentKey = (c: Pick<LineComment, "path" | "side" | "line">): string => `${c.path}:${c.side}:${c.line}`;

const lineAnchor = (path: string, l: DiffLine): Pick<LineComment, "path" | "side" | "line"> =>
    l.type === "del" ? { path, side: "old", line: l.oldNo ?? 0 } : { path, side: "new", line: l.newNo ?? 0 };

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

const FileDiff = ({
    file,
    comments,
    prior,
    threads,
    canComment,
    canAsk,
    onChange,
    onAsk,
    onExpand,
    state,
    print,
    onOpen,
    onReviewed,
    threadOpen,
    onThreadOpen,
}: {
    file: DiffFile;
    comments: Record<string, LineComment>;
    prior: PriorComment[];
    threads: ThreadMessage[];
    canComment: boolean;
    canAsk: boolean;
    onChange: (key: string, c: LineComment | null) => void;
    onAsk: (anchor: MessageAnchor, text: string, files: File[]) => Promise<void>;
    // Fetches a collapsed file's hunks (generated / very large files are sent without them).
    onExpand: (path: string) => Promise<void>;
    // The remembered review state of the file, its current change's fingerprint (null: unknown yet), and the setters.
    state?: FileReviewState;
    print: string | null;
    onOpen: (open: boolean) => void;
    onReviewed: (print: string | null) => void;
    // Whether the discussion on a line is shown (remembered like a file's open state; default open).
    threadOpen: (key: string) => boolean;
    onThreadOpen: (key: string, open: boolean) => void;
}) => {
    const reviewed = !!print && state?.reviewed === print;
    const open = state?.open ?? (!reviewed && file.hunks.length > 0 && file.additions + file.deletions <= 400);
    const [editing, setEditing] = useState<string | null>(null);
    const [expanding, setExpanding] = useState(false);
    // Lines whose question is out with the agent right now (the reply arrives through the messages list).
    const [asking, setAsking] = useState<Set<string>>(new Set());
    const count = Object.values(comments).filter((c) => c.path === file.path).length;
    const placed = useMemo(() => placeAnchored(file, prior), [file, prior]);
    // Draft comments are placed by line text like everything else: a draft saved in a commit slice carries the full
    // diff's line number (see DiffView.handleChange), which is not this slice's numbering — and vice versa.
    const drafts = useMemo(() => placeAnchored(file, Object.values(comments).filter((c) => c.path === file.path)), [file, comments]);
    const placedThreads = useMemo(() => placeAnchored(file, threads), [file, threads]);
    const priorCount = prior.filter((p) => p.path === file.path).length;
    const threadCount = Object.keys(placedThreads.byKey).length + placedThreads.outdated.length;
    const interactive = canComment || canAsk;
    const ask = async (key: string, anchor: MessageAnchor, text: string, files: File[]) => {
        setEditing(null);
        setAsking((s) => new Set(s).add(key));
        try {
            await onAsk(anchor, text, files);
        } finally {
            setAsking((s) => { const n = new Set(s); n.delete(key); return n; });
        }
    };
    return (
        <details className={`diff-file ${reviewed ? "reviewed" : ""}`} open={open} onToggle={(e) => { const now = (e.currentTarget as HTMLDetailsElement).open; if (now !== open) onOpen(now); }}>
            <summary>
                <label className="inline file-reviewed" title={print ? "Mark as reviewed — the mark drops by itself when the file changes" : "loading…"} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={reviewed} disabled={!print} onChange={(e) => onReviewed(e.target.checked ? print : null)} /> Reviewed
                </label>
                <span className={`chip ${file.status === "added" ? "ok" : file.status === "deleted" ? "bad" : ""}`}>{file.status}</span>
                <code className="path">{file.path}</code>
                <span className="mono stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
                {count > 0 && <span className="chip wait">{count} 💬</span>}
                {priorCount > 0 && <span className="chip" title="comments from earlier review rounds">{priorCount} earlier</span>}
                {threadCount > 0 && <span className="chip accent" title="questions asked to the agent on lines of this file">{threadCount} Q&amp;A</span>}
            </summary>
            {file.binary && <div className="empty">binary file</div>}
            {file.collapsed && (
                <div className="empty collapsed-file">
                    Generated or very large file — {file.additions + file.deletions} changed lines not loaded.
                    <button className="tiny" style={{ marginLeft: 8 }} disabled={expanding} onClick={() => { setExpanding(true); void onExpand(file.path).finally(() => setExpanding(false)); }}>{expanding ? "Loading…" : "Show anyway"}</button>
                </div>
            )}
            {(placed.outdated.length > 0 || placedThreads.outdated.length > 0 || drafts.outdated.length > 0) && (
                <div className="outdated">
                    {drafts.outdated.map((c, i) => (
                        <div key={`d${i}`} className="line-comment outdated-item">
                            <b>💬 draft</b> <span className="chip">line not in this view</span> <code>:{c.line}</code> <code className="snippet">{c.snippet.trim().slice(0, 80)}</code>
                            <div>{c.text}</div>
                            {canComment && <button className="tiny" onClick={() => onChange(commentKey(c), null)}>Delete</button>}
                        </div>
                    ))}
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
                        const existing = drafts.byKey[key]?.[0];
                        // Edits and deletes address the draft under its stored key (its line number may come from another view).
                        const existingKey = existing ? commentKey(existing) : key;
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
                                {(thread || asking.has(key)) && <LineThread items={thread ?? []} asking={asking.has(key)} canAsk={canAsk} onReply={() => setEditing(key)} open={threadOpen(thread?.[0] ? commentKey(thread[0]) : key)} onOpen={(o) => onThreadOpen(thread?.[0] ? commentKey(thread[0]) : key, o)} />}
                                {existing && editing !== key && (
                                    <div className="line-comment" onClick={() => canComment && setEditing(key)}>
                                        <b>💬</b> {existing.text}
                                    </div>
                                )}
                                {editing === key && (
                                    <CommentEditor
                                        initial={existing?.text ?? ""}
                                        placeholder={canComment && canAsk ? "What should change here? — or a question for the agent (⌘/Ctrl+Enter saves the comment)" : canComment ? "What should change here?" : "Ask the agent about this line…"}
                                        {...(canComment ? { onSave: (text: string) => { onChange(existingKey, { ...(existing ?? anchor), snippet: l.text, text }); setEditing(null); } } : {})}
                                        {...(canAsk ? { onAsk: (text: string, files: File[]) => void ask(key, fullAnchor, text, files) } : {})}
                                        onCancel={() => setEditing(null)}
                                        {...(existing && canComment ? { onDelete: () => { onChange(existingKey, null); setEditing(null); } } : {})}
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

// FNV-1a over a file's change (status, counts, every hunk line): equal while the change is the same.
const fingerprint = (f: DiffFile): string => {
    let h = 0x811c9dc5;
    const feed = (t: string) => {
        for (let i = 0; i < t.length; i++) {
            h ^= t.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
    };
    feed(`${f.status}|${f.additions}|${f.deletions}|`);
    for (const hk of f.hunks) for (const l of hk.lines) feed(`${l.type}${l.text}\n`);
    return h.toString(16);
};

// Which files are open and which are marked reviewed: kept by the server per task (code-review.json), so it survives
// reloads and other browsers; a diff without a task (a session) keeps it for the page's lifetime only.
const useFileReview = (taskId: string | undefined) => {
    const [state, setState] = useState<Record<string, FileReviewState>>({});
    useEffect(() => {
        setState({});
        if (taskId) void api.reviewState(taskId).then((r) => setState(r.files)).catch(() => undefined);
    }, [taskId]);
    type Patch = { open?: boolean | null; reviewed?: string | null };
    // Several files in one request (Collapse all / Expand all).
    const setMany = (patches: Record<string, Patch>): void => {
        setState((cur) => {
            const out = { ...cur };
            for (const [path, patch] of Object.entries(patches)) {
                const next: FileReviewState = { ...(cur[path] ?? {}) };
                if (patch.open !== undefined) { if (patch.open === null) delete next.open; else next.open = patch.open; }
                if (patch.reviewed !== undefined) { if (patch.reviewed === null) delete next.reviewed; else next.reviewed = patch.reviewed; }
                out[path] = next;
            }
            return out;
        });
        if (taskId && Object.keys(patches).length) void api.patchReviewState(taskId, patches).catch(() => undefined);
    };
    const set = (path: string, patch: Patch): void => setMany({ [path]: patch });
    return { state, set, setMany };
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
    onRebase,
    view,
    onView,
}: {
    // A task's diff (with the commit manager) …
    taskId?: string;
    // Which repository, which changes, files or tests: always the caller's route (a reload lands on the same view).
    view: DiffRoute;
    onView: (v: DiffRoute) => void;
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
    onAsk?: (anchor: MessageAnchor, text: string, files: File[]) => Promise<void>;
    // The env's sub-repository directories, for a repo-tabbed view; [] shows the single repo with no tabs.
    repos?: string[];
    // A stage/agent run already owns the worktree — disables Change message / Remove / force-push until it's done.
    taskBusy?: boolean;
    onError?: (m: string) => void;
    // "Rebase onto latest base" — offered in place of the diff when the base branch was rewritten under this one.
    onRebase?: () => void;
}) => {
    const src = useMemo(() => source ?? taskSource(taskId ?? ""), [source, taskId]);
    const [diff, setDiff] = useState<DiffResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [branch, setBranch] = useState<{ commits: BranchCommit[]; uncommitted: boolean; dirty?: string[] }>({ commits: [], uncommitted: false });
    const filter: DiffFilter = view.scope ?? { kind: "all" };
    const wantRepo = view.repo ?? "";
    const repo = repos.includes(wantRepo) ? wantRepo : (repos[0] ?? "");
    const kind: "files" | "tests" = view.tests ? "tests" : "files";
    const at = (v: DiffRoute): DiffRoute => ({ ...(v.repo ? { repo: v.repo } : {}), ...(v.scope && v.scope.kind !== "all" ? { scope: v.scope } : {}), ...(v.tests ? { tests: true } : {}) });
    const setFilter = (f: DiffFilter): void => onView(at({ repo, scope: f, tests: view.tests }));
    const setKind = (k: "files" | "tests"): void => onView(at({ repo, scope: filter, tests: k === "tests" }));
    // Switching repository always starts from that repository's full diff.
    const setActiveRepo = (r: string): void => onView(at({ repo: r, tests: view.tests }));
    useEffect(() => {
        void src.commits().then(setBranch).catch(() => undefined);
    }, [src, refreshKey]);
    const filterArg = filter.kind === "all" ? undefined : filter.kind === "uncommitted" ? { uncommitted: true as const } : { shas: filter.shas };
    // The effect keys on this string, not on the filter object: in controlled mode the parent builds a new filter
    // object on every render, and keying on its identity made every fetched diff start the next fetch (the view
    // blinked between "Loading diff…" and the diff forever).
    const filterKey = filter.kind === "all" ? "all" : filter.kind === "uncommitted" ? "uncommitted" : `commits:${filter.shas.join(",")}`;
    useEffect(() => {
        setDiff(null);
        setError(null);
        void src.diff(filterArg).then(setDiff).catch((e: Error) => setError(e.message));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, refreshKey, filterKey]);
    // The full diff (current file vs base) behind a commit slice: a comment saved in the slice is re-anchored to the
    // full diff's line numbers, because `path:line` is what the review sends to the agent and what "All changes" shows.
    const [fullDiff, setFullDiff] = useState<DiffResponse | null>(null);
    useEffect(() => {
        if (filter.kind === "all") {
            setFullDiff(null);
            return;
        }
        void src.diff(undefined).then(setFullDiff).catch(() => setFullDiff(null));
    }, [src, refreshKey, filter.kind]);
    const reanchor = (c: LineComment): LineComment => {
        if (filter.kind === "all" || !fullDiff) return c;
        const file = fullDiff.files.find((f) => f.path === c.path);
        const want = c.snippet.trim();
        const candidates = (file?.hunks ?? [])
            .flatMap((h) => h.lines)
            .filter((l) => l.text.trim() === want && (c.side === "old" ? l.type === "del" : l.type !== "del"))
            .map((l) => lineAnchor(c.path, l).line);
        if (candidates.length === 0) {
            // The line is not part of the change vs base any more (a later commit rewrote it, or the slice removed a
            // line the branch had added). Kept as written; the agent is told where it was seen.
            const where = filter.kind === "commits" ? `commit ${filter.shas.map((s) => s.slice(0, 7)).join(",")}` : "the uncommitted changes";
            return { ...c, text: `(on line ${c.line} of ${where}; the line is not in the current diff vs base) ${c.text}` };
        }
        const line = candidates.reduce((best, n) => (Math.abs(n - c.line) < Math.abs(best - c.line) ? n : best));
        return { ...c, line };
    };
    const handleChange = (key: string, c: LineComment | null): void => {
        if (!c) {
            onChange(key, null);
            return;
        }
        const next = reanchor(c);
        const nextKey = commentKey(next);
        if (nextKey !== key) onChange(key, null);
        onChange(nextKey, next);
    };
    // "Show anyway" on a collapsed file: fetch just that file and splice its hunks into the loaded diff.
    const expand = async (path: string): Promise<void> => {
        const one = await src.diff(filterArg, path).catch((e: Error) => { onError(e.message); return null; });
        const full = one?.files.find((f) => f.path === path);
        if (!full) return;
        setDiff((d) => d && { ...d, files: d.files.map((f) => (f.path === path ? full : f)), groups: d.groups.map((g) => ({ ...g, files: g.files.map((f) => (f.path === path ? full : f)) })) });
    };
    const threadItems = useMemo(() => threadMessages(threads), [threads]);
    const review = useFileReview(taskId);
    // A file's change as it stands vs the base: the fingerprint a Reviewed mark is held against, so the mark drops by
    // itself when the file's change moves (the agent edited it). Taken from the full diff in every view.
    const base = filter.kind === "all" ? diff : fullDiff;
    const printOf = (path: string): string | null => {
        const f = base?.files.find((x) => x.path === path);
        return f ? fingerprint(f) : null;
    };
    // The commit picker only offers this repository's commits — its shas mean nothing in another checkout.
    const repoCommits = branch.commits.filter((c) => c.repo === repo);
    // Comments and questions work in every view: both are placed by the line's text, and a comment saved in a commit
    // slice is re-anchored to the full diff's line numbers (handleChange).
    const commentsOn = canComment;
    const tabs = repos.length > 1 && (
        <div className="subtabs pr-repo-tabs">
            {repos.map((r) => (
                <button key={r} className={`${r === repo ? "active" : ""} repo-${repoColorClass(r, repos)}`} onClick={() => setActiveRepo(r)}>{repoName(r)}</button>
            ))}
        </div>
    );
    const commitPanel = <CommitList {...(taskId ? { taskId } : {})} repo={repo} commits={repoCommits} uncommitted={branch.uncommitted} filter={filter} onFilter={setFilter} busy={taskBusy} onError={onError} />;
    if (error) return <>{tabs}{commitPanel}<div className="blocked-box">diff: {error}</div></>;
    if (!diff) return <>{tabs}{commitPanel}<div className="diff"><div className="diff-summary mono">loading diff…</div></div></>;
    const repoFiles = diff.files.filter((f) => inRepo(f.path, repo));
    const testCount = repoFiles.filter((f) => isTestFile(f.path)).length;
    const ofKind = (path: string): boolean => (kind === "tests") === isTestFile(path);
    const files = repoFiles.filter((f) => ofKind(f.path));
    const groups = diff.groups.map((g) => ({ ...g, files: g.files.filter((f) => inRepo(f.path, repo) && ofKind(f.path)) })).filter((g) => g.files.length > 0);
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    // The lines of this view's files that carry a discussion (their thread keys), for Collapse / Expand Q&A.
    const threadKeys = [...new Set(threadItems.filter((t) => files.some((f) => f.path === t.path)).map((t) => commentKey(t)))];
    const allThreadsOpen = threadKeys.every((k) => review.state[`thread:${k}`]?.open ?? true);
    const reviewedCount = files.filter((f) => { const p = printOf(f.path); return !!p && review.state[f.path]?.reviewed === p; }).length;
    const drifted = (diff.baseDrift ?? []).includes(repo);
    // Everything `git status` counts as uncommitted here — the diff below compares with the base, so a working-tree
    // change that matches the base (or sits outside the diffed files) would otherwise be invisible.
    const dirty = (branch.dirty ?? []).filter((p) => inRepo(p, repo));
    return (
        <>
            {tabs}
            {commitPanel}
            <div className="diff">
                {drifted && (
                    <div className="blocked-box base-drift">
                        <b>Base branch rewritten.</b> <span className="mono">origin/{diff.base}</span> was rebased or force-pushed since this branch was last based on it, so what you see below includes the base's own commits, not just this task's.
                        {onRebase && !taskBusy && <> <button className="tiny" onClick={onRebase}>Rebase onto latest base</button></>}
                        {onRebase && taskBusy && <span className="hint"> Rebase once the current run finishes.</span>}
                    </div>
                )}
                {dirty.length > 0 && (
                    <p className="field-hint">
                        Uncommitted in this checkout ({dirty.length}): <span className="mono">{dirty.slice(0, 12).join(", ")}{dirty.length > 12 ? ", …" : ""}</span>. A rebase sets them aside and puts them back.
                    </p>
                )}
                <div className="subtabs diff-kind">
                    <button className={kind === "files" ? "active" : ""} onClick={() => setKind("files")}>Files <span className="chip">{repoFiles.length - testCount}</span></button>
                    <button className={kind === "tests" ? "active" : ""} onClick={() => setKind("tests")}>Tests <span className="chip">{testCount}</span></button>
                </div>
                <div className="diff-summary mono">
                    {files.length > 0 && (
                        <span className="diff-fold">
                            <button className="tiny" onClick={() => review.setMany(Object.fromEntries(files.map((f) => [f.path, { open: false }])))}>Collapse all</button>
                            <button className="tiny" onClick={() => review.setMany(Object.fromEntries(files.map((f) => [f.path, { open: true }])))}>Expand all</button>
                            {threadKeys.length > 0 && <button className="tiny" onClick={() => review.setMany(Object.fromEntries(threadKeys.map((k) => [`thread:${k}`, { open: allThreadsOpen ? false : null }])))}>{allThreadsOpen ? "Collapse Q&A" : "Expand Q&A"}</button>}
                        </span>
                    )}
                    {files.length} file{files.length === 1 ? "" : "s"}{diff.filtered ? "" : ` vs origin/${diff.base}`} · <span className="add">+{adds}</span> <span className="del">−{dels}</span>{files.length > 0 && <> · {reviewedCount}/{files.length} reviewed</>}
                    {commentsOn && <span className="hint"> · tap a line to comment{canAsk ? " or ask" : ""}{filter.kind !== "all" ? " (comments are kept against the current file's lines)" : ""}</span>}
                    {!commentsOn && canAsk && <span className="hint"> · tap a line to ask the agent about it</span>}
                </div>
                {files.length === 0 && <div className="empty">{repoFiles.length ? (kind === "tests" ? "No test files changed here." : "Only test files changed here.") : diff.filtered ? "Nothing in this selection." : `No changes against ${diff.base} yet.`}</div>}
                {!diff.filtered && (() => {
                    const known = new Set(repoFiles.map((f) => f.path));
                    const gone = prior.filter((p) => inRepo(p.path, repo) && ofKind(p.path) && !known.has(p.path));
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
                            <FileDiff key={`${gi}:${f.path}`} file={f} comments={comments} prior={diff.filtered ? [] : prior} threads={threadItems} canComment={commentsOn} canAsk={canAsk} onChange={handleChange} onAsk={onAsk} onExpand={expand}
                                state={review.state[f.path]} print={printOf(f.path)} onOpen={(open) => review.set(f.path, { open })} threadOpen={(k) => review.state[`thread:${k}`]?.open ?? true} onThreadOpen={(k, o) => review.set(`thread:${k}`, { open: o ? null : false })} onReviewed={(p) => review.set(f.path, p ? { reviewed: p, open: false } : { reviewed: null, open: true })} />
                        ))}
                    </div>
                ))}
            </div>
        </>
    );
};
