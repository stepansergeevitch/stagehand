import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    // sm: inline actions inside rows, cards and toolbars.
    size?: "md" | "sm";
    // A square button holding one icon; needs an aria-label.
    icon?: boolean;
    // An icon before the label (a text button with a glyph); not the icon-only button, which is `icon`/IconButton.
    leadingIcon?: IconName;
    // Highlights a toggle that is switched on.
    on?: boolean;
}

// The one button. Pages pick a variant and size; they never restyle it.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant = "default", size = "md", icon, leadingIcon, on, className, type = "button", children, ...rest }, ref) => {
    const cls = ["btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm", icon && "btn-icon", on && "on", className].filter(Boolean).join(" ");
    return <button ref={ref} type={type} className={cls} {...rest}>{leadingIcon && !icon ? <Icon name={leadingIcon} /> : null}{children}</button>;
});
Button.displayName = "Button";
