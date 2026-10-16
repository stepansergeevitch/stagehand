import { Chip } from '@vortex/ds';
import { Both } from "./_Both";

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

export const Tones = () => <Both><Tones_ /></Both>;
export const AsLabels = () => <Both><AsLabels_ /></Both>;
