import { Textarea } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } as const;

const States_ = () => (
  <div style={col}>
    <Textarea placeholder="Describe the change" rows={3} />
    <Textarea invalid className="field-ctl" defaultValue="select 1 from" rows={2} />
    <Textarea disabled defaultValue="npm run migrate" rows={2} />
  </div>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const States = () => <div style={base}><States_ /></div>;
