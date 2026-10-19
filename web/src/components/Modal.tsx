import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@vortex/ds";
import "./modal.css";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// A dialog over the page (docs/ux-redesign.md §4.5). Esc or a click on the backdrop closes it; focus moves into it, stays
// inside while Tab cycles, and returns to what opened it. On phones it is a bottom sheet. A dialog is a route
// (`#/<list>/new`), so its open state is the caller's `navigate`, never local state.
export const Modal = ({ title, children, onClose, wide, footer, sheet, className }: {
    title: ReactNode;
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
    // Buttons pinned under the scrolling body.
    footer?: ReactNode;
    // On phones fills the whole screen instead of a bottom sheet; the footer button docks at the bottom.
    sheet?: boolean;
    className?: string;
}) => {
    const box = useRef<HTMLDivElement>(null);
    const titleId = useId();
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const opener = document.activeElement as HTMLElement | null;
        const el = box.current;
        if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>("input, textarea, select") ?? el).focus();
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") {
                e.stopPropagation();
                closeRef.current();
            } else if (e.key === "Tab" && el) {
                const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
                if (!items.length) return;
                const first = items[0]!;
                const last = items[items.length - 1]!;
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
            opener?.focus?.();
        };
    }, []);
    return createPortal(
        <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={`box${wide ? " wide" : ""}${sheet ? " full" : ""}${className ? ` ${className}` : ""}`} ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
                <div className="modal-head">
                    <h2 id={titleId}>{title}</h2>
                    <IconButton variant="ghost" size="sm" icon="close" label="Close (Esc)" onClick={onClose} />
                </div>
                <div className="modal-body">{children}</div>
                {footer && <div className="modal-foot">{footer}</div>}
            </div>
        </div>,
        document.body,
    );
};
