import { useEffect } from "react";

// A dialog over the page: Esc or a click outside closes it.
export const Modal = ({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) => {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="modal" onClick={onClose}>
            <div className="box" style={wide ? { minWidth: "min(900px, 100vw - 24px)" } : undefined} onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h2>{title}</h2>
                    <button className="close" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
                </div>
                {children}
            </div>
        </div>
    );
};
