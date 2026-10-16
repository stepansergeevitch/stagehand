import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    // sm: inline actions inside rows, cards and toolbars.
    size?: "md" | "sm";
    // A square button holding one icon; needs an aria-label.
    icon?: boolean;
    // Highlights a toggle that is switched on.
    on?: boolean;
}

// The one button. Pages pick a variant and size; they never restyle it.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant = "default", size = "md", icon, on, className, type = "button", ...rest }, ref) => {
    const cls = ["btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm", icon && "btn-icon", on && "on", className].filter(Boolean).join(" ");
    return <button ref={ref} type={type} className={cls} {...rest} />;
});
Button.displayName = "Button";
