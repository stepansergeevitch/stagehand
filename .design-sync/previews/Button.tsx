import { Button, Icon } from '@vortex/ds';
import { Both } from "./_Both";

const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as const;

const Variants_ = () => (
  <div style={row}>
    <Button>Cancel</Button>
    <Button variant="primary">Create task</Button>
    <Button variant="danger">Delete branch</Button>
    <Button variant="ghost">Skip</Button>
  </div>
);

const Sizes_ = () => (
  <div style={row}>
    <Button variant="primary">Run QA</Button>
    <Button variant="primary" size="sm">Run QA</Button>
    <Button size="sm">Rebase</Button>
  </div>
);

const WithIcon_ = () => (
  <div style={row}>
    <Button variant="primary"><Icon name="plus" /> New environment</Button>
    <Button><Icon name="refresh" /> Refresh</Button>
    <Button icon aria-label="Search"><Icon name="search" /></Button>
    <Button icon size="sm" variant="ghost" aria-label="Close"><Icon name="close" /></Button>
  </div>
);

const ToggleAndDisabled_ = () => (
  <div style={row}>
    <Button icon on aria-label="Filter"><Icon name="filter" /></Button>
    <Button icon aria-label="Columns"><Icon name="columns" /></Button>
    <Button disabled>Merge</Button>
    <Button variant="primary" disabled>Push</Button>
  </div>
);

export const Variants = () => <Both><Variants_ /></Both>;
export const Sizes = () => <Both><Sizes_ /></Both>;
export const WithIcon = () => <Both><WithIcon_ /></Both>;
export const ToggleAndDisabled = () => <Both><ToggleAndDisabled_ /></Both>;
