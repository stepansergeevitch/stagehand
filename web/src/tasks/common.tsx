import { useEffect, useState, type ReactNode } from "react";
import { Button, Chip, type Tone } from "@vortex/ds";
import { api, repoColorClass, repoName, type Task } from "../api";
import "./workspace.css";

// Small pieces the task workspace's tabs share.

// A collapsible sub-heading inside a panel (open by default).
export const Sub = ({ title, open = true, children }: { title: ReactNode; open?: boolean; children: ReactNode }) => (
    <details className="sub" open={open}>
        <summary><h3>{title}</h3></summary>
        <div className="sub-body">{children}</div>
    </details>
);

// What the agent and the checks call an outcome, as a status tone.
export const outcomeTone = (o: string | undefined): Tone =>
    o === "pass" || o === "ok" || o === "done" ? "ok" : o === "fail" || o === "failed" || o === "bad" ? "bad" : o === "needs_human" || o === "wait" ? "wait" : o === "running" ? "info" : o === "warn" ? "warn" : "neutral";

// A run's (or any record's) status word as a chip.
export const RunStatusChip = ({ status }: { status: Task["status"] | string }) => (
    <Chip tone={status === "failed" ? "bad" : status === "done" ? "ok" : status === "running" ? "info" : status === "waiting_user" || status === "blocked" ? "warn" : status === "rate_limited" ? "wait" : "neutral"}>{status.replace("_", " ")}</Chip>
);

export const elapsed = (fromIso: string | undefined, toIso?: string | undefined): string => {
    if (!fromIso) return "";
    const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
    if (ms < 0) return "";
    const m = Math.floor(ms / 60_000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m >= 1 ? `${m}m ${Math.floor((ms % 60_000) / 1000)}s` : `${Math.floor(ms / 1000)}s`;
};

// The text of one artifact of the task (design.md, research.md), once it exists.
export const useArtifactText = (taskId: string, rel: string, exists: boolean): string | null => {
    const [text, setText] = useState<string | null>(null);
    useEffect(() => {
        if (!exists) return;
        void fetch(api.artifactUrl(taskId, rel)).then((r) => (r.ok ? r.text() : null)).then(setText);
    }, [taskId, rel, exists]);
    return text;
};

// Status lines that ask for a login carry the app URL; make it clickable so a closed automation window is not a dead end.
export const Linkified = ({ text }: { text: string }) => {
    const parts = text.split(/(https?:\/\/[^\s)]+)/g);
    return <>{parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : <span key={i}>{p}</span>))}</>;
};

// A repository's name as a coloured chip — the same colour for the same repo everywhere, so the PR rows, tabs and
// comments of one repository are recognisable at a glance.
export const RepoChip = ({ repo, repos }: { repo: string; repos: string[] }) => {
    if (repos.length <= 1 && !repo) return null;
    return <Chip mono className={`repo-chip ${repoColorClass(repo, repos)}`} title={repo ? `repository ${repo}/` : "repository"}>{repoName(repo)}</Chip>;
};

// Full-size view of one screenshot: first click fits it to the viewport width, a second click shows it 1:1 (scrollable).
export const Lightbox = ({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) => {
    const [natural, setNatural] = useState(false);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    return (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={caption} onClick={onClose}>
            <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
                <span>{caption}</span>
                <span className="lightbox-actions">
                    <Button size="sm" onClick={() => setNatural((v) => !v)}>{natural ? "Fit to width" : "Actual size"}</Button>
                    <a href={src} target="_blank" rel="noreferrer">Open in a tab</a>
                    <Button size="sm" onClick={onClose} aria-label="Close">Close</Button>
                </span>
            </div>
            <img src={src} alt={caption} className={natural ? "natural" : ""} onClick={(e) => { e.stopPropagation(); setNatural((v) => !v); }} />
        </div>
    );
};
