import { Checkbox } from '@vortex/ds';
import { Both } from "./_Both";

const States_ = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Checkbox label="Run verification" defaultChecked />
    <Checkbox label="Run component tests" />
    <Checkbox label="Skip migrations" disabled />
  </div>
);
export const States = () => <Both><States_ /></Both>;
