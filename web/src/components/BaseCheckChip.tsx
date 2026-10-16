import type { BaseCheckState } from "../api";

// Whether a task's branch still goes onto its latest base (server base-check.ts): one chip, the detail on hover.
const LOOK: Record<BaseCheckState, { cls: string; text: string }> = {
    up_to_date: { cls: "ok", text: "on latest base" },
    clean: { cls: "ok", text: "merges with base" },
    conflicts: { cls: "bad", text: "base conflicts" },
    check_failed: { cls: "bad", text: "base check fails" },
    error: { cls: "warn", text: "base check error" },
};

export const BaseCheckChip = ({ state, detail, compact = false }: { state: BaseCheckState | null | undefined; detail?: string | null; compact?: boolean }) => {
    if (!state) return null;
    const look = LOOK[state];
    // In a list only what needs attention shows; a healthy branch stays quiet.
    if (compact && look.cls === "ok") return null;
    return (
        <span className={`chip ${look.cls}`} title={detail ?? look.text}>
            {look.text}
        </span>
    );
};
