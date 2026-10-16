import type { HTMLAttributes } from "react";
import type { Tone } from "./Chip";

// An inline message: the outcome of an action, a warning, a note about the thing beside it.
export const Notice = ({ tone = "accent", className, ...rest }: { tone?: Exclude<Tone, "neutral"> } & HTMLAttributes<HTMLDivElement>) => (
    <div role={tone === "bad" ? "alert" : "status"} className={["notice", tone !== "accent" && tone, className].filter(Boolean).join(" ")} {...rest} />
);
