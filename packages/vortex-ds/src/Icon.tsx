import type { SVGProps } from "react";

// The one icon set (stroke icons, 16px, currentColor). Decorative by default; give a label when an icon stands alone.
const PATHS = {
    close: "M5 5l10 10M15 5L5 15",
    plus: "M10 4v12M4 10h12",
    search: "M9 15a6 6 0 100-12 6 6 0 000 12zM14 14l4 4",
    columns: "M4 4h12v12H4zM8.5 4v12M12.5 4v12",
    filter: "M3 5h14l-5 6v5l-4-2v-3z",
    chevronDown: "M5 8l5 5 5-5",
    chevronRight: "M8 5l5 5-5 5",
    check: "M4 10l4 4 8-8",
    info: "M10 9v5M10 6h.01M10 18a8 8 0 100-16 8 8 0 000 16z",
    refresh: "M16 10a6 6 0 11-2-4.5M16 3v4h-4",
    arrowLeft: "M16 10H4M9 5l-5 5 5 5",
    external: "M8 5H4v11h11v-4M11 4h5v5M16 4l-7 7",
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false" {...rest}>
        <path d={PATHS[name]} />
    </svg>
);
