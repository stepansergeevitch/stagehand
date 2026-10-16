import { Button, Icon } from '@vortex/ds';

const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as const;

export const Variants = () => (
  <div style={row}>
    <Button>Cancel</Button>
    <Button variant="primary">Create task</Button>
    <Button variant="danger">Delete branch</Button>
    <Button variant="ghost">Skip</Button>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <Button variant="primary">Run QA</Button>
    <Button variant="primary" size="sm">Run QA</Button>
    <Button size="sm">Rebase</Button>
  </div>
);

export const WithIcon = () => (
  <div style={row}>
    <Button variant="primary"><Icon name="plus" /> New environment</Button>
    <Button><Icon name="refresh" /> Refresh</Button>
    <Button icon aria-label="Search"><Icon name="search" /></Button>
    <Button icon size="sm" variant="ghost" aria-label="Close"><Icon name="close" /></Button>
  </div>
);

export const ToggleAndDisabled = () => (
  <div style={row}>
    <Button icon on aria-label="Filter"><Icon name="filter" /></Button>
    <Button icon aria-label="Columns"><Icon name="columns" /></Button>
    <Button disabled>Merge</Button>
    <Button variant="primary" disabled>Push</Button>
  </div>
);
