import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

// Links inside rendered markdown (ticket descriptions, PR bodies, design notes) open in a new tab.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
    }
});

const HEADING = /^H([1-6])$/;
const level = (el: Element): number => Number(HEADING.exec(el.tagName)?.[1] ?? 0);

// Wraps every h2/h3 and the content up to the next heading of the same or higher level into an open <details>,
// so long documents (design.md, research.md) can be folded section by section. Runs recursively for nested levels.
const foldHeadings = (container: Element, lvl: number): void => {
    if (lvl > 3) return;
    const kids = [...container.children];
    let i = 0;
    while (i < kids.length) {
        const el = kids[i]!;
        if (level(el) !== lvl) {
            i++;
            continue;
        }
        const body: Element[] = [];
        let j = i + 1;
        while (j < kids.length && (level(kids[j]!) === 0 || level(kids[j]!) > lvl)) body.push(kids[j++]!);
        const details = container.ownerDocument.createElement("details");
        details.className = `md-section md-h${lvl}`;
        details.open = true;
        const summary = container.ownerDocument.createElement("summary");
        const bodyEl = container.ownerDocument.createElement("div");
        bodyEl.className = "md-section-body";
        el.replaceWith(details);
        summary.appendChild(el);
        details.appendChild(summary);
        for (const b of body) bodyEl.appendChild(b);
        details.appendChild(bodyEl);
        foldHeadings(bodyEl, lvl + 1);
        i = j;
    }
};

// Artifacts are read raw from disk, so a field an agent wrote in the wrong shape (an array of notes, an object) reaches
// the page before the contract check bounces the run — render it rather than crash the task view (marked throws on
// anything but a string).
const asMarkdownText = (source: unknown): string => {
    if (typeof source === "string") return source;
    if (source == null) return "";
    if (Array.isArray(source)) return source.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n\n");
    return "```json\n" + JSON.stringify(source, null, 2) + "\n```";
};

const render = (source: unknown): string => {
    const clean = DOMPurify.sanitize(marked.parse(asMarkdownText(source), { async: false }) as string);
    const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
    const root = doc.body.firstElementChild;
    if (!root) return clean;
    foldHeadings(root, 2);
    return root.innerHTML;
};

export const Markdown = ({ source }: { source: string | unknown }) => {
    const html = useMemo(() => render(source), [source]);
    return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
};
