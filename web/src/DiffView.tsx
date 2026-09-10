import { useEffect, useMemo, useRef, useState } from "react";
import { api, repoColorClass, repoName, type BranchCommit, type DiffFile, type DiffLine, type DiffResponse, type LineComment } from "./api";
import { storage } from "./storage";

// A file belongs to a repository when its path is exactly that repo's directory or starts with "<repo>/".
const inRepo = (path: string, repo: string): boolean => !repo || path === repo || path.startsWith(`${repo}/`);

// Which slice of the branch the diff shows: everything vs the base (default, the only view that takes line comments),
// only what is uncommitted, or a hand-picked set of commits.
export type DiffFilter = { kind: "all" } | { kind: "uncommitted" } | { kind: "commits"; shas: string[] };

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
    repos = [],
}: {
    taskId: string;
    refreshKey: string;
    comments: Record<string, LineComment>;
    prior?: PriorComment[];
    canComment: boolean;
    onChange: (key: string, c: LineComment | null) => void;
    // The env's sub-repository directories, for a repo-tabbed view; [] shows the single repo with no tabs.
    repos?: string[];
}) => {
    const [diff, setDiff] = useState<DiffResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<DiffFilter>({ kind: "all" });
    const [branch, setBranch] = useState<{ commits: BranchCommit[]; uncommitted: boolean }>({ commits: [], uncommitted: false });
    const [activeRepo, setActiveRepo] = useState(repos[0] ?? "");
    const repo = repos.includes(activeRepo) ? activeRepo : (repos[0] ?? "");
    useEffect(() => {
        setFilter({ kind: "all" });
        setActiveRepo(repos[0] ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [taskId]);
    useEffect(() => {
        void api.commits(taskId).then(setBranch).catch(() => undefined);
    }, [taskId, refreshKey]);
    useEffect(() => {
        setDiff(null);
        setError(null);
        const f = filter.kind === "all" ? undefined : filter.kind === "uncommitted" ? { uncommitted: true as const } : { shas: filter.shas };
        void api.diff(taskId, f).then(setDiff).catch((e: Error) => setError(e.message));
    }, [taskId, refreshKey, filter]);
    // The commit picker only offers this repository's commits — its shas mean nothing in another checkout.
    const repoCommits = branch.commits.filter((c) => c.repo === repo);
    // Line comments anchor to line numbers of the full diff (the current file); a commit slice numbers lines differently.
    const commentsOn = canComment && filter.kind === "all";
    const picker = <CommitPicker commits={repoCommits} uncommitted={branch.uncommitted} filter={filter} onChange={setFilter} />;
    const tabs = repos.length > 1 && (
        <div className="subtabs pr-repo-tabs">
            {repos.map((r) => (
                <button key={r} className={`${r === repo ? "active" : ""} repo-${repoColorClass(r, repos)}`} onClick={() => { setActiveRepo(r); setFilter({ kind: "all" }); }}>{repoName(r)}</button>
            ))}
        </div>
    );
    if (error) return <>{tabs}<div className="blocked-box">diff: {error}</div></>;
    if (!diff) return <>{tabs}<div className="diff"><div className="diff-summary mono">{picker} loading diff…</div></div></>;
    const files = diff.files.filter((f) => inRepo(f.path, repo));
    const groups = diff.groups.map((g) => ({ ...g, files: g.files.filter((f) => inRepo(f.path, repo)) })).filter((g) => g.files.length > 0);
    const adds = files.reduce((n, f) => n + f.additions, 0);
    const dels = files.reduce((n, f) => n + f.deletions, 0);
    return (
        <>
            {tabs}
            <div className="diff">
                <div className="diff-summary mono">
                    {picker}
                    {files.length} file{files.length === 1 ? "" : "s"}{diff.filtered ? "" : ` vs origin/${diff.base}`} · <span className="add">+{adds}</span> <span className="del">−{dels}</span>
                    {commentsOn && <span className="hint"> · tap a line to comment</span>}
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
                        {g.files.map((f) => <FileDiff key={`${gi}:${f.path}`} file={f} comments={comments} prior={diff.filtered ? [] : prior} canComment={commentsOn} onChange={onChange} />)}
                    </div>
                ))}
            </div>
        </>
    );
};
