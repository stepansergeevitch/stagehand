import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Kbd, type IconName } from "@vortex/ds";

export interface Command {
    id: string;
    label: string;
    // The group heading ("Pages", "Tasks", "Environments").
    group: string;
    // Extra words matched but not shown (ticket title, environment name).
    keywords?: string;
    // A right-aligned note (status, environment).
    note?: string;
    icon?: IconName;
    run: () => void;
}

// ⌘K: jump to any page, task or environment by typing. Arrow keys move, Enter runs, Esc closes. Purely navigational; every
// command's `run` is a `navigate` call, so the result is a URL like any other.
export const CommandPalette = ({ commands, onClose }: { commands: Command[]; onClose: () => void }) => {
    const [q, setQ] = useState("");
    const [at, setAt] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => { input.current?.focus(); }, []);
    const shown = useMemo(() => {
        const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const hit = (c: Command): boolean => words.every((w) => `${c.label} ${c.keywords ?? ""} ${c.note ?? ""} ${c.group}`.toLowerCase().includes(w));
        return commands.filter(hit).slice(0, 50);
    }, [commands, q]);
    useEffect(() => { setAt(0); }, [q]);
    useEffect(() => { list.current?.querySelector(".cp-item.on")?.scrollIntoView({ block: "nearest" }); }, [at]);
    const run = (c: Command | undefined): void => {
        if (!c) return;
        onClose();
        c.run();
    };
    const onKey = (e: React.KeyboardEvent): void => {
        if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
        else if (e.key === "Enter") { e.preventDefault(); run(shown[at]); }
        else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    let last = "";
    return (
        <div className="cp-backdrop" onMouseDown={onClose}>
            <div className="cp" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
                <div className="cp-input">
                    <Icon name="search" />
                    <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, pages, environments…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="cp-list" />
                    <Kbd>Esc</Kbd>
                </div>
                <div className="cp-list" id="cp-list" role="listbox" ref={list}>
                    {shown.length === 0 && <div className="cp-empty">Nothing matches “{q}”.</div>}
                    {shown.map((c, i) => {
                        const head = c.group !== last ? <div className="cp-group" key={`g-${c.group}-${i}`}>{c.group}</div> : null;
                        last = c.group;
                        return (
                            <div key={c.id}>
                                {head}
                                <div className={`cp-item${i === at ? " on" : ""}`} role="option" aria-selected={i === at} onMouseMove={() => setAt(i)} onClick={() => run(c)}>
                                    {c.icon && <Icon name={c.icon} />}
                                    <span className="cp-label">{c.label}</span>
                                    {c.note && <span className="cp-note">{c.note}</span>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
