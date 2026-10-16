import { Tab, TabList } from '@vortex/ds';

const Line_ = () => (
  <TabList>
    <Tab active>Files</Tab><Tab>Tests</Tab><Tab>Diff</Tab>
  </TabList>
);

const Pill_ = () => (
  <TabList variant="pill">
    <Tab>Unstaged</Tab><Tab active>Staged</Tab><Tab>Committed</Tab>
  </TabList>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const Line = () => <div style={base}><Line_ /></div>;
export const Pill = () => <div style={base}><Pill_ /></div>;
