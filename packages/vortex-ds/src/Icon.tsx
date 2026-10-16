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
    alert: "M10 3l8 14H2zM10 8v4M10 14.5h.01",
    clock: "M10 18a8 8 0 100-16 8 8 0 000 16zM10 6v4l3 2",
    xCircle: "M10 18a8 8 0 100-16 8 8 0 000 16zM7.5 7.5l5 5M12.5 7.5l-5 5",
    checkCircle: "M10 18a8 8 0 100-16 8 8 0 000 16zM6.5 10l2.5 2.5 4.5-5",
    inbox: "M3 11l2-6h10l2 6v5H3zM3 11h4l1 2h4l1-2h4",
    more: "M4.5 10h.01M10 10h.01M15.5 10h.01",
    external: "M8 5H4v11h11v-4M11 4h5v5M16 4l-7 7",
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false" {...rest}>
        <path d={PATHS[name]} />
    </svg>
);
