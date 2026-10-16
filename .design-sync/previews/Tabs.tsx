import { Tabs } from '@vortex/ds';

const items = [
  { key: 'overview', label: 'Overview' },
  { key: 'commands', label: 'Commands' },
  { key: 'qa', label: 'QA' },
  { key: 'secrets', label: 'Variables' },
];

const Line_ = () => <Tabs items={items} active="commands" onChange={() => {}} />;

const Pill_ = () => <Tabs variant="pill" items={items} active="qa" onChange={() => {}} />;


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const Line = () => <div style={base}><Line_ /></div>;
export const Pill = () => <div style={base}><Pill_ /></div>;
