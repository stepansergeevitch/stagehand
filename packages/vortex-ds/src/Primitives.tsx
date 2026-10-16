import { forwardRef, useId, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Button, type ButtonProps } from "./Button";
import type { Tone } from "./Chip";
import { Icon, type IconName } from "./Icon";

const join = (...p: Array<string | false | undefined>): string => p.filter(Boolean).join(" ");

// A coloured dot for a state (running, failed, idle). Always pair it with text or a title; `pulse` marks something in progress.
export const StatusDot = ({ tone = "neutral", pulse, className, ...rest }: { tone?: Tone; pulse?: boolean } & HTMLAttributes<HTMLSpanElement>) => (
    <span className={join("status-dot", tone !== "neutral" && tone, pulse && "pulse", className)} {...rest} />
);

// A count or short marker: neutral by default, solid tone when it needs attention.
export const Badge = ({ tone = "neutral", className, ...rest }: { tone?: Tone } & HTMLAttributes<HTMLSpanElement>) => (
    <span className={join("badge", tone !== "neutral" && tone, className)} {...rest} />
);

// Hover / focus explanation for any element; the bubble is described-by, so keyboard and screen-reader users get it too.
export const Tooltip = ({ text, children, className }: { text: ReactNode; children: ReactNode; className?: string }) => {
    const id = useId();
    return (
        <span className={join("tip", className)} aria-describedby={id}>
            {children}
            <span role="tooltip" id={id} className="tip-bubble">{text}</span>
        </span>
    );
};

// The "i" icon that explains a field on hover.
export const Hint = ({ text }: { text: ReactNode }) => (
    <Tooltip text={text}><span className="hint-tip" tabIndex={0} aria-label="More information"><Icon name="info" /></span></Tooltip>
);

export const Kbd = ({ className, ...rest }: HTMLAttributes<HTMLElement>) => <kbd className={join("kbd", className)} {...rest} />;

export const Divider = ({ vertical, className, ...rest }: { vertical?: boolean } & HTMLAttributes<HTMLHRElement>) => (
    <hr className={join("divider", vertical && "vertical", className)} {...(vertical ? { "aria-orientation": "vertical" as const } : {})} {...rest} />
);

// A grey placeholder bar for content that is loading.
export const Skeleton = ({ circle, width, height, className, style, ...rest }: { circle?: boolean; width?: number | string; height?: number | string } & HTMLAttributes<HTMLSpanElement>) => (
    <span aria-hidden="true" className={join("skeleton", circle && "circle", className)} style={{ width, height, ...style }} {...rest} />
);

export const Spinner = ({ label = "Loading", className }: { label?: string; className?: string }) => (
    <svg className={join("spinner", className)} viewBox="0 0 20 20" role="status" aria-label={label}><circle cx="10" cy="10" r="7" strokeDasharray="30 44" /></svg>
);

// What a list or panel shows when there is nothing in it: say what is missing and what to do.
export const EmptyState = ({ icon = "inbox", title, children, action, className }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) => (
    <div className={join("empty-state", className)}>
        <Icon name={icon} />
        <h3>{title}</h3>
        {children ? <p>{children}</p> : null}
        {action}
    </div>
);

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label?: ReactNode };

// A native checkbox in the brand colour with its label.
export const Checkbox = forwardRef<HTMLInputElement, CheckProps>(({ label, className, ...rest }, ref) => (
    <label className={join("check-row", className)}><input ref={ref} type="checkbox" {...rest} />{label ? <span>{label}</span> : null}</label>
));
Checkbox.displayName = "Checkbox";

export const Radio = forwardRef<HTMLInputElement, CheckProps>(({ label, className, ...rest }, ref) => (
    <label className={join("check-row", className)}><input ref={ref} type="radio" {...rest} />{label ? <span>{label}</span> : null}</label>
));
Radio.displayName = "Radio";

// An on/off setting that applies at once (a checkbox with role=switch).
export const Switch = forwardRef<HTMLInputElement, CheckProps>(({ label, className, ...rest }, ref) => (
    <label className={join("switch", className)}><input ref={ref} type="checkbox" role="switch" {...rest} /><span className="switch-track" />{label ? <span>{label}</span> : null}</label>
));
Switch.displayName = "Switch";

// A square button holding one icon; the label is required because nothing else says what it does.
export const IconButton = forwardRef<HTMLButtonElement, { icon: IconName; label: string } & Omit<ButtonProps, "icon" | "children" | "aria-label">>(({ icon, label, ...rest }, ref) => (
    <Button ref={ref} icon aria-label={label} title={label} {...rest}><Icon name={icon} /></Button>
));
IconButton.displayName = "IconButton";

// Surfaces for floating content; the host positions them. A Menu holds MenuItems (and <hr />), a Popover holds anything.
export const Menu = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => <div role="menu" className={join("menu", className)} {...rest} />;
export const MenuItem = ({ danger, className, ...rest }: { danger?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" role="menuitem" className={join("menu-item", danger && "danger", className)} {...rest} />
);
export const Popover = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => <div className={join("popover", className)} {...rest} />;

// Initials in a tinted circle.
export const Avatar = ({ name, size = 28, tone, className, style, ...rest }: { name: string; size?: number; tone?: Exclude<Tone, "neutral" | "accent"> } & HTMLAttributes<HTMLSpanElement>) => {
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
    return <span role="img" aria-label={name} title={name} className={join("avatar", tone, className)} style={{ ["--avatar" as string]: `${size}px`, ...style }} {...rest}>{initials}</span>;
};

// Documentation component: the colour, type, space, radius and elevation scales, drawn from the live tokens.
const SCALE: Array<[string, string[]]> = [
    ["Surfaces", ["surface-0", "surface-1", "surface-2", "surface-3", "panel-2", "code"]],
    ["Text and lines", ["ink", "ink-2", "ink-3", "line", "line-strong", "control-border"]],
    ["Brand", ["accent", "accent-soft", "brand", "brand-2"]],
    ["Intent", ["ok", "ok-soft", "warn", "warn-soft", "bad", "bad-soft", "wait", "wait-soft", "info", "info-soft"]],
];
export const Foundations = () => (
    <div className="fnd">
        {SCALE.map(([title, names]) => (
            <div key={title}>
                <h4>{title}</h4>
                <div className="fnd-swatches">{names.map((n) => <div key={n} className="fnd-swatch"><i style={{ background: `var(--${n})` }} />--{n}</div>)}</div>
            </div>
        ))}
        <div>
            <h4>Type</h4>
            {([["2xl", 600], ["xl", 600], ["lg", 600], ["md", 400], ["sm", 400], ["xs", 400]] as const).map(([s, w]) => (
                <div key={s} style={{ fontSize: `var(--fs-${s})`, fontWeight: w, lineHeight: 1.4 }}>Walk the ticket through every stage <code style={{ color: "var(--ink-3)" }}>--fs-{s}</code></div>
            ))}
            <div style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-sm)", color: "var(--ink-2)" }}>ENG-24845 · feature/ticket-branch · 1,204 tokens</div>
        </div>
        <div>
            <h4>Space</h4>
            <div className="fnd-row">{[1, 2, 3, 4, 5, 6].map((n) => <div key={n} style={{ textAlign: "center" }}><div style={{ width: `var(--sp-${n})`, height: `var(--sp-${n})`, background: "var(--accent)", margin: "0 auto 4px" }} /><code>sp-{n}</code></div>)}</div>
        </div>
        <div>
            <h4>Radius</h4>
            <div className="fnd-row">{["sm", "md", "lg", "xl", "pill"].map((r) => <div key={r} className="fnd-box" style={{ borderRadius: `var(--r-${r})` }}>{r}</div>)}</div>
        </div>
        <div>
            <h4>Elevation</h4>
            <div className="fnd-row">{["sm", "md", "lg"].map((e) => <div key={e} className="fnd-box" style={{ boxShadow: `var(--shadow-${e}), inset 0 1px 0 var(--hi)`, borderRadius: "var(--r-lg)", width: 88, height: 56 }}>shadow-{e}</div>)}</div>
        </div>
    </div>
);
