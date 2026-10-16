import { Radio } from '@vortex/ds';
import { Both } from "./_Both";

const Group_ = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Radio name="merge" label="Squash and merge" defaultChecked />
    <Radio name="merge" label="Create a merge commit" />
    <Radio name="merge" label="Rebase and merge" disabled />
  </div>
);
export const Group = () => <Both><Group_ /></Both>;
