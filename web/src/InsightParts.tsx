import { Tabs } from "@vortex/ds";
import "./insights.css";

// The pieces Usage and Timing share: the period picker, a share-of-total bar for a table cell, a one-series bar chart
// and a split bar. Charts follow the dataviz rules: tokens only, labelled axes, a tooltip on hover and focus, every
// value also in text (legend, aria-label) so colour never carries a meaning alone; the table under a chart is its
// table view.

export const PERIODS: Array<{ days: number; label: string }> = [
    { days: 1, label: "24 hours" },
    { days: 7, label: "7 days" },
    { days: 30, label: "30 days" },
    { days: 0, label: "All time" },
];

export const PeriodTabs = ({ days, onDays }: { days: number; onDays: (days: number) => void }) => (
    <Tabs variant="pill" items={PERIODS.map((p) => ({ key: String(p.days), label: p.label }))} active={String(days)} onChange={(k) => onDays(Number(k))} />
);

const percent = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

// A cell value: the share as a number with a thin bar behind the eye, never the bar alone.
export const ShareBar = ({ part, total }: { part: number; total: number }) => {
    const p = percent(part, total);
    return (
        <span className="ins-share">
            <span className="ins-share-track" aria-hidden="true"><i style={{ width: `${p}%` }} /></span>
            <span className="ins-share-num">{p}%</span>
        </span>
    );
};

// Round the top of an axis up to 1, 2, 2.5, 5 or 10 times a power of ten, so the ticks read as plain numbers.
const niceMax = (v: number): number => {
    if (v <= 0) return 1;
    const pow = 10 ** Math.floor(Math.log10(v));
    const n = v / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
};

export interface BarPoint {
    key: string;
    // The x label, shown on the axis ends and in the tooltip.
    label: string;
    value: number;
}

// One series over an ordered axis (days): thin bars with a rounded top on the baseline, three y ticks, the first,
// middle and last x label, a tooltip on hover or keyboard focus.
export const BarChart = ({ data, format, title, yTitle, xTitle }: { data: BarPoint[]; format: (v: number) => string; title: string; yTitle: string; xTitle: string }) => {
    const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
    const last = data.length - 1;
    const mid = data[Math.floor(last / 2)];
    return (
        <figure className="bc">
            <figcaption className="bc-title">{yTitle}</figcaption>
            <div className="bc-body">
                <div className="bc-y" aria-hidden="true">
                    <span>{format(max)}</span>
                    <span>{format(max / 2)}</span>
                    <span>0</span>
                </div>
                <div className="bc-plot" role="group" aria-label={title}>
                    <div className="bc-grid" aria-hidden="true"><i /><i /><i /></div>
                    <div className="bc-cols">
                        {data.map((d, i) => (
                            <div key={d.key} className={`bc-col${i < data.length / 4 ? " start" : i >= (data.length * 3) / 4 ? " end" : ""}`} tabIndex={0} aria-label={`${d.label}: ${format(d.value)}`}>
                                <span className="bc-bar" style={{ height: d.value > 0 ? `max(2px, ${(d.value / max) * 100}%)` : 0 }} />
                                <span className="bc-tip" role="tooltip" style={{ bottom: `calc(${(d.value / max) * 100}% + var(--sp-2))` }}>
                                    <b>{format(d.value)}</b>
                                    <span>{d.label}</span>
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <div className="bc-x" aria-hidden="true">
                <span>{data[0]?.label}</span>
                {data.length > 2 && <span>{mid?.label}</span>}
                {data.length > 1 && <span>{data[last]?.label}</span>}
            </div>
            <div className="bc-xtitle">{xTitle}</div>
        </figure>
    );
};

export interface Part {
    key: string;
    label: string;
    value: number;
    // Shown after the value in the legend ("3.2 h"); the caller's formatter.
    text: string;
    // 1..4: which fixed slot colour the segment takes (in insights.css), by the part's meaning, never by its rank.
    slot: 1 | 2 | 3 | 4;
}

// One whole split into named parts: a segmented bar with a 2px gap between segments, and a legend that carries every
// part's name, value and share, so the colours only repeat what the words say.
export const SplitBar = ({ parts, title }: { parts: Part[]; title: string }) => {
    const total = parts.reduce((s, p) => s + p.value, 0);
    return (
        <div className="sb">
            <div className="sb-bar" role="img" aria-label={`${title}: ${parts.map((p) => `${p.label} ${p.text} (${percent(p.value, total)}%)`).join(", ")}`}>
                {parts.filter((p) => p.value > 0).map((p) => (
                    <span key={p.key} className={`sb-seg slot-${p.slot}`} style={{ flexGrow: p.value }} title={`${p.label}: ${p.text} (${percent(p.value, total)}%)`} />
                ))}
            </div>
            <ul className="sb-legend">
                {parts.map((p) => (
                    <li key={p.key}>
                        <span className={`sb-swatch slot-${p.slot}`} aria-hidden="true" />
                        <span className="sb-name">{p.label}</span>
                        <span className="sb-val">{p.text}</span>
                        <span className="sb-pct">{percent(p.value, total)}%</span>
                    </li>
                ))}
            </ul>
        </div>
    );
};
