import { Select } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } as const;

const States_ = () => (
  <div style={col}>
    <Select defaultValue="main"><option>main</option><option>develop</option><option>release</option></Select>
    <Select invalid className="field-ctl" defaultValue=""><option value="" disabled>Choose a branch</option></Select>
    <Select disabled><option>locked</option></Select>
  </div>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const States = () => <div style={base}><States_ /></div>;
