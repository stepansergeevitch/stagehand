import { useEffect, type ReactNode } from "react";
import "./shell.css";

// The frame of the app (docs/ux-redesign.md §3): a sidebar on the left, a top bar over the content. Under 900px the
// sidebar is an off-canvas drawer opened from the top bar; the content never shifts.
//
//   ┌────────┬───────────────────────────────┐
//   │sidebar │ topbar                        │
//   │        ├───────────────────────────────┤
//   │        │ <main> page content           │
//   └────────┴───────────────────────────────┘
export const AppShell = ({ sidebar, topbar, children, collapsed, drawerOpen, onCloseDrawer, overlays }: {
    sidebar: ReactNode;
    topbar: ReactNode;
    children: ReactNode;
    // The sidebar is a 56px icon rail.
    collapsed?: boolean;
    drawerOpen: boolean;
    onCloseDrawer: () => void;
    // Dialogs and floating widgets, rendered after the frame.
    overlays?: ReactNode;
}) => {
    useEffect(() => {
        if (!drawerOpen) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onCloseDrawer();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [drawerOpen, onCloseDrawer]);
    return (
        <div className={`shell${collapsed ? " collapsed" : ""}${drawerOpen ? " drawer-open" : ""}`}>
            <a className="skip-link" href="#main">Skip to content</a>
            {sidebar}
            <div className="shell-scrim" onClick={onCloseDrawer} aria-hidden="true" />
            <div className="shell-col">
                {topbar}
                <main id="main" className="shell-main" tabIndex={-1}>{children}</main>
            </div>
            {overlays}
        </div>
    );
};

// The content column of a page. `narrow` for forms and settings, `default` for most pages, `wide` for tables, `full`
// for workspaces that manage their own panes (terminal, diff).
export const PageFrame = ({ width = "default", children }: { width?: "narrow" | "default" | "wide" | "full"; children: ReactNode }) => (
    <div className={`page-frame ${width}`}>{children}</div>
);
