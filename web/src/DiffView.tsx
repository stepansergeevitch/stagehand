import { useEffect, useMemo, useState } from "react";
import { api, type DiffFile, type DiffLine, type LineComment } from "./api";
import { storage } from "./storage";

// Tap a line → write a comment anchored to it. Drafts live in localStorage until the review is sent.
export const commentKey = (c: Pick<LineComment, "path" | "side" | "line">): string => `${c.path}:${c.side}:${c.line}`;

const lineAnchor = (path: string, l: DiffLine): Pick<LineComment, "path" | "side" | "line"> =>
    l.type === "del" ? { path, side: "old", line: l.oldNo ?? 0 } : { path, side: "new", line: l.newNo ?? 0 };

const CommentEditor = ({ initial, onSave, onCancel, onDelete }: { initial: string; onSave: (t: string) => void; onCancel: () => void; onDelete?: () => void }) => {
    const [text, setText] = useState(initial);
    return (
        <div className="line-comment editing">
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What should change here?" />
            <div className="actions">
                <button className="primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>Save</button>
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

// Where an earlier round's comment sits in the current diff. Lines move between rounds, so match by the quoted line
// text (nearest to the original line number) rather than by number alone; unmatched ones are "outdated", like GitHub.
const placePrior = (file: DiffFile, prior: PriorComment[]): { byKey: Record<string, PriorComment[]>; outdated: PriorComment[] } => {
    const byKey: Record<string, PriorComment[]> = {};
    const outdated: PriorComment[] = [];
    const lines = file.hunks.flatMap((h) => h.lines);
    for (const c of prior.filter((p) => p.path === file.path)) {
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
    canComment,
    onChange,
}: {
    file: DiffFile;
    comments: Record<string, LineComment>;
    prior: PriorComment[];
    canComment: boolean;
    onChange: (key: string, c: LineComment | null) => void;
}) => {
    const [editing, setEditing] = useState<string | null>(null);
    const count = Object.values(comments).filter((c) => c.path === file.path).length;
    const placed = useMemo(() => placePrior(file, prior), [file, prior]);
    const priorCount = prior.filter((p) => p.path === file.path).length;
    return (
        <details className="diff-file" open={file.hunks.length > 0 && file.additions + file.deletions <= 400}>
            <summary>
                <span className={`chip ${file.status === "added" ? "ok" : file.status === "deleted" ? "bad" : ""}`}>{file.status}</span>
                <code className="path">{file.path}</code>
                <span className="mono stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
                {count > 0 && <span className="chip wait">{count} 💬</span>}
                {priorCount > 0 && <span className="chip" title="comments from earlier review rounds">{priorCount} earlier</span>}
            </summary>
            {file.binary && <div className="empty">binary file</div>}
            {placed.outdated.length > 0 && (
                <div className="outdated">
                    {placed.outdated.map((c, i) => (
                        <div key={i} className="line-comment prior outdated-item">
                            <b>{roundLabel(c)}</b> <span className="chip">outdated</span> <code>:{c.line}</code> <code className="snippet">{c.snippet.trim().slice(0, 80)}</code>
                            <div>{c.text}</div>
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
                        return (
                            <div key={li}>
                                <div
                                    className={`dl ${l.type} ${existing ? "has-comment" : ""} ${placed.byKey[key] ? "has-prior" : ""} ${canComment ? "clickable" : ""}`}
                                    onClick={() => canComment && setEditing(editing === key ? null : key)}
                                    title={canComment ? "Tap to comment on this line" : undefined}
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
                                {existing && editing !== key && (
                                    <div className="line-comment" onClick={() => canComment && setEditing(key)}>
                                        <b>💬</b> {existing.text}
                                    </div>
                                )}
                                {editing === key && (
                                    <CommentEditor
                                        initial={existing?.text ?? ""}
                                        onSave={(text) => {
                                            onChange(key, { ...anchor, snippet: l.text, text });
                                            setEditing(null);
                                        }}
                                        onCancel={() => setEditing(null)}
                                        {...(existing ? { onDelete: () => { onChange(key, null); setEditing(null); } } : {})}
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
    refreshKey,
    comments,
    prior = [],
    canComment,
    onChange,
}: {
    taskId: string;
    refreshKey: string;
    comments: Record<string, LineComment>;
    prior?: PriorComment[];
    canComment: boolean;
    onChange: (key: string, c: LineComment | null) => void;
}) => {
    const [diff, setDiff] = useState<{ base: string; files: DiffFile[] } | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        setDiff(null);
        void api.diff(taskId).then(setDiff).catch((e: Error) => setError(e.message));
    }, [taskId, refreshKey]);
    if (error) return <div className="blocked-box">diff: {error}</div>;
    if (!diff) return <div className="empty">loading diff…</div>;
    if (diff.files.length === 0) return <div className="empty">No changes against {diff.base} yet.</div>;
    const adds = diff.files.reduce((n, f) => n + f.additions, 0);
    const dels = diff.files.reduce((n, f) => n + f.deletions, 0);
    return (
        <div className="diff">
            <div className="diff-summary mono">
                {diff.files.length} file{diff.files.length === 1 ? "" : "s"} vs origin/{diff.base} · <span className="add">+{adds}</span> <span className="del">−{dels}</span>
                {canComment && <span className="hint"> · tap a line to comment</span>}
            </div>
            {(() => {
                const known = new Set(diff.files.map((f) => f.path));
                const gone = prior.filter((p) => !known.has(p.path));
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
            {diff.files.map((f) => <FileDiff key={f.path} file={f} comments={comments} prior={prior} canComment={canComment} onChange={onChange} />)}
        </div>
    );
};
