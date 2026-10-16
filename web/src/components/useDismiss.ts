import { useEffect, useRef } from "react";

// Closes a dropdown on an outside click or Esc: attach the returned ref to the dropdown's wrapper.
export const useDismiss = (open: boolean, close: () => void) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open, close]);
    return ref;
};
