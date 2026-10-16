import { Badge } from '@vortex/ds';
import { Both } from "./_Both";

const row = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } as const;

const Tones_ = () => (
  <div style={row}>
    <Badge>3</Badge><Badge tone="accent">12</Badge><Badge tone="ok">passed</Badge><Badge tone="warn">2</Badge><Badge tone="bad">failed</Badge><Badge tone="wait">queued</Badge><Badge tone="info">new</Badge>
  </div>
);
export const Tones = () => <Both><Tones_ /></Both>;
