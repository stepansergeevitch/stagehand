import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { storage } from "../storage";
import { useDismiss } from "./useDismiss";
import { Badge, Button, EmptyState, Hint, Icon, IconButton, Input, Menu, Checkbox } from "@vortex/ds";
import { PageHeader } from "./PageHeader";
import { Toolbar } from "./Toolbar";
import "./datatable.css";

// Vortex's standard list of entities. Every page that lists things uses it, so lists look and behave alike:
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
//
// Layout (docs/ux-redesign.md §4.1): the page header (title, list actions, Create new) sits above the table box, which
// holds the tools row, the optional filter row and the table. `embedded` renders the header as a section heading, for a
// list inside another page's tab.

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
    // A column that holds several values per row (labels): they are the filter's options, a row matches any picked one.
    values?: (row: T) => string[];
    // "label" = the wide, wrapping main column; "num" = mono, right-aligned.
    kind?: "label" | "num";
    hint?: string;
}

// Rows can be grouped under collapsible heads (the Tasks list: Needs you, Running, …). Groups show in the given order, the
// column sort applies inside each; an empty group is not shown.
export interface DataGroup {
    key: string;
    label: ReactNode;
    // Starts folded.
    collapsed?: boolean;
}

type Sort = { key: string; desc: boolean };
export type Filters = Record<string, string[]>;

const text = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

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
    embedded,
    groups,
    groupOf,
    query: queryProp,
    onQuery,
    filters: filtersProp,
    onFilters,
    resultLine,
    card,
    bare,
    topBar,
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
    // A list inside another page's tab: the header is a section heading, not the page's h1.
    embedded?: boolean;
    // Group the rows: `groupOf` names a row's group (a `groups` key), `groups` lists the groups in display order.
    groups?: DataGroup[];
    groupOf?: (row: T) => string;
    // Search and filters kept by the page (the Tasks list keeps them in the URL); without them the table keeps its own.
    query?: string;
    onQuery?: (q: string) => void;
    filters?: Filters;
    onFilters?: (f: Filters) => void;
    // A line under the active-filter chips: how many rows match (shown, all).
    resultLine?: (shown: number, all: number) => ReactNode;
    // On a phone the row becomes this card (the cells are hidden); its own button stays a 44px target.
    card?: (row: T) => ReactNode;
    // Only the table box: no page header, tools row, filter chips, footer or column picker (the page draws its own, as the
    // Tasks list does). Checked rows raise a floating bulk bar at the bottom of the screen.
    bare?: boolean;
    // A bar across the top of the table box (the live-update pill).
    topBar?: ReactNode;
}) => {
    const [ownQuery, setOwnQuery] = useState("");
    const [ownFilters, setOwnFilters] = useState<Filters>({});
    const query = queryProp ?? ownQuery;
    const setQuery = (q: string): void => (onQuery ? onQuery(q) : setOwnQuery(q));
    const filters = filtersProp ?? ownFilters;
    const setFilters = (f: Filters | ((cur: Filters) => Filters)): void => {
        const next = typeof f === "function" ? f(filters) : f;
        if (onFilters) onFilters(next);
        else setOwnFilters(next);
    };
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [sort, setSort] = useState<Sort | null>(defaultSort ?? null);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [hidden, setHidden] = useState<Set<string>>(() => {
        const saved = storageKey ? storage.get(`vortex.table.${storageKey}.hidden`) : null;
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
    // Folded groups: transient, starts from each group's own default.
    const [folded, setFolded] = useState<Set<string>>(() => new Set((groups ?? []).filter((g) => g.collapsed).map((g) => g.key)));
    const toggleGroup = (key: string): void =>
        setFolded((cur) => {
            const next = new Set(cur);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const toggleHidden = (key: string): void =>
        setHidden((cur) => {
            const next = new Set(cur);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            if (storageKey) storage.set(`vortex.table.${storageKey}.hidden`, JSON.stringify([...next]));
            return next;
        });

    // Distinct values per filterable column, from all rows (so a filter never hides its own options).
    const facets = useMemo(() => {
        const out: Array<{ col: DataColumn<T>; values: string[] }> = [];
        for (const c of columns) {
            // Only shown columns offer a filter; hiding a column also drops its filter (below).
            if (!c.value || c.filter === false || hidden.has(c.key)) continue;
            const values = [...new Set(rows.flatMap((r) => (c.values ? c.values(r) : [text(c.value!(r))])))].filter((v) => v !== "" || !c.values).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
                if (c?.values ? !c.values(r).some((v) => vals.includes(v)) : c?.value && !vals.includes(text(c.value(r)))) return false;
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

    // Emacs keys on a focused row: C-n / C-p (and the arrows) move to the next / previous row, C-SPC checks it. Match the
    // physical key (`e.code`): Ctrl+letter is not remapped, but the rule is the same everywhere.
    const onTableKey = (e: KeyboardEvent<HTMLElement>): void => {
        const row = (e.target as HTMLElement).closest<HTMLElement>("tr[data-row]");
        if (!row) return;
        const onRow = e.target === row;
        const next = e.code === "KeyN" && e.ctrlKey ? 1 : e.code === "KeyP" && e.ctrlKey ? -1 : onRow && e.key === "ArrowDown" ? 1 : onRow && e.key === "ArrowUp" ? -1 : 0;
        if (next) {
            const all = [...(row.closest("table")?.querySelectorAll<HTMLElement>("tr[data-row]") ?? [])];
            all[all.indexOf(row) + next]?.focus();
            e.preventDefault();
        } else if (e.code === "Space" && e.ctrlKey && selectable) {
            const key = row.dataset.row;
            if (key) setRow(key, !checked.has(key));
            e.preventDefault();
        }
    };

    const actionsRow = (
        <>
            {actions}
            {onCreate && (
                <Button variant="primary" disabled={!!createDisabled} title={createDisabled} onClick={onCreate}>
                    <Icon name="plus" />Create new {entity ?? "item"}
                </Button>
            )}
        </>
    );
    const hasHeader = !!(title || onCreate || actions);
    return (
        <div className="data-table-wrap">
            {!bare && hasHeader && (embedded ? (
                <div className="dt-section-head">
                    <h2>{title}</h2>
                    <div className="dt-actions">{actionsRow}</div>
                </div>
            ) : (
                <PageHeader title={title} actions={actionsRow} />
            ))}
            <div className={`data-table${bare ? " bare" : ""}`}>
                {topBar}
                {!bare && <Toolbar
                    className="dt-tools"
                    end={
                        <>
                            {selectable && selected.length > 0 && (
                                <span className="dt-bulk">
                                    <b>{selected.length} selected</b>
                                    {bulkActions?.(selected, clear)}
                                    <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>
                                </span>
                            )}
                            <div className="dt-picker" ref={pickerRef}>
                                <IconButton icon="columns" label="Choose columns" variant="ghost" on={pickerOpen} aria-expanded={pickerOpen} onClick={() => setPickerOpen((o) => !o)} />
                                {pickerOpen && (
                                    <Menu className="dt-menu">
                                        {columns.map((c) => (
                                            <Checkbox key={c.key} className="dt-menu-item" label={c.label} checked={!hidden.has(c.key)} disabled={!hidden.has(c.key) && visibleCols.length === 1} onChange={() => toggleHidden(c.key)} />
                                        ))}
                                    </Menu>
                                )}
                            </div>
                        </>
                    }
                >
                    <label className="dt-search">
                        <Icon name="search" />
                        <Input type="search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
                    </label>
                    <Button
                        className="dt-filter-btn"
                        on={filtersOpen || activeFilters > 0}
                        disabled={!facets.length}
                        title={facets.length ? "Filter by column values" : "No column to filter by"}
                        aria-expanded={filtersOpen}
                        onClick={() => setFiltersOpen((o) => !o)}
                    >
                        <Icon name="filter" />Filter
                        {activeFilters > 0 && <Badge tone="accent">{activeFilters}</Badge>}
                    </Button>
                </Toolbar>}
                {!bare && filtersOpen && facets.length > 0 && (
                    <div className="dt-filters">
                        {facets.map(({ col, values }) => (
                            <div key={col.key} className="dt-facet">
                                <span className="dt-facet-label">{col.label}</span>
                                {values.map((v) => (
                                    <Button key={v} size="sm" className="dt-chip" on={filters[col.key]?.includes(v)} aria-pressed={!!filters[col.key]?.includes(v)} onClick={() => toggleFilter(col.key, v)}>
                                        {v || "—"}
                                    </Button>
                                ))}
                            </div>
                        ))}
                        {activeFilters > 0 && (
                            <Button size="sm" variant="ghost" onClick={() => setFilters({})}>
                                Reset filters
                            </Button>
                        )}
                    </div>
                )}
                {!bare && (activeFilters > 0 || query.trim()) && (
                    <div className="dt-active">
                        {query.trim() && <Button size="sm" className="dt-chip on" aria-label={`Clear search ${query}`} onClick={() => setQuery("")}>Search: {query.trim()} <Icon name="close" /></Button>}
                        {Object.entries(filters).flatMap(([key, vals]) => hidden.has(key) ? [] : vals.map((v) => (
                            <Button key={`${key}:${v}`} size="sm" className="dt-chip on" aria-label={`Remove filter ${columns.find((c) => c.key === key)?.label ?? key} ${v}`} onClick={() => toggleFilter(key, v)}>
                                {columns.find((c) => c.key === key)?.label ?? key}: {v || "—"} <Icon name="close" />
                            </Button>
                        )))}
                        <Button size="sm" variant="ghost" onClick={() => { setFilters({}); setQuery(""); }}>Clear all</Button>
                        {resultLine && <span className="dt-result" role="status">{resultLine(shown.length, rows.length)}</span>}
                    </div>
                )}
                {!rows.length ? (
                    <div className="dt-empty">{typeof empty === "string" ? <EmptyState title={empty} action={onCreate ? <Button variant="primary" disabled={!!createDisabled} onClick={onCreate}><Icon name="plus" />Create new {entity ?? "item"}</Button> : undefined} /> : empty}</div>
                ) : !shown.length ? (
                    <div className="dt-empty"><EmptyState icon="search" title="No row matches">Change the search or reset the filters.</EmptyState></div>
                ) : (
                    <div className="dt-scroll">
                        <table onKeyDown={onTableKey} className={card ? "has-card" : undefined}>
                            <thead>
                                <tr>
                                    {selectable && (
                                        <th className="dt-check">
                                            <Check label="Select all shown" checked={allShownChecked} indeterminate={someShownChecked} onChange={setAllShown} />
                                        </th>
                                    )}
                                    {visibleCols.map((c) => {
                                        const sortable = !!c.value && c.sortable !== false;
                                        const dir = sort?.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined;
                                        return (
                                            <th key={c.key} className={`${sortable ? "sortable" : ""}${c.kind === "num" ? " num" : ""}`} onClick={() => clickHeader(c)} aria-sort={dir ?? (sortable ? "none" : undefined)}>
                                                <span className="dt-th">
                                                    {c.label}
                                                    {c.hint && <Hint text={c.hint} />}
                                                    {dir && <Icon name={dir === "descending" ? "chevronDown" : "chevronUp"} />}
                                                </span>
                                            </th>
                                        );
                                    })}
                                </tr>
                            </thead>
                            <tbody>
                                {(groups ? groups.map((g) => ({ g, rows: shown.filter((r) => groupOf?.(r) === g.key) })).filter((x) => x.rows.length) : [{ g: null as DataGroup | null, rows: shown }]).map(({ g, rows: part }) => (
                                    <Fragment key={g?.key ?? "all"}>
                                        {g && (
                                            <tr className="dt-group" data-group={g.key}>
                                                <td colSpan={visibleCols.length + (selectable ? 1 : 0)}>
                                                    <button type="button" aria-expanded={!folded.has(g.key)} onClick={() => toggleGroup(g.key)}>
                                                        <Icon name={folded.has(g.key) ? "chevronRight" : "chevronDown"} />
                                                        {g.label}
                                                        <span className="dt-group-count">{part.length}</span>
                                                    </button>
                                                </td>
                                            </tr>
                                        )}
                                        {!(g && folded.has(g.key)) && part.map((r) => {
                                            const k = rowKey(r);
                                            return (
                                                <tr
                                                    key={k}
                                                    data-row={k}
                                                    className={`${onRowClick ? "clickable" : ""}${activeKey === k ? " active" : ""}${checked.has(k) ? " checked" : ""}`}
                                                    tabIndex={onRowClick ? 0 : undefined}
                                                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                                                    onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(r); } : undefined}
                                                >
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
                                                    {card && <td className="dt-card" colSpan={visibleCols.length}>{card(r)}</td>}
                                                </tr>
                                            );
                                        })}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {!bare && rows.length > 0 && (
                    <div className="dt-footer">
                        {shown.length === rows.length ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}` : `${shown.length} of ${rows.length} rows`}
                    </div>
                )}
            </div>
            {bare && selectable && selected.length > 0 && (
                <div className="dt-bulkbar" role="region" aria-label="Bulk actions">
                    <span role="status">{selected.length} {selected.length === 1 ? (entity ?? "item") : `${entity ?? "item"}s`} selected</span>
                    {bulkActions?.(selected, clear)}
                    <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>
                </div>
            )}
        </div>
    );
};
