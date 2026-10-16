import { useCallback, useState } from "react";
import { useDismiss } from "./useDismiss";
import { Button, Checkbox, Icon, Menu } from "@vortex/ds";
import "../settings.css";

export interface CheckboxOption {
    value: string;
    label: string;
    // Why it cannot be picked (shown on hover); the option stays visible.
    disabled?: string | undefined;
}

// A select of several values: a button naming the picked ones that opens a list of checkboxes. The order of `value` is
// kept (the first picked stays first); at least `min` values stay picked. Esc or a click outside closes the list.
export const CheckboxSelect = ({ options, value, onChange, placeholder = "None", min = 0, disabled, label }: { options: CheckboxOption[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; min?: number; disabled?: boolean; label?: string }) => {
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const ref = useDismiss(open, close);
    const name = (v: string) => options.find((o) => o.value === v)?.label ?? v;
    const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
    return (
        <div className="checkbox-select" ref={ref}>
            <Button type="button" on={open} disabled={disabled} aria-haspopup="menu" aria-expanded={open} {...(label ? { "aria-label": label } : {})} onClick={() => setOpen((o) => !o)}>
                <span className="cs-value">{value.length ? value.map(name).join(", ") : placeholder}</span>
                <Icon name="chevronDown" />
            </Button>
            {open && (
                <Menu className="cs-list">
                    {options.map((o) => {
                        const on = value.includes(o.value);
                        const off = (on && value.length <= min) || (!on && !!o.disabled);
                        return (
                            <Checkbox
                                key={o.value}
                                className="cs-item"
                                label={o.label}
                                checked={on}
                                disabled={off}
                                title={!on ? o.disabled : on && value.length <= min ? `Keep at least ${min}` : undefined}
                                onChange={() => toggle(o.value)}
                            />
                        );
                    })}
                </Menu>
            )}
        </div>
    );
};
