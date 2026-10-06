import { useEffect, useState, type ReactNode } from "react";

// Stagehand's standard entity view — what a list row opens (the counterpart of DataTable):
//
//   <Entity type> / <identifier>                                   [entity actions]
//   [Tab] [Tab] [Tab] …
//   the open tab: fields (Field / CheckField), then Save · Discard (EntityForm)
//
// Every section of an entity is a tab of its own, never one long page. No explanatory text floats around: each field
// carries its own hint behind a hint icon.

export interface EntityTab {
    key: string;
    label: string;
    content: ReactNode;
}

export const EntityView = ({ type, onType, id, actions, tabs, defaultTab, notice }: {
    // The list's title ("Environments"); clicking it goes back to the list. Without onType (a singleton such as the
    // Prompter) it is plain text.
    type: string;
    onType?: () => void;
    // The entity's identifier (its name); a singleton has none.
    id?: ReactNode;
    // The outcome of the last entity action (Verify, Test, …), shown under the header.
    notice?: { ok: boolean; text: ReactNode } | null;
    // Entity-level actions on the right of the title (Delete, Renew token, …).
    actions?: ReactNode;
    tabs: EntityTab[];
    defaultTab?: string;
}) => {
    const [tab, setTab] = useState(defaultTab ?? tabs[0]?.key ?? "");
    const current = tabs.find((t) => t.key === tab) ?? tabs[0];
    return (
        <div className="entity-view">
            <div className="ev-header">
                <h1 className="ev-title">
                    {onType ? <a href="#" onClick={(e) => { e.preventDefault(); onType(); }}>{type}</a> : <span>{type}</span>}
                    {id !== undefined && <><span className="ev-sep">/</span><span>{id}</span></>}
                </h1>
                {actions && <div className="ev-actions">{actions}</div>}
            </div>
            {notice && <div className={`test-result ev-notice ${notice.ok ? "" : "bad"}`}>{notice.text}</div>}
            {tabs.length > 1 && (
                <div className="tabs ev-tabs" role="tablist">
                    {tabs.map((t) => (
                        <button key={t.key} role="tab" aria-selected={t.key === current?.key} className={t.key === current?.key ? "active" : ""} onClick={() => setTab(t.key)}>
                            {t.label}
                        </button>
                    ))}
                </div>
            )}
            <div className="ev-body">{current?.content}</div>
        </div>
    );
};

// A hint icon; its text shows on hover or focus.
export const Hint = ({ text }: { text: ReactNode }) => (
    <span className="hint-icon" tabIndex={0} role="img" aria-label="hint">
        ⓘ<span className="hint-tip" role="tooltip">{text}</span>
    </span>
);

// One field: its title (with an optional hint icon), then its input.
export const Field = ({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) => (
    <div className="field">
        <div className="field-label">
            {label}
            {hint && <Hint text={hint} />}
        </div>
        <div className="field-input">{children}</div>
    </div>
);

// A yes/no field: the checkbox with its title on one line.
export const CheckField = ({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) => (
    <div className="field field-check">
        <label className="field-label">
            <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            {label}
        </label>
        {hint && <Hint text={hint} />}
    </div>
);

// A value shown, not edited (a status, what is in effect).
export const ReadField = ({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) => (
    <Field label={label} hint={hint}>
        <div className="field-value">{children}</div>
    </Field>
);

// A tab's fields followed by Save / Discard; both are enabled only while something changed.
// `extra`: another action of the form beside them (e.g. Reset to defaults, which only fills the fields).
export const EntityForm = ({ children, dirty, saving, onSave, onDiscard, saveLabel = "Save", extra }: { children: ReactNode; dirty: boolean; saving?: boolean; onSave: () => void | Promise<void>; onDiscard: () => void; saveLabel?: string; extra?: ReactNode }) => (
    <div className="entity-form">
        <div className="ev-fields">{children}</div>
        <div className="form-actions">
            <button className="primary" disabled={!dirty || saving} onClick={() => void onSave()}>{saving ? "Saving…" : saveLabel}</button>
            <button disabled={!dirty || saving} onClick={onDiscard}>Discard</button>
            {extra}
        </div>
    </div>
);

// The edited copy of a tab's values: `dirty` against what was loaded, `reset` back to it. `init` is read again when a
// key in `deps` changes (the entity reloaded after a save).
export const useDraft = <T,>(init: () => T, deps: unknown[]) => {
    const [base, setBase] = useState<T>(init);
    const [value, setValue] = useState<T>(base);
    useEffect(() => {
        const b = init();
        setBase(b);
        setValue(b);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    const dirty = JSON.stringify(value) !== JSON.stringify(base);
    const patch = (p: Partial<T>): void => setValue((v) => ({ ...v, ...p }));
    return { value, setValue, patch, dirty, reset: () => setValue(base) };
};

// Runs a save, marking it busy; errors go to onError.
export const useSaver = (onError: (m: string) => void) => {
    const [saving, setSaving] = useState<string | null>(null);
    const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
        setSaving(key);
        try {
            await fn();
        } catch (e) {
            onError(String((e as Error).message ?? e));
        } finally {
            setSaving(null);
        }
    };
    return { saving, run };
};
