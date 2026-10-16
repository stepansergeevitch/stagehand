import { Notice } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 } as const;

const Tones_ = () => (
  <div style={col}>
    <Notice>The environment is using the default rebase command.</Notice>
    <Notice tone="ok">Migration applied: 4 changes.</Notice>
    <Notice tone="warn">The branch is 3 commits behind main.</Notice>
    <Notice tone="bad">Setup failed: port 5432 is already in use.</Notice>
    <Notice tone="wait">Waiting for the review round to finish.</Notice>
  </div>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const Tones = () => <div style={base}><Tones_ /></div>;
