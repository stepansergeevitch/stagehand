import { Notice } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 } as const;

export const Tones = () => (
  <div style={col}>
    <Notice>The environment is using the default rebase command.</Notice>
    <Notice tone="ok">Migration applied: 4 changes.</Notice>
    <Notice tone="warn">The branch is 3 commits behind main.</Notice>
    <Notice tone="bad">Setup failed: port 5432 is already in use.</Notice>
    <Notice tone="wait">Waiting for the review round to finish.</Notice>
  </div>
);
