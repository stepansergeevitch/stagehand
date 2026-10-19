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

// Alt+X (Emacs M-x): jump to any page, task or environment by typing. C-n / C-p (or the arrows) move, M-< / M-> jump to the first /
// last, C-v / M-v page down / up, RET runs, C-g (or Esc) closes. Purely navigational; every
// command's `run` is a `navigate` call, so the result is a URL like any other.
const PAGE = 8;

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
        // Match the physical key (`e.code`): Option changes the typed character on macOS.
        const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
        const alt = e.altKey && !e.ctrlKey && !e.metaKey;
        const move = (to: (i: number) => number): void => { e.preventDefault(); setAt((i) => Math.max(0, Math.min(shown.length - 1, to(i)))); };
        if (e.key === "ArrowDown" || (ctrl && e.code === "KeyN")) move((i) => i + 1);
        else if (e.key === "ArrowUp" || (ctrl && e.code === "KeyP")) move((i) => i - 1);
        else if (alt && e.shiftKey && e.code === "Comma") move(() => 0);
        else if (alt && e.shiftKey && e.code === "Period") move(() => shown.length - 1);
        else if (e.key === "PageDown" || (ctrl && e.code === "KeyV")) move((i) => i + PAGE);
        else if (e.key === "PageUp" || (alt && e.code === "KeyV")) move((i) => i - PAGE);
        else if (e.key === "Enter") { e.preventDefault(); run(shown[at]); }
        else if (e.key === "Escape" || (ctrl && e.code === "KeyG")) { e.preventDefault(); onClose(); }
    };
    let last = "";
    return (
        <div className="cp-backdrop" onMouseDown={onClose}>
            <div className="cp" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
                <div className="cp-input">
                    <Icon name="search" />
                    <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, pages, environments…" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="cp-list" />
                    <Kbd>C-g</Kbd>
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
