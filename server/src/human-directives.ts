import type { LineComment } from "./engine.js";

// One thing the human told the agent about a task: the task notes, a Request-changes round (its notes and line
// comments), the answers to the agent's questions, a chat message, a Do instruction.
export interface HumanDirective {
    // ISO timestamp — the items render oldest first, so a later instruction visibly supersedes an earlier one.
    at: string;
    source: string;
    text: string;
    comments?: LineComment[] | undefined;
}

const MAX_ITEMS = 40;
const MAX_TEXT = 2500;

const stamp = (iso: string): string => iso.replace("T", " ").slice(0, 16);

// The block the reviewer checks the diff against. Every item numbered, oldest first, each line comment under its
// round with the quoted line; long texts cut, only the last MAX_ITEMS kept (the count of the omitted ones stays).
export const renderHumanDirectives = (items: HumanDirective[]): string => {
    const kept = items.filter((i) => i.text.trim() || (i.comments?.length ?? 0) > 0).sort((a, b) => a.at.localeCompare(b.at));
    if (!kept.length) return "(the human left no instructions beyond the ticket and the approved design)";
    const dropped = Math.max(0, kept.length - MAX_ITEMS);
    const shown = kept.slice(dropped);
    const lines = shown.map((i, n) => {
        const text = i.text.trim();
        const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} … (truncated)` : text;
        const head = `${dropped + n + 1}. **${i.source}** (${stamp(i.at)})${body ? ` — ${body.replace(/\n/g, "\n   ")}` : ""}`;
        const cs = (i.comments ?? []).map((c) => `   - \`${c.path}:${c.line}\`${c.side === "old" ? " (removed line)" : ""} — \`${c.snippet.trim().slice(0, 120)}\`\n     → ${c.text.trim().replace(/\n/g, "\n     ")}`);
        return [head, ...cs].join("\n");
    });
    return ["## What the human asked for, oldest first (a later instruction wins over an earlier one on the same point)", dropped ? `(${dropped} earlier item(s) omitted)` : "", ...lines].filter(Boolean).join("\n\n");
};
