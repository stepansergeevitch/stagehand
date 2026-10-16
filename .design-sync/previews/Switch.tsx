import { Switch } from '@vortex/ds';
import { Both } from "./_Both";

const States_ = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Switch label="Auto-push the task branch" defaultChecked />
    <Switch label="New tasks get their own database" />
    <Switch label="Locked by the environment" defaultChecked disabled />
  </div>
);
export const States = () => <Both><States_ /></Both>;
