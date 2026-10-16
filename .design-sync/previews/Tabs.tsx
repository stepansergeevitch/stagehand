import { Tabs } from '@vortex/ds';

const items = [
  { key: 'overview', label: 'Overview' },
  { key: 'commands', label: 'Commands' },
  { key: 'qa', label: 'QA' },
  { key: 'secrets', label: 'Variables' },
];

export const Line = () => <Tabs items={items} active="commands" onChange={() => {}} />;

export const Pill = () => <Tabs variant="pill" items={items} active="qa" onChange={() => {}} />;
