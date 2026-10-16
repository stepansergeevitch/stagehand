import { Tab, TabList } from '@vortex/ds';

const ActiveAndIdle_ = () => (
  <TabList>
    <Tab active>Active</Tab><Tab>Idle</Tab><Tab>Archived</Tab>
  </TabList>
);


// The DS stylesheet sets no base font: a host page sets font-family/size/colour on body, so each cell does the same.
const base = { fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', color: 'var(--ink)' } as const;
export const ActiveAndIdle = () => <div style={base}><ActiveAndIdle_ /></div>;
