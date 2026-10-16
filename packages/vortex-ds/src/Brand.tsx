import type { HTMLAttributes, SVGProps } from "react";

// The Vortex mark: a spiral of growing half-circles, a vortex seen from above. Stroke icon on a 24px grid, currentColor.
export const Mark = ({ size = 20, ...rest }: { size?: number | string } & SVGProps<SVGSVGElement>) => (
    <svg className="brand-mark" viewBox="0 0 24 24" width={size} height={size} role="img" aria-label="Vortex" {...rest}>
        <path d="M10.5 12.75a1.5 1.5 0 0 1 3 0a3 3 0 0 1-6 0a4.5 4.5 0 0 1 9 0a6 6 0 0 1-12 0a7.5 7.5 0 0 1 15 0" />
    </svg>
);

// Mark plus the name, set in the UI font. `markOnly` for tight places (a collapsed bar, a favicon-sized slot).
export const Wordmark = ({ size = "md", markOnly, className, ...rest }: { size?: "sm" | "md" | "lg"; markOnly?: boolean } & HTMLAttributes<HTMLSpanElement>) => (
    <span className={["wordmark", `wordmark-${size}`, className].filter(Boolean).join(" ")} {...rest}>
        <Mark size="1.25em" aria-hidden={markOnly ? undefined : true} />
        {!markOnly && <span className="wordmark-name">Vortex</span>}
    </span>
);
