import { useCallback, useState, type ReactNode } from "react";
import { IconButton, Menu } from "@vortex/ds";
import { useDismiss } from "./useDismiss";
import "./more-menu.css";

// The `⋯` button of a page header or a row: rare and destructive actions live behind it (docs/ux-redesign.md §4.3).
// Put `MenuItem`s (and `<hr />`) inside; choosing one closes the menu.
export const MoreMenu = ({ label = "More actions", children }: { label?: string; children: ReactNode }) => {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const ref = useDismiss(open, close);
    return (
        <div className="more-menu" ref={ref}>
            <IconButton icon="more" label={label} variant="ghost" on={open} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
            {open && <Menu className="more-menu-list" onClick={close}>{children}</Menu>}
        </div>
    );
};
