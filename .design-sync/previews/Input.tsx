import { Input } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } as const;

export const States = () => (
  <div style={col}>
    <Input placeholder="Environment name" />
    <Input defaultValue="staging-eu" />
    <Input invalid defaultValue="not a valid port" />
    <Input disabled defaultValue="read-only value" />
  </div>
);
