import { useMemo, useState, type ReactNode } from "react";

// Stagehand's list table: named columns, one row per item, optional sorting by column and a row click. Styled as the
// usage tables (.usage-table): mono numbers, a label column that wraps, horizontal scroll on a narrow screen.
export interface ListColumn<T> {
    key: string;
    label: string;
    render: (row: T) => ReactNode;
    // A sortable column gives the value to sort by; numbers sort numerically, strings by locale (numeric-aware).
    sort?: (row: T) => number | string | null;
    hint?: string;
    // "label" = the wide, wrapping first column; "num" = mono, right-aligned.
    kind?: "label" | "num";
}

export const ListTable = <T,>({
    columns,
    rows,
    rowKey,
    onRowClick,
    empty = "Nothing here.",
    defaultSort,
}: {
    columns: ListColumn<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    onRowClick?: (row: T) => void;
    empty?: ReactNode;
    defaultSort?: { key: string; desc: boolean };
}) => {
    const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(defaultSort ?? null);
    const sorted = useMemo(() => {
        const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
        if (!sort || !col?.sort) return rows;
        const v = col.sort;
        return [...rows].sort((a, b) => {
            const x = v(a);
            const y = v(b);
            if (x == null && y == null) return 0;
            if (x == null) return 1;
            if (y == null) return -1;
            const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
            return sort.desc ? -d : d;
        });
    }, [rows, columns, sort]);
    // First click descending (biggest first), second ascending, third off.
    const click = (c: ListColumn<T>): void => {
        if (!c.sort) return;
        setSort((s) => (s?.key !== c.key ? { key: c.key, desc: true } : s.desc ? { key: c.key, desc: false } : null));
    };
    if (!rows.length) return <div className="empty">{empty}</div>;
    return (
        <div className="usage-table list-table">
            <table>
                <thead>
                    <tr>
                        {columns.map((c) => (
                            <th key={c.key} className={`${c.sort ? "sortable" : ""}${c.kind === "num" ? " num" : ""}`} title={c.hint} onClick={() => click(c)}>
                                {c.label}
                                {c.hint && <span className="hint-mark"> ⓘ</span>}
                                {sort?.key === c.key ? (sort.desc ? " ▼" : " ▲") : ""}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map((r) => (
                        <tr key={rowKey(r)} className={onRowClick ? "clickable" : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                            {columns.map((c) => (
                                <td key={c.key} className={c.kind === "label" ? "usage-label" : c.kind === "num" ? "mono num" : undefined}>
                                    {c.render(r)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};
