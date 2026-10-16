import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { storage } from "../storage";
import { useDismiss } from "./useDismiss";
import { Button, Input } from "@vortex/ds";

// Stagehand's standard list of entities. Every page that lists things uses it, so lists look and behave alike:
//
//   header row   <title>                                         [Create new <entity>]
//   tools row    [filter] [search…]            (n selected · bulk actions)   [columns]
//   (filters)    one group per filterable column: its distinct values, multi-select
//   table        [☐] <columns…>    — sortable headers, a row click opens the entity
//
// One value per cell: a cell shows its column's value on one line (a chip, a link, a code span), never a second line of
// extra detail under it — information worth showing gets a column of its own (the user, 2026-10-06). Cells do not wrap.
// A column says how to read a row (`value`, for sorting, searching and filtering) apart from how to show it (`render`).
// Columns with few distinct values (status, type, …) get a filter; free-form text is only searched. Which columns are
// shown is remembered per browser under `storageKey`.

export interface DataColumn<T> {
    key: string;
    label: string;
    // The plain value of the cell: sorted by, searched in, filtered on. Without it the column is display-only.
    value?: (row: T) => string | number | boolean | null | undefined;
    // How the cell looks; defaults to the value.
    render?: (row: T) => ReactNode;
    // "auto": a filter when the column has 2–20 distinct values; true: always; false: never (free-form text).
    filter?: boolean | "auto";
    // Searched by the search box (default: true when the column has a value).
    searchable?: boolean;
    // Sortable by clicking its header (default: true when the column has a value).
    sortable?: boolean;
    // Hidden until picked in the column picker.
    defaultHidden?: boolean;
    // "label" = the wide, wrapping main column; "num" = mono, right-aligned.
    kind?: "label" | "num";
    hint?: string;
}

type Sort = { key: string; desc: boolean };
type Filters = Record<string, string[]>;

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

const FilterIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.5 2.5h13l-5 6v5l-3-1.5v-3.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
);
const ColumnsIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6 2.5v11M10.5 2.5v11" stroke="currentColor" strokeWidth="1.4" />
    </svg>
);

// A checkbox that can show "some selected".
const Check = ({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (on: boolean) => void; label: string }) => {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
    }, [indeterminate, checked]);
    return <Input ref={ref} type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} onClick={(e) => e.stopPropagation()} />;
};

export const DataTable = <T,>({
    title,
    entity,
    actions,
    onCreate,
    createDisabled,
    columns,
    rows,
    rowKey,
    onRowClick,
    activeKey,
    bulkActions,
    selectable = true,
    empty = "Nothing here yet.",
    defaultSort,
    storageKey,
}: {
    // The header row: the list's name on the left, "Create new <entity>" on the right (when onCreate is given).
    title?: ReactNode;
    entity?: string;
    // More list-level actions in the header row, left of Create new (e.g. Refresh).
    actions?: ReactNode;
    onCreate?: () => void;
    createDisabled?: string;
    columns: DataColumn<T>[];
    rows: T[];
    rowKey: (row: T) => string;
    onRowClick?: (row: T) => void;
    // The row whose entity is open, highlighted.
    activeKey?: string | null;
    // Shown in the tools row while rows are checked; `clear` unchecks them all.
    bulkActions?: (selected: T[], clear: () => void) => ReactNode;
    selectable?: boolean;
    empty?: ReactNode;
    defaultSort?: Sort;
    // Remembers the picked columns per browser.
    storageKey?: string;
}) => {
    const [query, setQuery] = useState("");
    const [filters, setFilters] = useState<Filters>({});
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [sort, setSort] = useState<Sort | null>(defaultSort ?? null);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [hidden, setHidden] = useState<Set<string>>(() => {
        const saved = storageKey ? storage.get(`stagehand.table.${storageKey}.hidden`) : null;
        if (saved) {
            try {
                return new Set(JSON.parse(saved) as string[]);
            } catch {
                /* fall through to the defaults */
            }
        }
        return new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key));
    });
    const pickerRef = useDismiss(pickerOpen, () => setPickerOpen(false));

    const toggleHidden = (key: string): void =>
        setHidden((cur) => {
            const next = new Set(cur);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            if (storageKey) storage.set(`stagehand.table.${storageKey}.hidden`, JSON.stringify([...next]));
            return next;
        });

    // Distinct values per filterable column, from all rows (so a filter never hides its own options).
    const facets = useMemo(() => {
        const out: Array<{ col: DataColumn<T>; values: string[] }> = [];
        for (const c of columns) {
            // Only shown columns offer a filter; hiding a column also drops its filter (below).
            if (!c.value || c.filter === false || hidden.has(c.key)) continue;
            const values = [...new Set(rows.map((r) => text(c.value!(r))))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const auto = values.length >= 2 && values.length <= 20;
            if (c.filter === true || (c.filter === "auto" && auto)) out.push({ col: c, values });
        }
        return out;
    }, [columns, rows, hidden]);

    const visibleCols = columns.filter((c) => !hidden.has(c.key));
    const activeFilters = Object.entries(filters).reduce((n, [k, v]) => n + (v.length && !hidden.has(k) ? 1 : 0), 0);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        let out = rows.filter((r) => {
            for (const [key, vals] of Object.entries(filters)) {
                if (!vals.length || hidden.has(key)) continue;
                const c = columns.find((x) => x.key === key);
                if (c?.value && !vals.includes(text(c.value(r)))) return false;
            }
            if (!q) return true;
            return columns.some((c) => c.value && c.searchable !== false && text(c.value(r)).toLowerCase().includes(q));
        });
        const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
        if (sort && col?.value) {
            const v = col.value;
            out = [...out].sort((a, b) => {
                const x = v(a);
                const y = v(b);
                if (x == null && y == null) return 0;
                if (x == null) return 1;
                if (y == null) return -1;
                const d = typeof x === "number" && typeof y === "number" ? x - y : text(x).localeCompare(text(y), undefined, { numeric: true });
                return sort.desc ? -d : d;
            });
        }
        return out;
    }, [rows, columns, filters, query, sort, hidden]);

    // Checked rows that still exist (a deleted row drops out of the selection).
    const selected = rows.filter((r) => checked.has(rowKey(r)));
    const shownKeys = shown.map(rowKey);
    const allShownChecked = shownKeys.length > 0 && shownKeys.every((k) => checked.has(k));
    const someShownChecked = shownKeys.some((k) => checked.has(k));
    const setRow = (key: string, on: boolean): void =>
        setChecked((cur) => {
            const next = new Set(cur);
            if (on) next.add(key);
            else next.delete(key);
            return next;
        });
    const setAllShown = (on: boolean): void =>
        setChecked((cur) => {
            const next = new Set(cur);
            for (const k of shownKeys) on ? next.add(k) : next.delete(k);
            return next;
        });
    const clear = (): void => setChecked(new Set());

    // First click sorts ascending, second descending, third clears.
    const clickHeader = (c: DataColumn<T>): void => {
        if (!c.value || c.sortable === false) return;
        setSort((s) => (s?.key !== c.key ? { key: c.key, desc: false } : !s.desc ? { key: c.key, desc: true } : null));
    };
    const toggleFilter = (key: string, value: string): void =>
        setFilters((cur) => {
            const vals = cur[key] ?? [];
            return { ...cur, [key]: vals.includes(value) ? vals.filter((v) => v !== value) : [...vals, value] };
        });

    return (
        <div className="data-table">
            {(title || onCreate || actions) && (
                <div className="dt-header">
                    <h2 className="dt-title">{title}</h2>
                    {actions && <span className="dt-actions">{actions}</span>}
                    {onCreate && (
                        <Button variant="primary" disabled={!!createDisabled} title={createDisabled} onClick={onCreate}>
                            + Create new {entity ?? "item"}
                        </Button>
                    )}
                </div>
            )}
            <div className="dt-tools">
                <Button
 className={`dt-icon${filtersOpen || activeFilters ? " on" : ""}`}
 disabled={!facets.length}
 title={facets.length ? "Filter by column values" : "No column to filter by"}
 aria-label="Filters"
 onClick={() => setFiltersOpen((o) => !o)}
>
                    <FilterIcon />
                    {activeFilters > 0 && <span className="dt-badge">{activeFilters}</span>}
                </Button>
                <Input className="dt-search" type="search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
                <span className="dt-spacer" />
                {selectable && selected.length > 0 && (
                    <span className="dt-bulk">
                        <b>{selected.length} selected</b>
                        {bulkActions?.(selected, clear)}
                        <Button size="sm" onClick={clear}>Clear</Button>
                    </span>
                )}
                <div className="dt-picker" ref={pickerRef}>
                    <Button className={`dt-icon${pickerOpen ? " on" : ""}`} title="Choose columns" aria-label="Columns" onClick={() => setPickerOpen((o) => !o)}>
                        <ColumnsIcon />
                    </Button>
                    {pickerOpen && (
                        <div className="dt-menu" role="menu">
                            {columns.map((c) => (
                                <label key={c.key} className="dt-menu-item">
                                    <Input type="checkbox" checked={!hidden.has(c.key)} disabled={!hidden.has(c.key) && visibleCols.length === 1} onChange={() => toggleHidden(c.key)} />
                                    {c.label}
                                </label>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            {filtersOpen && facets.length > 0 && (
                <div className="dt-filters">
                    {facets.map(({ col, values }) => (
                        <div key={col.key} className="dt-facet">
                            <span className="dt-facet-label">{col.label}</span>
                            {values.map((v) => (
                                <Button key={v} className={`dt-chip${filters[col.key]?.includes(v) ? " on" : ""}`} onClick={() => toggleFilter(col.key, v)}>
                                    {v || "—"}
                                </Button>
                            ))}
                        </div>
                    ))}
                    {activeFilters > 0 && (
                        <Button size="sm" onClick={() => setFilters({})}>
                            Reset filters
                        </Button>
                    )}
                </div>
            )}
            {!rows.length ? (
                <div className="empty">{empty}</div>
            ) : !shown.length ? (
                <div className="empty">No row matches the search or filters.</div>
            ) : (
                <div className="dt-scroll">
                    <table>
                        <thead>
                            <tr>
                                {selectable && (
                                    <th className="dt-check">
                                        <Check label="Select all shown" checked={allShownChecked} indeterminate={someShownChecked} onChange={setAllShown} />
                                    </th>
                                )}
                                {visibleCols.map((c) => {
                                    const sortable = !!c.value && c.sortable !== false;
                                    return (
                                        <th key={c.key} className={`${sortable ? "sortable" : ""}${c.kind === "num" ? " num" : ""}`} title={c.hint} onClick={() => clickHeader(c)} aria-sort={sort?.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
                                            {c.label}
                                            {c.hint && <span className="hint-mark"> ⓘ</span>}
                                            {sort?.key === c.key ? (sort.desc ? " ▼" : " ▲") : ""}
                                        </th>
                                    );
                                })}
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((r) => {
                                const k = rowKey(r);
                                return (
                                    <tr key={k} className={`${onRowClick ? "clickable" : ""}${activeKey === k ? " active" : ""}${checked.has(k) ? " checked" : ""}`} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                                        {selectable && (
                                            <td className="dt-check" onClick={(e) => e.stopPropagation()}>
                                                <Check label="Select row" checked={checked.has(k)} onChange={(on) => setRow(k, on)} />
                                            </td>
                                        )}
                                        {visibleCols.map((c) => (
                                            <td key={c.key} className={c.kind === "label" ? "dt-label" : c.kind === "num" ? "mono num" : undefined}>
                                                {c.render ? c.render(r) : text(c.value?.(r))}
                                            </td>
                                        ))}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {rows.length > 0 && (
                <div className="dt-footer">
                    {shown.length === rows.length ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}` : `${shown.length} of ${rows.length} rows`}
                </div>
            )}
        </div>
    );
};
