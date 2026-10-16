import type { ReactNode } from "react";
import { Hint } from "@vortex/ds";

export interface KeyValueItem {
    label: ReactNode;
    value: ReactNode;
    hint?: ReactNode;
    // Machine text (branch, path, id): mono, wraps anywhere.
    mono?: boolean;
}

// Read-only facts as label / value pairs (a definition list). Use it instead of ad-hoc "kv" grids.
export const KeyValue = ({ items, columns = 1 }: { items: KeyValueItem[]; columns?: 1 | 2 | 3 }) => (
    <dl className={`kv-list cols-${columns}`}>
        {items.map((it, i) => (
            <div key={i} className="kv-item">
                <dt>{it.label}{it.hint ? <Hint text={it.hint} /> : null}</dt>
                <dd className={it.mono ? "mono" : undefined}>{it.value}</dd>
            </div>
        ))}
    </dl>
);
