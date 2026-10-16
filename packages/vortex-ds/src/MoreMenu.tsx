import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton, Menu } from "./Primitives";

// The `⋯` button of a page header or a row: rare and destructive actions live behind it. Put `MenuItem`s (and `<hr />`)
// inside; choosing one closes the menu. Children may be a function that gets `close` for an item that must close first.
// Esc and an outside click close it too.
export const MoreMenu = ({ label = "More actions", children }: { label?: string; children: ReactNode | ((close: () => void) => ReactNode) }) => {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open, close]);
    return (
        <div className="more-menu" ref={ref}>
            <IconButton icon="more" label={label} variant="ghost" on={open} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
            {open && <Menu className="more-menu-list" onClick={close}>{typeof children === "function" ? children(close) : children}</Menu>}
        </div>
    );
};
