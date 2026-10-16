import type { ReactNode } from "react";

// A card whose body folds behind its header (▸ / ▾). The one collapsible block: chats, long documents, anything that
// should not take the page unless asked for. The open state is transient UI, so it lives in the <details> itself.
export const Collapsible = ({ title, hint, defaultOpen = false, children }: { title: ReactNode; hint?: ReactNode; defaultOpen?: boolean; children: ReactNode }) => (
    <details className="card" open={defaultOpen}>
        <summary>
            <h2>{title}{hint ? <> <span className="field-hint">{hint}</span></> : null}</h2>
        </summary>
        <div className="card-body">{children}</div>
    </details>
);
