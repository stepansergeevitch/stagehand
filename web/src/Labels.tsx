import { useEffect, useRef, useState } from "react";
import { api, type TaskLabel } from "./api";

// Free-text labels with a colour, chosen by the human: shown on the task in the list, the dashboard and the header.
export const LABEL_COLORS = ["#1f6f8b", "#2e8b57", "#c98a1b", "#b8413a", "#6b5bb5", "#c2557a", "#3b7dd8", "#5f6b73"];

// Chip on a coloured tint of its own colour; readable in both themes because the text is the colour itself.
export const LabelChip = ({ label, onRemove }: { label: TaskLabel; onRemove?: () => void }) => (
    <span className="label-chip" style={{ color: label.color, background: `${label.color}22`, borderColor: `${label.color}66` }} title={label.text}>
        {label.text}
        {onRemove && <button type="button" className="chip-x" onClick={(e) => { e.stopPropagation(); onRemove(); }} aria-label={`remove ${label.text}`}>×</button>}
    </span>
);

export const LabelChips = ({ labels }: { labels: TaskLabel[] }) => (labels.length ? <span className="label-chips">{labels.map((l, i) => <LabelChip key={`${l.text}-${i}`} label={l} />)}</span> : null);

// Header widget: existing chips (× removes), a "+ label" popover with the text and a colour swatch row.
export const LabelEditor = ({ labels, onChange }: { labels: TaskLabel[]; onChange: (next: TaskLabel[]) => Promise<void> }) => {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    const [color, setColorRaw] = useState(LABEL_COLORS[0]!);
    const [touchedColor, setTouchedColor] = useState(false);
    const setColor = (c: string) => { setColorRaw(c); setTouchedColor(true); };
    const [busy, setBusy] = useState(false);
    // Labels already in use on other tasks, most used first, with the colour they usually have.
    const [suggestions, setSuggestions] = useState<Array<TaskLabel & { count: number }>>([]);
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        void api.labelSuggestions().then(setSuggestions).catch(() => setSuggestions([]));
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey, true);
        return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey, true); };
    }, [open]);
    const save = async (next: TaskLabel[]) => {
        setBusy(true);
        try {
            await onChange(next);
        } finally {
            setBusy(false);
        }
    };
    const add = async (label?: TaskLabel) => {
        const t = (label?.text ?? text).trim();
        if (!t) return;
        if (labels.some((l) => l.text.toLowerCase() === t.toLowerCase())) { setText(""); return; }
        await save([...labels, { text: t, color: label?.color ?? color }]);
        setText("");
    };
    const needle = text.trim().toLowerCase();
    const have = new Set(labels.map((l) => l.text.toLowerCase()));
    const suggested = suggestions.filter((s) => !have.has(s.text.toLowerCase()) && (!needle || s.text.toLowerCase().includes(needle))).slice(0, 12);
    // Typing an existing label's text: Enter reuses its usual colour, unless a swatch was picked meanwhile.
    const exact = suggestions.find((s) => s.text.toLowerCase() === needle);
    return (
        <span className="label-editor" ref={ref}>
            {labels.map((l, i) => <LabelChip key={`${l.text}-${i}`} label={l} onRemove={() => void save(labels.filter((_, j) => j !== i))} />)}
            <button type="button" className="tiny" disabled={busy} onClick={() => setOpen((v) => !v)} title="Add a label">+ label</button>
            {open && (
                <span className="label-menu">
                    <input autoFocus value={text} maxLength={40} onChange={(e) => setText(e.target.value)} placeholder="Label text" onKeyDown={(e) => { if (e.key === "Enter") void add(exact && !touchedColor ? exact : undefined); }} />
                    {suggested.length > 0 && (
                        <span className="label-suggestions">
                            <span className="field-hint" style={{ marginTop: 0 }}>{needle ? "matching" : "most used"}</span>
                            {suggested.map((s) => (
                                <button type="button" key={s.text} className="label-suggestion" disabled={busy} onClick={() => void add(s)} title={`used on ${s.count} task${s.count === 1 ? "" : "s"}`}>
                                    <LabelChip label={s} /><small>{s.count}</small>
                                </button>
                            ))}
                        </span>
                    )}
                    <span className="label-swatches">
                        {LABEL_COLORS.map((c) => <button type="button" key={c} className={`swatch ${c === color ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
                        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Any colour" />
                    </span>
                    <span className="label-preview"><LabelChip label={{ text: text.trim() || "preview", color: exact && !touchedColor ? exact.color : color }} /></span>
                    <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void add(exact && !touchedColor ? exact : undefined)}>Add</button>
                </span>
            )}
        </span>
    );
};
