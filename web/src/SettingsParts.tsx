import { useCallback, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Button, Icon, IconButton, Menu, MenuItem, Skeleton, Textarea, type Tone } from "@vortex/ds";
import { useDismiss } from "./components/useDismiss";
import "./settings.css";

// Building blocks shared by the Settings pages' entity views (environment, config dir, AI account, integration).

// A text area for commands and other code or machine text: monospace, no wrapping, no autocorrect. `size` is how many
// lines it shows before it scrolls; `prose` wraps long lines (markdown, rules written in sentences).
const ROWS = { sm: 3, md: 6, lg: 12 } as const;
export const CodeArea = ({ size = "sm", prose, className, ...rest }: { size?: keyof typeof ROWS; prose?: boolean } & TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <Textarea
        className={["code-area", prose && "prose", className].filter(Boolean).join(" ")}
        rows={ROWS[size]}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...(prose ? {} : { wrap: "off" })}
        {...rest}
    />
);

// The placeholder of a tab or page that is still reading its data.
export const Loading = ({ lines = 4 }: { lines?: number }) => (
    <div className="settings-loading" role="status" aria-label="Loading">
        {Array.from({ length: lines }, (_, i) => <Skeleton key={i} height={i === 0 ? 32 : 56} />)}
    </div>
);

// The `⋯` button of a page header: rare actions in a menu. Each item gets `close` to run before its own work.
export const ActionMenu = ({ label = "More actions", children }: { label?: string; children: (close: () => void) => ReactNode }) => {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const ref = useDismiss(open, close);
    return (
        <div className="action-menu" ref={ref}>
            <IconButton icon="more" label={label} aria-haspopup="menu" aria-expanded={open} on={open} onClick={() => setOpen((o) => !o)} />
            {open && <Menu className="action-menu-list">{children(close)}</Menu>}
        </div>
    );
};
export { MenuItem };

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
