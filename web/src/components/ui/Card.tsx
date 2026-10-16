import type { HTMLAttributes, ReactNode } from "react";

// A titled block of a page: the title (an h2) with an optional badge beside it, then the body.
export const Card = ({ title, badge, className, children, ...rest }: { title?: ReactNode; badge?: ReactNode } & Omit<HTMLAttributes<HTMLElement>, "title">) => (
    <section className={["card", className].filter(Boolean).join(" ")} {...rest}>
        {title !== undefined && <h2>{title}{badge ? <> {badge}</> : null}</h2>}
        {children}
    </section>
);
