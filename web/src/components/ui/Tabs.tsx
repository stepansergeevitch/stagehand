import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

// Tabs hold no state: the active one comes from the route (routes.ts) and selecting one navigates.

// The strip. `line` is a section's tab bar (underlined); `pill` is the compact second level inside a tab.
export const TabList = ({ variant = "line", className, ...rest }: { variant?: "line" | "pill" } & HTMLAttributes<HTMLDivElement>) => (
    <div role="tablist" className={[variant === "pill" ? "subtabs" : "tabs", className].filter(Boolean).join(" ")} {...rest} />
);

export const Tab = ({ active, className, ...rest }: { active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" role="tab" aria-selected={!!active} className={["tab", active && "active", className].filter(Boolean).join(" ")} {...rest} />
);

export interface TabItem { key: string; label: ReactNode }

// The common case: a fixed list of tabs.
export const Tabs = ({ items, active, onChange, variant = "line", className }: { items: TabItem[]; active: string | undefined; onChange: (key: string) => void; variant?: "line" | "pill"; className?: string }) => (
    <TabList variant={variant} {...(className ? { className } : {})}>
        {items.map((t) => <Tab key={t.key} active={t.key === active} onClick={() => onChange(t.key)}>{t.label}</Tab>)}
    </TabList>
);
