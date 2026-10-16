import { useState } from "react";
import { Chip, Icon, IconButton, Popover, StatusDot, type Tone } from "@vortex/ds";
import type { Account } from "../api";
import { useDismiss } from "./useDismiss";
import "./usage.css";

const fmtTokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const fmtMoney = (n: number): string => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const toneOf = (u: number): Tone => (u >= 0.9 ? "bad" : u >= 0.6 ? "warn" : "ok");

type Limit = Account["limits"][number] | undefined;
const pct = (l: Limit): string => (!l ? "—" : l.expired ? "?" : `${Math.round(l.utilization * 100)}%`);
const fill = (l: Limit): number => (!l || l.expired ? 0 : l.utilization);

const Meter = ({ label, l }: { label: string; l: Limit }) => (
    <span className="meter-row">
        <span className="meter-label">{label}</span>
        <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill(l) * 100)} aria-label={`${label} window`}>
            <i className={toneOf(fill(l))} style={{ width: `${Math.round(fill(l) * 100)}%` }} />
        </span>
        <span className="meter-pct">{pct(l)}</span>
    </span>
);

const AccountRow = ({ a, onRefresh }: { a: Account; onRefresh: () => void }) => {
    const five = a.limits.find((l) => l.window === "five_hour");
    const week = a.limits.find((l) => l.window === "seven_day");
    const enterprise = a.plan === "enterprise";
    const usage = a.usage ?? { today: { tokens: 0, cost: 0 }, week: { tokens: 0, cost: 0 } };
    const stale = !!five?.expired || !!week?.expired;
    return (
        <div className="usage-account">
            <div className="usage-head">
                <b>{a.name}</b>
                {!a.logged_in && <Chip tone="bad">No auth</Chip>}
                {a.logged_in === 1 && !a.has_token && <Chip tone="warn">Legacy login</Chip>}
                <span className="usage-plan">{a.plan ?? ""}</span>
                {!enterprise && a.logged_in === 1 && (
                    <IconButton variant="ghost" size="sm" icon="refresh" label="Refresh the windows now (one tiny Sonnet turn)" disabled={a.refreshing_limits} onClick={onRefresh} />
                )}
            </div>
            {enterprise ? (
                <div className="usage-totals">
                    <span><small>Today</small> {fmtTokens(usage.today.tokens)} · {fmtMoney(usage.today.cost)}</span>
                    <span><small>Week</small> {fmtTokens(usage.week.tokens)} · {fmtMoney(usage.week.cost)}</span>
                </div>
            ) : (
                <div className={`usage-meters${stale ? " stale" : ""}`}>
                    <Meter label="5 hours" l={five} />
                    <Meter label="7 days" l={week} />
                    {stale && <span className="usage-note">A window reset since the last run; refresh to read it.</span>}
                </div>
            )}
        </div>
    );
};

// The global usage control in the top bar: one button showing the worst rate-limit window across subscription accounts;
// its popover lists every account with its windows (or today / week totals for an enterprise account).
export const UsageGauges = ({ accounts, onRefresh }: { accounts: Account[]; onRefresh: (a: Account) => void }) => {
    const [open, setOpen] = useState(false);
    const ref = useDismiss(open, () => setOpen(false));
    if (accounts.length === 0) return null;
    const windows = accounts.flatMap((a) => (a.plan === "enterprise" ? [] : a.limits.filter((l) => !l.expired)));
    const worst = windows.length ? Math.max(...windows.map((l) => l.utilization)) : null;
    const broken = accounts.filter((a) => !a.logged_in).length;
    const tone: Tone = broken ? "bad" : worst === null ? "neutral" : toneOf(worst);
    return (
        <div className="usage" ref={ref}>
            <button type="button" className="usage-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
                <StatusDot tone={tone} />
                <span className="usage-btn-text">{broken ? `${broken} no auth` : worst === null ? "Usage" : `${Math.round(worst * 100)}% used`}</span>
                <Icon name="chevronDown" />
            </button>
            {open && (
                <Popover className="usage-pop" role="dialog" aria-label="AI account usage">
                    {accounts.map((a) => <AccountRow key={a.id} a={a} onRefresh={() => onRefresh(a)} />)}
                </Popover>
            )}
        </div>
    );
};
