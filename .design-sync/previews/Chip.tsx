import { Chip } from '@vortex/ds';

const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as const;

export const Tones = () => (
  <div style={row}>
    <Chip>draft</Chip>
    <Chip tone="ok">passed</Chip>
    <Chip tone="warn">flaky</Chip>
    <Chip tone="bad">failed</Chip>
    <Chip tone="wait">waiting</Chip>
    <Chip tone="accent">in review</Chip>
  </div>
);

export const AsLabels = () => (
  <div style={row}>
    <Chip tone="accent">ENG-24845</Chip>
    <Chip>main</Chip>
    <Chip tone="ok">3 checks green</Chip>
  </div>
);
