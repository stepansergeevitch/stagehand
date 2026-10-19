import { useState, type ReactNode } from "react";
import { errText } from "../format";
import { api, trackerName, type Env, type PalaceHit } from "../api";
import { Markdown } from "../Markdown";
import { CheckboxSelect } from "../components/CheckboxSelect";
import { Section } from "../components/Panel";
import { Button, Chip, EmptyState, Icon, Input, Textarea } from "@vortex/ds";

// Small pieces the Product pages share.

export const PHASE_LABEL = { context: "Context", design: "Design", tickets: "Tickets", approved: "Approved", live: "Live" } as const;

// A short "nothing here" line inside a tab.
export const Nothing = ({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) => (
    <EmptyState icon="inbox" title={title} action={action}>{children}</EmptyState>
);

// A markdown document the human can rewrite: the text with an Edit button in the section head; editing swaps it for a
// text box with Save / Cancel.
export const EditableMarkdown = ({ title, hint, text, empty, onSave, onError }: { title: ReactNode; hint?: ReactNode; text: string; empty: string; onSave: (t: string) => Promise<void>; onError: (m: string) => void }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(text);
    const [saving, setSaving] = useState(false);
    const start = (): void => { setDraft(text); setEditing(true); };
    const save = async (): Promise<void> => {
        setSaving(true);
        try { await onSave(draft); setEditing(false); } catch (e) { onError(errText(e)); } finally { setSaving(false); }
    };
    return (
        <Section title={title} hint={hint} actions={editing ? undefined : <Button size="sm" onClick={start}>Edit</Button>}>
            {editing ? (
                <>
                    <Textarea className="po-md-editor" value={draft} aria-label={typeof title === "string" ? title : "Document"} onChange={(e) => setDraft(e.target.value)} rows={Math.min(30, Math.max(8, draft.split("\n").length + 2))} />
                    <div className="po-actions">
                        <Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
                        <Button disabled={saving} onClick={() => setEditing(false)}>Cancel</Button>
                    </div>
                </>
            ) : text.trim() ? <Markdown source={text} /> : <p className="po-muted">{empty}</p>}
        </Section>
    );
};

// A search over the memory (palace): of one Product owner's wing, or of an environment's product.
export const PalaceSearch = ({ wing, env, envLabel, onError }: { wing?: string; env?: string; envLabel?: string; onError: (m: string) => void }) => {
    const [q, setQ] = useState("");
    const [hits, setHits] = useState<PalaceHit[] | null>(null);
    const [busy, setBusy] = useState(false);
    const run = async (): Promise<void> => {
        if (!q.trim()) return;
        setBusy(true);
        try { setHits((await api.palaceSearch(q.trim(), wing ? { wing } : { env: env ?? "" })).results); } catch (e) { onError(errText(e)); } finally { setBusy(false); }
    };
    return (
        <div className="po-search">
            <form className="po-row" role="search" onSubmit={(e) => { e.preventDefault(); void run(); }}>
                <Input type="search" aria-label="Search the memory" value={q} onChange={(e) => setQ(e.target.value)} placeholder={wing ? "Search this Product owner's memory" : `Search the memory of ${envLabel ?? "this environment"}`} />
                <Button type="submit" disabled={busy || !q.trim()}><Icon name="search" />{busy ? "Searching…" : "Search"}</Button>
            </form>
            {hits && (hits.length === 0 ? <p className="po-muted">Nothing in memory matches.</p> : (
                <div className="po-hits">
                    {hits.map((h, i) => (
                        <details key={i} className="po-fold">
                            <summary>
                                <Chip>{h.wing}</Chip><Chip>{h.room}</Chip>
                                {h.similarity != null && <span className="po-muted">{Math.round(h.similarity * 100)}%</span>}
                                <span className="po-fold-text">{h.text.split("\n")[0]?.slice(0, 120)}</span>
                            </summary>
                            <Markdown source={h.text} />
                        </details>
                    ))}
                </div>
            ))}
        </div>
    );
};

// The environments a PO works for: any number on the task manager of the first picked one (the primary). With
// `switchable` (a PO not created yet) an environment on another task manager replaces the selection instead of being
// disabled — otherwise the first environment's task manager would lock the others out for good.
export const EnvsSelect = ({ envs, value, onChange, disabled, switchable }: { envs: Env[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; switchable?: boolean }) => {
    const source = envs.find((e) => e.id === value[0])?.ticket_source;
    const sourceOf = (id: string) => envs.find((e) => e.id === id)?.ticket_source;
    return (
        <CheckboxSelect
            options={envs.map((e) => ({ value: e.id, label: e.name, disabled: !switchable && source && e.ticket_source !== source ? `uses ${trackerName(e.ticket_source)}, not ${source === "linear" ? "Linear" : "ClickUp"}` : undefined }))}
            value={value}
            onChange={(ids) => {
                const added = ids.find((id) => !value.includes(id));
                onChange(added && sourceOf(added) !== source ? [added] : ids);
            }}
            min={1}
            {...(disabled ? { disabled } : {})}
        />
    );
};

export const since = (iso: string): string => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

