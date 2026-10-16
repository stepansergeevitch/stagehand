import { Skeleton } from '@vortex/ds';
import { Both } from "./_Both";

const Rows_ = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Skeleton circle width={36} height={36} />
    <div style={{ flex: 1, display: 'grid', gap: 8 }}><Skeleton width="60%" /><Skeleton width="90%" height={10} /></div>
  </div>
);
export const Rows = () => <Both><Rows_ /></Both>;
