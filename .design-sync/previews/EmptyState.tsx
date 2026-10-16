import { Button, EmptyState } from '@vortex/ds';
import { Both } from "./_Both";

const Basic_ = () => (
  <EmptyState title="No tasks yet" action={<Button variant="primary" size="sm">Create task</Button>}>Tasks you create show up here and move through the stages.</EmptyState>
);
const Searching_ = () => <EmptyState icon="search" title="Nothing matches">Try a different search or clear the filters.</EmptyState>;
export const Basic = () => <Both><Basic_ /></Both>;
export const Searching = () => <Both><Searching_ /></Both>;
