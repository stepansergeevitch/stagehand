import { Chip } from '@vortex/ds';

const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as const;

const Tones_ = () => (
  <div style={row}>
    <Chip>draft</Chip>
    <Chip tone="ok">passed</Chip>
    <Chip tone="warn">flaky</Chip>
    <Chip tone="bad">failed</Chip>
    <Chip tone="wait">waiting</Chip>
    <Chip tone="accent">in review</Chip>
  </div>
);

const AsLabels_ = () => (
  <div style={row}>
    <Chip tone="accent">ENG-24845</Chip>
    <Chip>main</Chip>
    <Chip tone="ok">3 checks green</Chip>
  </div>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const Tones = () => <div style={base}><Tones_ /></div>;
export const AsLabels = () => <div style={base}><AsLabels_ /></div>;
