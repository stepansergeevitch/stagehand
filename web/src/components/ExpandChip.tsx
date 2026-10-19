import type { ReactNode } from "react";
import { Chip, Icon, type Tone } from "@vortex/ds";
import "./expandchip.css";

// A chip that shows only its `label` (a repository name) and expands to the `detail` (number, status) on hover or
// keyboard focus. CSS-only: max-width/opacity transition, none under prefers-reduced-motion. Touch devices have no
// hover, so the full text is always in the aria-label and the title (a long-press shows it).
// `href`: an external link (the pull request on GitHub) shown as a small icon beside the chip while it is hovered or focused.
export const ExpandChip = ({ label, detail, tone, onClick, title, href }: { label: ReactNode; detail: ReactNode; tone?: Tone; onClick?: () => void; title: string; href?: string | null }) => (
    <span className="expand-chip-wrap">
        <button type="button" className="expand-chip" onClick={onClick} title={title} aria-label={title}>
            <Chip tone={tone}>
                <span className="expand-chip-label">{label}</span>
                <span className="expand-chip-detail">{detail}</span>
            </Chip>
        </button>
        {href && <a className="expand-chip-link" href={href} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label={`Open ${label} on GitHub`}><Icon name="external" /></a>}
    </span>
);
