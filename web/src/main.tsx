import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

// Every link that leaves the app (or opens an artifact/PR/app URL) opens in a new tab; in-app hash links stay.
document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!(a instanceof HTMLAnchorElement)) return;
    const href = a.getAttribute("href") ?? "";
    if (!/^(https?:)?\/\//.test(href) && !href.startsWith("/api/")) return;
    if (!a.target) a.target = "_blank";
    if (!a.rel.includes("noreferrer")) a.rel = `${a.rel} noreferrer noopener`.trim();
});

// Errors thrown outside React's render path (event handlers, promises) get a visible line instead of silence.
const showFatal = (text: string): void => {
    let el = document.getElementById("fatal");
    if (!el) {
        el = document.createElement("div");
        el.id = "fatal";
        el.className = "fatal";
        el.onclick = () => el?.remove();
        document.body.appendChild(el);
    }
    el.textContent = text.slice(0, 400);
};
window.addEventListener("error", (e) => showFatal(`Error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => showFatal(`Unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`));

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <ErrorBoundary label="Stagehand">
            <App />
        </ErrorBoundary>
    </React.StrictMode>,
);
