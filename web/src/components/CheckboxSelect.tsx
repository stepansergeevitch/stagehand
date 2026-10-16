import { useCallback, useState } from "react";
import { useDismiss } from "./useDismiss";

export interface CheckboxOption {
    value: string;
    label: string;
    // Why it cannot be picked (shown on hover); the option stays visible.
    disabled?: string | undefined;
}

// A select of several values: a button naming the picked ones that opens a list of checkboxes. The order of `value` is
// kept (the first picked stays first); at least `min` values stay picked.
export const CheckboxSelect = ({ options, value, onChange, placeholder = "None", min = 0, disabled }: { options: CheckboxOption[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; min?: number; disabled?: boolean }) => {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const ref = useDismiss(open, close);
    const label = (v: string) => options.find((o) => o.value === v)?.label ?? v;
    const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
    return (
        <div className="dt-picker checkbox-select" ref={ref}>
            <button type="button" className={open ? "on" : ""} disabled={disabled} onClick={() => setOpen((o) => !o)}>
                {value.length ? value.map(label).join(", ") : placeholder} ▾
            </button>
            {open && (
                <div className="dt-menu left" role="menu">
                    {options.map((o) => {
                        const on = value.includes(o.value);
                        const off = (on && value.length <= min) || (!on && !!o.disabled);
                        return (
                            <label key={o.value} className="dt-menu-item" title={!on ? o.disabled : on && value.length <= min ? `keep at least ${min}` : undefined}>
                                <input type="checkbox" checked={on} disabled={off} onChange={() => toggle(o.value)} />
                                {o.label}
                            </label>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
