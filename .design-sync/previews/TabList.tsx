import { Tab, TabList } from '@vortex/ds';
import { Both } from "./_Both";

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

export const Line = () => <Both><Line_ /></Both>;
export const Pill = () => <Both><Pill_ /></Both>;
