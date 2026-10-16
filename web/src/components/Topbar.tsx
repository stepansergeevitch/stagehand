import type { ReactNode } from "react";
import { Icon, IconButton, Kbd, Wordmark } from "@vortex/ds";

// The bar over the content: the menu button (narrow screens), the search / command palette trigger, then the global
// status on the right (live connection, usage). It carries no page title: that is the PageHeader's job.
export const Topbar = ({ onMenu, onSearch, children }: { onMenu: () => void; onSearch: () => void; children?: ReactNode }) => (
    <header className="topbar">
        <IconButton className="tb-menu" variant="ghost" icon="menu" label="Open navigation" onClick={onMenu} />
        <Wordmark className="tb-brand" size="sm" markOnly />
        <button type="button" className="tb-search" onClick={onSearch} aria-label="Search tasks and pages">
            <Icon name="search" />
            <span className="tb-search-text">Search tasks, pages, environments</span>
            <span className="tb-search-keys"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
        </button>
        <span className="tb-spacer" />
        <div className="tb-status">{children}</div>
    </header>
);
