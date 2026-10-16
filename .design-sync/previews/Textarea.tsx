import { Textarea } from '@vortex/ds';

const col = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 } as const;

export const States = () => (
  <div style={col}>
    <Textarea placeholder="Describe the change" rows={3} />
    <Textarea invalid defaultValue="select 1 from" rows={2} />
    <Textarea disabled defaultValue="npm run migrate" rows={2} />
  </div>
);
