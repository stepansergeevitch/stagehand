// How Stagehand files long text in the palace: verbatim chunks that follow the text's structure, each opening with a
// locator line, so a search hit says where it comes from and the agent opens the original only for that span.
//
// The palace embeds with all-MiniLM-L6-v2, which reads the first 256 tokens of a drawer and ignores the rest. One
// drawer per artifact made everything past its first ~1000 characters unsearchable; chunks of ~700 characters (plus the
// locator) stay inside that window. Chunks are never compressed: a hit is quoted as fact, so it must be verbatim.
//
//   docs           → one run of chunks per heading section, the heading path in the locator ("Spec › §14 Density")
//   conversations  → whole turns grouped up to the size, a turn longer than that cut at paragraph or sentence ends
//   issues         → one run of chunks for the issue (title, status, labels, description), one per comment

import type { TrackedIssue } from "./sources.js";

export const CHUNK_MAX = 700;
export const CHUNK_OVERLAP = 100;
const CHUNK_MIN = 8;

export interface Chunk {
    text: string;
    section: string;
    // 1-based lines of the source file the chunk covers (for Read with offset/limit).
    lineFrom: number;
    lineTo: number;
}

const lineAt = (text: string, offset: number): number => {
    let n = 1;
    for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
};

// Cuts `body` (which starts at `offset` in `full`) into pieces of at most CHUNK_MAX characters, preferring a paragraph
// end, then a line end, then a sentence end in the second half of the window; pieces overlap by CHUNK_OVERLAP.
const windows = (full: string, body: string, offset: number, section: string): Chunk[] => {
    const out: Chunk[] = [];
    let start = 0;
    while (start < body.length) {
        let end = Math.min(start + CHUNK_MAX, body.length);
        if (end < body.length) {
            const half = start + CHUNK_MAX / 2;
            const cut = [body.lastIndexOf("\n\n", end), body.lastIndexOf("\n", end), body.lastIndexOf(". ", end)].find((i) => i > half);
            if (cut !== undefined) end = cut + 1;
        }
        const text = body.slice(start, end).trim();
        if (text.length >= CHUNK_MIN) out.push({ text, section, lineFrom: lineAt(full, offset + start), lineTo: lineAt(full, offset + end - 1) });
        if (end >= body.length) break;
        start = Math.max(end - CHUNK_OVERLAP, start + 1);
    }
    return out;
};

// Markdown split on its #, ## and ### headings (outside code fences); each section is cut into windows.
export const chunkDocument = (md: string): Chunk[] => {
    const lines = md.split("\n");
    const out: Chunk[] = [];
    const path: string[] = [];
    let fence = false;
    let secStart = 0;
    let offset = 0;
    let secTitle = "";
    const flush = (endOffset: number): void => {
        const body = md.slice(secStart, endOffset);
        if (body.trim()) out.push(...windows(md, body, secStart, secTitle || "start"));
    };
    for (const line of lines) {
        if (/^\s*```/.test(line)) fence = !fence;
        const h = !fence ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
        if (h) {
            flush(offset);
            const level = h[1]!.length;
            path.length = level - 1;
            path[level - 1] = h[2]!;
            secTitle = path.filter(Boolean).join(" › ");
            secStart = offset;
        }
        offset += line.length + 1;
    }
    flush(md.length);
    return out;
};

// A line that opens a turn of a conversation: "Name: …", "**Name**: …", "[10:42] Name: …", "Name — 10:42".
const TURN = /^\s*(?:\[[^\]]{1,24}\]\s*)?(?:\*\*[^*\n]{1,40}\*\*|[\p{Lu}][\p{L}.' -]{0,38}[\p{L}])\s*(?::|—\s*\d{1,2}[:.]\d{2}|\(\d{1,2}[:.]\d{2}[^)]*\))/u;

export const looksLikeConversation = (text: string): boolean => {
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 4) return false;
    const turns = lines.filter((l) => TURN.test(l)).length;
    return turns >= 4 && turns / lines.length >= 0.15;
};

// Whole turns grouped up to CHUNK_MAX; the section names the speakers of the group.
export const chunkConversation = (text: string): Chunk[] => {
    const lines = text.split("\n");
    const turns: Array<{ start: number; end: number; speaker: string }> = [];
    let offset = 0;
    for (const line of lines) {
        if (TURN.test(line) || turns.length === 0) {
            if (turns.length) turns[turns.length - 1]!.end = offset;
            const sp = /^\s*(?:\[[^\]]*\]\s*)?\**([^:*—(\n]{1,40})/u.exec(line)?.[1]?.trim() ?? "";
            turns.push({ start: offset, end: text.length, speaker: TURN.test(line) ? sp : "" });
        }
        offset += line.length + 1;
    }
    const out: Chunk[] = [];
    let group: typeof turns = [];
    const flush = (): void => {
        if (!group.length) return;
        const start = group[0]!.start;
        const end = group[group.length - 1]!.end;
        const speakers = [...new Set(group.map((g) => g.speaker).filter(Boolean))].join(", ");
        const section = speakers ? `conversation: ${speakers}` : "conversation";
        out.push(...windows(text, text.slice(start, end), start, section));
        group = [];
    };
    for (const t of turns) {
        const size = group.length ? t.end - group[0]!.start : 0;
        if (group.length && size > CHUNK_MAX) flush();
        group.push(t);
    }
    flush();
    return out;
};

export const chunkText = (text: string): Chunk[] => (looksLikeConversation(text) ? chunkConversation(text) : chunkDocument(text));

// The drawer text of a chunk: the locator line, then the verbatim text.
export const drawerText = (title: string, file: string, c: Chunk): string => `[${title} › ${c.section} · ${file} L${c.lineFrom}-${c.lineTo}]\n${c.text}`;

// The drawers of one issue: its head and description, then one run per comment.
export const issueDrawers = (i: TrackedIssue): Array<{ text: string; part: string }> => {
    const head = `[issue ${i.identifier} — ${i.title} · ${i.status ?? "?"}${i.labels.length ? ` · ${i.labels.join(", ")}` : ""}${i.assignee ? ` · ${i.assignee}` : ""} · ${i.url}]`;
    const out: Array<{ text: string; part: string }> = [];
    const desc = i.description.trim();
    const descChunks = desc ? windows(desc, desc, 0, "description") : [];
    if (!descChunks.length) out.push({ text: `${head}\n(no description)`, part: "head" });
    descChunks.forEach((c, n) => out.push({ text: `${head}\n${c.text}`, part: `desc${n}` }));
    for (const cm of i.comments) {
        const body = cm.body.trim();
        windows(body, body, 0, "comment").forEach((c, n) => out.push({ text: `[issue ${i.identifier} — comment by ${cm.author}, ${cm.at}]\n${c.text}`, part: `c${cm.id}_${n}` }));
    }
    return out;
};
