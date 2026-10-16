import { IconButton } from '@vortex/ds';
import { Both } from "./_Both";

const Variants_ = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <IconButton icon="refresh" label="Refresh" />
    <IconButton icon="plus" label="Create" variant="primary" />
    <IconButton icon="filter" label="Filter" on />
    <IconButton icon="close" label="Close" variant="ghost" size="sm" />
    <IconButton icon="search" label="Search" disabled />
  </div>
);
export const Variants = () => <Both><Variants_ /></Both>;
