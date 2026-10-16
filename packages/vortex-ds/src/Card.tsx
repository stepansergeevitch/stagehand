import type { HTMLAttributes, ReactNode } from "react";

// A titled block of a page: a header row (title as an h2 with an optional badge, actions on the right), the body, and an optional footer strip.
export const Card = ({ title, badge, actions, footer, className, children, ...rest }: { title?: ReactNode; badge?: ReactNode; actions?: ReactNode; footer?: ReactNode } & Omit<HTMLAttributes<HTMLElement>, "title">) => {
    const heading = title !== undefined && <h2>{title}{badge ? <> {badge}</> : null}</h2>;
    return (
        <section className={["card", className].filter(Boolean).join(" ")} {...rest}>
            {actions ? <div className="card-head">{heading}<div className="card-actions">{actions}</div></div> : heading}
            {children}
            {footer ? <div className="card-foot">{footer}</div> : null}
        </section>
    );
};
