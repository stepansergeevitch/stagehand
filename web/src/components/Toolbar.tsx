import type { ReactNode } from "react";

// A row of controls over a list or a panel: filters and search at the start, view options and bulk actions at the end.
// Wraps on narrow screens (the search takes its own line).
export const Toolbar = ({ children, end, className }: { children?: ReactNode; end?: ReactNode; className?: string }) => (
    <div className={`toolbar${className ? ` ${className}` : ""}`} role="toolbar">
        <div className="tl-start">{children}</div>
        {end && <div className="tl-end">{end}</div>}
    </div>
);
