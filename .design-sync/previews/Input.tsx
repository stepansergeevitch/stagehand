import { Input } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } as const;

const States_ = () => (
  <div style={col}>
    <Input placeholder="Environment name" />
    <Input defaultValue="staging-eu" />
    <Input invalid className="field-ctl" defaultValue="not a valid port" />
    <Input disabled defaultValue="read-only value" />
  </div>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const States = () => <div style={base}><States_ /></div>;
