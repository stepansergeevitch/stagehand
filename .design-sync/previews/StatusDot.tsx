import { StatusDot } from '@vortex/ds';
import { Both } from "./_Both";

const row = { display: 'flex', flexDirection: 'column', gap: 8 } as const;
const item = { display: 'flex', alignItems: 'center', gap: 8 } as const;

const States_ = () => (
  <div style={row}>
    <div style={item}><StatusDot tone="ok" /> Passed</div>
    <div style={item}><StatusDot tone="accent" pulse /> Running</div>
    <div style={item}><StatusDot tone="wait" /> Waiting for review</div>
    <div style={item}><StatusDot tone="warn" /> Flaky</div>
    <div style={item}><StatusDot tone="bad" /> Failed</div>
    <div style={item}><StatusDot /> Idle</div>
  </div>
);
export const States = () => <Both><States_ /></Both>;
