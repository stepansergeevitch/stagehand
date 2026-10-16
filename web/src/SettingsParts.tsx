import type { ReactNode } from "react";
import { Button, Icon, IconButton, type Tone } from "@vortex/ds";
import "./settings.css";

// Building blocks shared by the Settings pages' entity views (environment, config dir, AI account, integration).

// One editable entry of a list (a component, a rule, a review point): its fields, then Remove.
export const RowEditor = ({ children, onRemove, removeLabel }: { children: ReactNode; onRemove: () => void; removeLabel: string }) => (
    <div className="row-editor">
        <div className="row-editor-main">{children}</div>
        <IconButton icon="close" label={removeLabel} variant="ghost" onClick={onRemove} />
    </div>
);

export const AddRow = ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <Button size="sm" className="row-add" onClick={onClick}><Icon name="plus" />{children}</Button>
);

// A chip tone for a rate-limit utilisation: quiet until it matters (60 % / 90 %, the same thresholds as the top bar).
export const limitTone = (pct: number | null): Tone => (pct === null ? "neutral" : pct >= 90 ? "bad" : pct >= 60 ? "warn" : "neutral");
