import { Button, Card, Chip } from '@vortex/ds';

const Titled_ = () => (
  <Card title="Pull request">
    <p style={{ margin: 0 }}>Two repositories changed; both branches are pushed and waiting for review.</p>
  </Card>
);

const WithBadgeAndActions_ = () => (
  <Card title="CI status" badge={<Chip tone="warn">1 running</Chip>}>
    <p style={{ margin: '0 0 12px' }}>Lint and unit tests passed. End-to-end is still running.</p>
    <div style={{ display: 'flex', gap: 8 }}>
      <Button variant="primary" size="sm">Open checks</Button>
      <Button size="sm">Re-run</Button>
    </div>
  </Card>
);

const Untitled_ = () => (
  <Card>No title: just a padded panel with the shared border, radius and shadow.</Card>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const Titled = () => <div style={base}><Titled_ /></div>;
export const WithBadgeAndActions = () => <div style={base}><WithBadgeAndActions_ /></div>;
export const Untitled = () => <div style={base}><Untitled_ /></div>;
