import { Button, Card, Chip } from '@vortex/ds';

export const Titled = () => (
  <Card title="Pull request">
    <p style={{ margin: 0 }}>Two repositories changed; both branches are pushed and waiting for review.</p>
  </Card>
);

export const WithBadgeAndActions = () => (
  <Card title="CI status" badge={<Chip tone="warn">1 running</Chip>}>
    <p style={{ margin: '0 0 12px' }}>Lint and unit tests passed. End-to-end is still running.</p>
    <div style={{ display: 'flex', gap: 8 }}>
      <Button variant="primary" size="sm">Open checks</Button>
      <Button size="sm">Re-run</Button>
    </div>
  </Card>
);

export const Untitled = () => (
  <Card>No title: just a padded panel with the shared border, radius and shadow.</Card>
);
