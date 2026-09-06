import { useEffect, useState } from "react";
import { api, type DiffFile, type DiffLine, type LineComment } from "./api";

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

const FileDiff = ({
    file,
    comments,
    canComment,
    onChange,
}: {
    file: DiffFile;
    comments: Record<string, LineComment>;
    canComment: boolean;
    onChange: (key: string, c: LineComment | null) => void;
}) => {
    const [editing, setEditing] = useState<string | null>(null);
    const count = Object.values(comments).filter((c) => c.path === file.path).length;
    return (
        <details className="diff-file" open={file.hunks.length > 0 && file.additions + file.deletions <= 400}>
            <summary>
                <span className={`chip ${file.status === "added" ? "ok" : file.status === "deleted" ? "bad" : ""}`}>{file.status}</span>
                <code className="path">{file.path}</code>
                <span className="mono stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
                {count > 0 && <span className="chip wait">{count} 💬</span>}
            </summary>
            {file.binary && <div className="empty">binary file</div>}
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
                                    className={`dl ${l.type} ${existing ? "has-comment" : ""} ${canComment ? "clickable" : ""}`}
                                    onClick={() => canComment && setEditing(editing === key ? null : key)}
                                    title={canComment ? "Tap to comment on this line" : undefined}
                                >
                                    <span className="no">{l.oldNo ?? ""}</span>
                                    <span className="no">{l.newNo ?? ""}</span>
                                    <span className="mark">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                                    <span className="txt">{l.text || " "}</span>
                                </div>
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
            return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, LineComment>;
        } catch {
            return {};
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(comments));
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
    canComment,
    onChange,
}: {
    taskId: string;
    refreshKey: string;
    comments: Record<string, LineComment>;
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
            {diff.files.map((f) => <FileDiff key={f.path} file={f} comments={comments} canComment={canComment} onChange={onChange} />)}
        </div>
    );
};
