import type { HTMLAttributes } from "react";
import type { Tone } from "./Chip";
import { Icon, type IconName } from "./Icon";

const ICONS: Record<Exclude<Tone, "neutral">, IconName> = { accent: "info", info: "info", ok: "checkCircle", warn: "alert", bad: "xCircle", wait: "clock" };

// An inline message: the outcome of an action, a warning, a note about the thing beside it. The tone icon says it in a shape as well as a colour.
export const Notice = ({ tone = "accent", className, children, ...rest }: { tone?: Exclude<Tone, "neutral"> } & HTMLAttributes<HTMLDivElement>) => (
    <div role={tone === "bad" ? "alert" : "status"} className={["notice", tone !== "accent" && tone, className].filter(Boolean).join(" ")} {...rest}>
        <Icon name={ICONS[tone]} />
        <div className="notice-body">{children}</div>
    </div>
);
