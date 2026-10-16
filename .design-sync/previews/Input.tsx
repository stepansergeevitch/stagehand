import { Input } from '@vortex/ds';
import { Both } from "./_Both";

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } as const;

const States_ = () => (
  <div style={col}>
    <Input placeholder="Environment name" />
    <Input defaultValue="staging-eu" />
    <Input invalid defaultValue="not a valid port" />
    <Input disabled defaultValue="read-only value" />
  </div>
);

export const States = () => <Both><States_ /></Both>;
