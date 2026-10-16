import { useMemo, useRef, useState } from "react";
import type { LineComment, MessageAnchor } from "../api";
import { commentKey } from "../DiffView";
import { Markdown } from "../Markdown";
import { CommentEditor } from "./CommentEditor";
import { LineThread, type ThreadMessage } from "./LineThread";
import { Button } from "@vortex/ds";

// A markdown document the reader can talk about. Select text or hover a block → comment on it (a draft that goes with
// the next review round) or ask the agent about it (answered in a thread under the document). The document's blocks
// are numbered by <Markdown numbered>; a note's `line` is block * 100 + n (several notes may share a block), its
// `snippet` the selected passage, its `path` the document's name. Drafts and threads are the same objects the diff uses.
interface Target {
    block: number;
    snippet: string;
    // Where the floating toolbar / editor sits (viewport pixels).
    x: number;
    y: number;
}

const blockOf = (node: Node | null, root: HTMLElement): HTMLElement | null => {
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    const b = el?.closest<HTMLElement>("[data-block]") ?? null;
    return b && root.contains(b) ? b : null;
};

export const AnnotatedMarkdown = ({
    source,
    path,
    comments,
    threads,
    canComment,
    canAsk,
    onChange,
    onAsk,
    collapsed,
}: {
    source: string;
    // Regex source: the `##` sections whose heading matches start folded.
    collapsed?: string;
    path: string;
    comments: Record<string, LineComment>;
    threads: ThreadMessage[];
    canComment: boolean;
    canAsk: boolean;
    onChange: (key: string, c: LineComment | null) => void;
    onAsk: (anchor: MessageAnchor, text: string, files: File[]) => Promise<void>;
}) => {
    const root = useRef<HTMLDivElement>(null);
    const [picked, setPicked] = useState<Target | null>(null);
    const [editing, setEditing] = useState<Target | null>(null);
    const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
    const [asking, setAsking] = useState<Set<string>>(new Set());
    const [hover, setHover] = useState<{ block: number; top: number } | null>(null);
    const mine = useMemo(() => Object.entries(comments).filter(([, c]) => c.path === path), [comments, path]);
    const groups = useMemo(() => {
        const out = new Map<string, ThreadMessage[]>();
        for (const t of threads.filter((m) => m.path === path)) out.set(t.snippet.trim(), [...(out.get(t.snippet.trim()) ?? []), t]);
        return [...out.entries()];
    }, [threads, path]);
    const enabled = canComment || canAsk;

    const onMouseUp = () => {
        if (!enabled || !root.current) return;
        const sel = window.getSelection();
        const text = sel?.toString().trim() ?? "";
        if (!sel || sel.isCollapsed || !text) return setPicked(null);
        const b = blockOf(sel.anchorNode, root.current);
        if (!b) return setPicked(null);
        const r = sel.getRangeAt(0).getBoundingClientRect();
        setPicked({ block: Number(b.dataset["block"]), snippet: text.slice(0, 600), x: r.left, y: r.bottom + 6 });
    };
    const onMouseMove = (e: React.MouseEvent) => {
        if (!enabled || !root.current) return;
        const b = blockOf(e.target as Node, root.current);
        if (!b) return setHover(null);
        const block = Number(b.dataset["block"]);
        if (hover?.block !== block) setHover({ block, top: b.getBoundingClientRect().top - root.current.getBoundingClientRect().top });
    };
    const openBlock = () => {
        if (!hover || !root.current) return;
        const b = root.current.querySelector<HTMLElement>(`[data-block="${hover.block}"]`);
        if (!b) return;
        const r = b.getBoundingClientRect();
        setEditing({ block: hover.block, snippet: (b.textContent ?? "").trim().slice(0, 600), x: r.left, y: r.bottom + 6 });
    };

    const save = (t: Target, text: string) => {
        const n = mine.filter(([, c]) => Math.floor(c.line / 100) === t.block).length;
        const c: LineComment = { path, side: "new", line: t.block * 100 + n, snippet: t.snippet, text };
        onChange(commentKey(c), c);
        setEditing(null);
        setPicked(null);
        window.getSelection()?.removeAllRanges();
    };
    const ask = async (t: Target, text: string, files: File[]) => {
        const snippet = t.snippet.trim();
        setEditing(null);
        setPicked(null);
        window.getSelection()?.removeAllRanges();
        setOpenThreads((s) => new Set(s).add(snippet));
        setAsking((s) => new Set(s).add(snippet));
        try {
            await onAsk({ path, side: "new", line: t.block * 100, snippet: t.snippet }, text, files);
        } finally {
            setAsking((s) => { const n = new Set(s); n.delete(snippet); return n; });
        }
    };

    return (
        <div className="annotated" ref={root} onMouseUp={onMouseUp} onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}>
            {enabled && hover && !editing && (
                <Button variant="ghost" size="sm" className="annot-add" style={{ top: hover.top }} title="Comment on or ask about this paragraph (or select text)" onMouseDown={(e) => e.preventDefault()} onClick={openBlock}>+</Button>
            )}
            <Markdown source={source} numbered collapsed={collapsed} />
            {picked && !editing && (
                <div className="annot-toolbar" style={{ left: picked.x, top: picked.y }} onMouseDown={(e) => e.preventDefault()}>
                    {canAsk && <Button variant="primary" size="sm" onClick={() => setEditing(picked)}>Ask agent</Button>}
                    {canComment && <Button size="sm" onClick={() => setEditing(picked)}>Comment</Button>}
                </div>
            )}
            {editing && (
                <div className="annot-editor" style={{ left: Math.max(8, Math.min(editing.x, window.innerWidth - 460)), top: Math.min(editing.y, window.innerHeight - 260) }}>
                    <blockquote className="annot-quote">{editing.snippet.slice(0, 200)}</blockquote>
                    <CommentEditor
                        initial=""
                        placeholder="Your comment or question about this passage…"
                        {...(canComment ? { onSave: (text: string) => save(editing, text) } : {})}
                        {...(canAsk ? { onAsk: (text: string, files: File[]) => void ask(editing, text, files) } : {})}
                        onCancel={() => { setEditing(null); setPicked(null); }}
                    />
                </div>
            )}
            {(mine.length > 0 || groups.length > 0) && (
                <div className="annot-notes">
                    {mine.map(([key, c]) => (
                        <div key={key} className="annot-note">
                            <blockquote className="annot-quote">{c.snippet.slice(0, 200)}</blockquote>
                            <div className="annot-note-text">{c.text}</div>
                            <Button size="sm" variant="danger" title="Remove this comment" onClick={() => onChange(key, null)}>×</Button>
                        </div>
                    ))}
                    {groups.map(([snippet, items]) => (
                        <div key={snippet} className="annot-note">
                            <blockquote className="annot-quote">{snippet.slice(0, 200)}</blockquote>
                            <LineThread
                                items={items}
                                asking={asking.has(snippet)}
                                canAsk={canAsk}
                                open={openThreads.has(snippet)}
                                onOpen={(o) => setOpenThreads((s) => { const n = new Set(s); if (o) n.add(snippet); else n.delete(snippet); return n; })}
                                onReply={() => setEditing({ block: Math.floor((items[0]?.line ?? 100) / 100), snippet, x: 40, y: 120 })}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
