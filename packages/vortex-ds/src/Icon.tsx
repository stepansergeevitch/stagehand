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
    more: "M3.5 10a1.25 1.25 0 102.5 0 1.25 1.25 0 10-2.5 0zM8.75 10a1.25 1.25 0 102.5 0 1.25 1.25 0 10-2.5 0zM14 10a1.25 1.25 0 102.5 0 1.25 1.25 0 10-2.5 0z",
    external: "M8 5H4v11h11v-4M11 4h5v5M16 4l-7 7",
    menu: "M3 6h14M3 10h14M3 14h14",
    chevronLeft: "M12 5l-5 5 5 5",
    chevronUp: "M5 12l5-5 5 5",
    home: "M3 9l7-6 7 6v8H3zM8 17v-5h4v5",
    tasks: "M4 5l1.5 1.5L8 4M10 5h7M4 11l1.5 1.5L8 9M10 11h7M4 17h.01M10 17h7",
    layers: "M10 3l7 4-7 4-7-4zM3 11l7 4 7-4",
    terminal: "M3 4h14v12H3zM6 8l3 2-3 2M11 13h3",
    chart: "M4 16V9M10 16V4M16 16v-5",
    cpu: "M6 6h8v8H6zM8 2v4M12 2v4M8 14v4M12 14v4M2 8h4M2 12h4M14 8h4M14 12h4",
    server: "M3 4h14v5H3zM3 11h14v5H3zM6 6.5h.01M6 13.5h.01",
    folder: "M3 5h5l2 2h7v9H3z",
    user: "M10 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3.5 17a6.5 6.5 0 0113 0",
    plug: "M7 3v4M13 3v4M5 7h10v3a5 5 0 01-10 0zM10 15v2",
    spark: "M10 3l1.8 4.7 4.7 1.8-4.7 1.8L10 16l-1.8-4.7-4.7-1.8 4.7-1.8z",
    command: "M7 7h6v6H7zM7 7V5a2 2 0 10-2 2h2M13 7V5a2 2 0 112 2h-2M7 13v2a2 2 0 11-2-2h2M13 13v2a2 2 0 102-2h-2",
    pin: "M12 3l5 5-3 1-3 3 .5 4L10 13l-5 4 4-5-3-2.5 4 .5 3-3z",
    gauge: "M3 14a7 7 0 1114 0M10 14l3-5",
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) => (
    <svg className="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false" {...rest}>
        <path d={PATHS[name]} />
    </svg>
);
