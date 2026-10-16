import { Badge, IconButton, Wordmark, Icon, type IconName, type Tone } from "@vortex/ds";
import type { ReactNode } from "react";

export interface NavItem {
    id: string;
    label: string;
    icon: IconName;
    // The hash link, so middle-click and copy-link work.
    href: string;
    // Shown as the item's title (and the rail's only label).
    hint?: string;
    // A count; `tone` warn/bad when it is something to act on.
    badge?: { count: number; tone?: Tone };
}
export interface NavGroup {
    label: string | null;
    items: NavItem[];
}

// The primary navigation: groups of destinations, each a link with an icon, a label and an optional count. One level, no
// nesting; the active item is marked with aria-current. Collapses to an icon rail.
export const Sidebar = ({ groups, current, onNavigate, collapsed, onToggleCollapsed, footer }: {
    groups: NavGroup[];
    current: string;
    onNavigate: (item: NavItem) => void;
    collapsed: boolean;
    onToggleCollapsed: () => void;
    footer?: ReactNode;
}) => (
    <aside className="sidebar" aria-label="Primary">
        <div className="sb-head">
            <a href="#/dashboard" className="sb-brand" aria-label="Vortex home"><Wordmark size="md" markOnly={collapsed} /></a>
        </div>
        <nav className="sb-nav" aria-label="Sections">
            {groups.map((g, gi) => (
                <div key={g.label ?? gi} className="sb-group">
                    {g.label && <div className="sb-label">{g.label}</div>}
                    {g.items.map((n) => (
                        <a
                            key={n.id}
                            href={n.href}
                            className={`sb-item${current === n.id ? " active" : ""}`}
                            aria-current={current === n.id ? "page" : undefined}
                            title={collapsed ? n.label : n.hint}
                            aria-label={collapsed && n.badge?.count ? `${n.label}, ${n.badge.count}` : undefined}
                            onClick={(e) => {
                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                                e.preventDefault();
                                onNavigate(n);
                            }}
                        >
                            <Icon name={n.icon} />
                            <span className="sb-text">{n.label}</span>
                            {n.badge && n.badge.count > 0 && <Badge tone={n.badge.tone ?? "neutral"} className="sb-badge">{n.badge.count}</Badge>}
                        </a>
                    ))}
                </div>
            ))}
        </nav>
        <div className="sb-foot">
            {footer}
            <IconButton className="sb-toggle" variant="ghost" size="sm" icon={collapsed ? "chevronRight" : "chevronLeft"} label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onToggleCollapsed} />
        </div>
    </aside>
);
