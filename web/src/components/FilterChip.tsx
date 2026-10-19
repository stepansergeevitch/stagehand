import { useState } from "react";
import { Button, Icon, Menu, MenuItem } from "@vortex/ds";
import { useDismiss } from "./useDismiss";
import "./filterchip.css";

// A filter in a page's filter bar: a pill that opens the list of values to pick one from ("Stage ▾"). The picked value
// is kept by the page (the route), not here.
export const FilterChip = ({ label, value, options, onPick }: { label: string; value: string | undefined; options: string[]; onPick: (value: string | undefined) => void }) => {
    const [open, setOpen] = useState(false);
    const ref = useDismiss(open, () => setOpen(false));
    return (
        <div className="filter-chip" ref={ref}>
            <Button size="sm" className="filter-chip-btn" on={!!value} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {label}<Icon name="chevronDown" />
            </Button>
            {open && (
                <Menu className="filter-chip-menu">
                    {options.map((o) => (
                        <MenuItem key={o} aria-current={o === value} onClick={() => { onPick(o === value ? undefined : o); setOpen(false); }}>
                            {o}{o === value && <Icon name="check" />}
                        </MenuItem>
                    ))}
                    {options.length === 0 && <MenuItem disabled>None</MenuItem>}
                </Menu>
            )}
        </div>
    );
};
