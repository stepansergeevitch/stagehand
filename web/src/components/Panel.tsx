import type { ReactNode } from "react";
import { Card, Hint } from "@vortex/ds";

// A titled surface for one related group of content. `flush` removes the padding (a table or list edge to edge);
// `tone` draws a coloured edge for a panel that is about a problem or a pending action.
export const Panel = ({ title, hint, badge, actions, footer, flush, tone, className, children }: {
    title?: ReactNode;
    hint?: ReactNode;
    badge?: ReactNode;
    actions?: ReactNode;
    footer?: ReactNode;
    flush?: boolean;
    tone?: "warn" | "bad" | "info" | "wait" | "ok";
    className?: string;
    children?: ReactNode;
}) => (
    <Card
        className={["panel", flush && "flush", tone && `tone-${tone}`, className].filter(Boolean).join(" ")}
        title={title !== undefined ? <>{title}{hint ? <Hint text={hint} /> : null}</> : undefined}
        badge={badge}
        actions={actions}
        footer={footer}
    >
        {children}
    </Card>
);

// A heading with its content and no box: for the groups inside a tab or a panel.
export const Section = ({ title, hint, actions, children }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) => (
    <section className="section">
        <div className="section-head">
            <h2>{title}{hint ? <Hint text={hint} /> : null}</h2>
            {actions && <div className="section-actions">{actions}</div>}
        </div>
        {children}
    </section>
);
