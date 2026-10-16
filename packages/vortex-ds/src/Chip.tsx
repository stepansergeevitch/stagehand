import type { HTMLAttributes } from "react";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "wait" | "accent" | "info";

// A status or label pill. `tone` carries the meaning (never the colour alone: the text says it too).
// Plain text labels render in the sans face; `mono` is for ids, branches and other machine text.
export const Chip = ({ tone = "neutral", mono, className, ...rest }: { tone?: Tone; mono?: boolean } & HTMLAttributes<HTMLSpanElement>) => (
    <span className={["chip", tone !== "neutral" && tone, mono && "chip-mono", className].filter(Boolean).join(" ")} {...rest} />
);
