import type { ReactNode } from "react";
import { Icon } from "@vortex/ds";

export interface Crumb {
    label: ReactNode;
    // Present on every crumb but the last: where it goes.
    onClick?: () => void;
}

// The head of every page: breadcrumbs above the title, state chips beside it, page actions on the right, and (for an
// entity) the tab strip below. The one h1 of the page.
//
//   Environments › acme-api                                  [Verify] [Delete]
//   acme-api  (Active)
//   Overview  Repositories  Commands  …
export const PageHeader = ({ title, crumbs, meta, actions, children, sticky }: {
    title: ReactNode;
    crumbs?: Crumb[];
    // Chips / a status next to the title.
    meta?: ReactNode;
    // Primary action last; secondary ones before it.
    actions?: ReactNode;
    // Under the title row: a Tabs strip.
    children?: ReactNode;
    sticky?: boolean;
}) => (
    <header className={`page-header${sticky ? " sticky" : ""}`}>
        {crumbs && crumbs.length > 0 && (
            <nav className="ph-crumbs" aria-label="Breadcrumb">
                {crumbs.map((c, i) => (
                    <span key={i} className="ph-crumb">
                        {c.onClick ? <a href="#" onClick={(e) => { e.preventDefault(); c.onClick!(); }}>{c.label}</a> : <span aria-current="page">{c.label}</span>}
                        {i < crumbs.length - 1 && <Icon name="chevronRight" />}
                    </span>
                ))}
            </nav>
        )}
        <div className="ph-row">
            <h1 className="ph-title">{title}</h1>
            {meta && <div className="ph-meta">{meta}</div>}
            {actions && <div className="ph-actions">{actions}</div>}
        </div>
        {children}
    </header>
);
