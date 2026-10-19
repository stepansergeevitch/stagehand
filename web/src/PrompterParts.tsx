import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, StatusDot } from "@vortex/ds";
import { Markdown } from "./Markdown";
import { formatRoute, taskRoute, type Route } from "./routes";

// The pieces of the Prompter window that are not its state: the steps behind an answer, an answer with its task
// pills and code copy buttons, and the media query hook that decides docked / floating / sheet.

export interface Step { time: string; text: string }

export const clock = (d = new Date()): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export const useMedia = (query: string): boolean => {
    const [on, setOn] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const m = window.matchMedia(query);
        const h = () => setOn(m.matches);
        h();
        m.addEventListener("change", h);
        return () => m.removeEventListener("change", h);
    }, [query]);
    return on;
};

// One line about the steps of a turn, folded by default: live while the assistant works ("Reading the pull requests"),
// afterwards "Read N steps". The toggle opens the list of `time  text` rows.
export const StepsLine = ({ steps, live }: { steps: Step[]; live?: string }) => {
    const [shown, setShown] = useState(false);
    if (!live && steps.length === 0) return null;
    return (
        <>
            <div className={`pr-steps-line${live ? " live" : ""}`} role={live ? "status" : undefined}>
                {live ? (
                    <>
                        <StatusDot tone="info" pulse />
                        <span className="pr-steps-now">{live}</span>
                        {steps.length > 1 && <span className="pr-steps-n">step {steps.length}</span>}
                    </>
                ) : (
                    <span>Read {steps.length} step{steps.length === 1 ? "" : "s"}</span>
                )}
                {steps.length > 0 && (
                    <Button size="sm" variant="ghost" className="pr-steps-toggle" aria-expanded={shown} onClick={() => setShown((v) => !v)}>{shown ? "Hide steps ▾" : "Show steps ▸"}</Button>
                )}
            </div>
            {shown && steps.length > 0 && (
                <div className="pr-steps" role="group" aria-label="Steps">
                    {steps.map((s, i) => <div key={i}><time>{s.time}</time>{s.text}</div>)}
                </div>
            )}
        </>
    );
};

const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/g;

// An assistant answer: markdown, with ids of known tasks turned into small pill links to the task and a Copy button
// on every code block. The DOM is touched after render; the markdown string stays the source.
export const Answer = ({ source, tasks, route }: { source: string; tasks: Record<string, string>; route: Route }) => {
    const box = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const root = box.current;
        if (!root) return;
        const texts: Text[] = [];
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!(n as Text).parentElement?.closest("a, pre, code")) texts.push(n as Text);
        }
        for (const t of texts) {
            const value = t.data;
            const parts: Array<string | HTMLAnchorElement> = [];
            let last = 0;
            for (const m of value.matchAll(TICKET)) {
                const id = tasks[m[0]];
                if (!id) continue;
                const a = document.createElement("a");
                a.className = "pr-task";
                a.href = formatRoute(taskRoute(route, id, { tab: "work" }));
                a.textContent = m[0];
                parts.push(value.slice(last, m.index), a);
                last = (m.index ?? 0) + m[0].length;
            }
            if (!parts.length) continue;
            parts.push(value.slice(last));
            t.replaceWith(...parts);
        }
        for (const pre of root.querySelectorAll("pre")) {
            if (pre.querySelector(".pr-code-copy")) continue;
            const b = document.createElement("button");
            b.type = "button";
            b.className = "pr-code-copy";
            b.setAttribute("aria-label", "Copy code");
            b.textContent = "Copy";
            pre.prepend(b);
        }
    }, [source, tasks, route]);
    const onClick = (e: React.MouseEvent) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".pr-code-copy");
        if (!b) return;
        const code = b.parentElement?.querySelector("code")?.textContent ?? b.parentElement?.textContent ?? "";
        void navigator.clipboard?.writeText(code).catch(() => undefined);
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = "Copy"; }, 1200);
    };
    return <div ref={box} className="pr-answer" onClick={onClick}><Markdown source={source} /></div>;
};

// Copy / Retry under a finished answer.
export const AnswerActions = ({ text, onRetry, canRetry }: { text: string; onRetry: () => void; canRetry: boolean }) => {
    const [copied, setCopied] = useState(false);
    return (
        <div className="pr-acts">
            <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(text).catch(() => undefined); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy"}</Button>
            <Button size="sm" variant="ghost" disabled={!canRetry} onClick={onRetry}>Retry</Button>
        </div>
    );
};
