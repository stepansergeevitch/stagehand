import { Hint } from '@vortex/ds';
import { Both } from "./_Both";

const InLabel_ = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 500 }}>Login callback ports <Hint text="The identity provider accepts only these as its callback" /></label>
    <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontWeight: 500 }}>Migrate down <Hint text="Rolls back the migrations the branch added" /></label>
  </div>
);
export const InLabel = () => <Both><InLabel_ /></Both>;
