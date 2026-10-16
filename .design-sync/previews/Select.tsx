import { Select } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } as const;

export const States = () => (
  <div style={col}>
    <Select defaultValue="main"><option>main</option><option>develop</option><option>release</option></Select>
    <Select invalid defaultValue=""><option value="" disabled>Choose a branch</option></Select>
    <Select disabled><option>locked</option></Select>
  </div>
);
