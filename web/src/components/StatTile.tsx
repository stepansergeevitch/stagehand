import type { ReactNode } from "react";
import { Icon, StatusDot, type IconName, type Tone } from "@vortex/ds";

// One headline number with its label: the glanceable summary at the top of a page. Interactive (a button) only when it
// does something; the tone colours the dot, never the number.
export const StatTile = ({ label, value, sub, tone = "neutral", icon, onClick }: {
    label: string;
    value: ReactNode;
    sub?: ReactNode;
    tone?: Tone;
    icon?: IconName;
    onClick?: () => void;
}) => {
    const body = (
        <>
            <span className="st-label">{tone !== "neutral" ? <StatusDot tone={tone} /> : icon ? <Icon name={icon} /> : null}{label}</span>
            <span className="st-value">{value}</span>
            {sub && <span className="st-sub">{sub}</span>}
        </>
    );
    return onClick ? <button type="button" className="stat-tile" onClick={onClick}>{body}</button> : <div className="stat-tile">{body}</div>;
};

export const StatRow = ({ children }: { children: ReactNode }) => <div className="stat-row">{children}</div>;
