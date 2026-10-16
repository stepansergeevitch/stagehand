import { Button, Icon } from '@vortex/ds';

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


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const Variants = () => <div style={base}><Variants_ /></div>;
export const Sizes = () => <div style={base}><Sizes_ /></div>;
export const WithIcon = () => <div style={base}><WithIcon_ /></div>;
export const ToggleAndDisabled = () => <div style={base}><ToggleAndDisabled_ /></div>;
