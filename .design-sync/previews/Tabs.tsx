import { Tabs } from '@vortex/ds';
import { Both } from "./_Both";

const items = [
  { key: 'overview', label: 'Overview' },
  { key: 'commands', label: 'Commands' },
  { key: 'qa', label: 'QA' },
  { key: 'secrets', label: 'Variables' },
];

const Line_ = () => <Tabs items={items} active="commands" onChange={() => {}} />;

const Pill_ = () => <Tabs variant="pill" items={items} active="qa" onChange={() => {}} />;

export const Line = () => <Both><Line_ /></Both>;
export const Pill = () => <Both><Pill_ /></Both>;
