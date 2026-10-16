import type { HTMLAttributes } from "react";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "wait" | "accent";

// A status or label pill. `tone` carries the meaning (never the colour alone: the text says it too).
export const Chip = ({ tone = "neutral", className, ...rest }: { tone?: Tone } & HTMLAttributes<HTMLSpanElement>) => (
    <span className={["chip", tone !== "neutral" && tone, className].filter(Boolean).join(" ")} {...rest} />
);
