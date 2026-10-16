import { Tab, TabList } from '@vortex/ds';

export const Line = () => (
  <TabList>
    <Tab active>Files</Tab><Tab>Tests</Tab><Tab>Diff</Tab>
  </TabList>
);

export const Pill = () => (
  <TabList variant="pill">
    <Tab>Unstaged</Tab><Tab active>Staged</Tab><Tab>Committed</Tab>
  </TabList>
);
