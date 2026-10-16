import { Tab, TabList } from '@vortex/ds';
import { Both } from "./_Both";

const ActiveAndIdle_ = () => (
  <TabList>
    <Tab active>Active</Tab><Tab>Idle</Tab><Tab>Archived</Tab>
  </TabList>
);

export const ActiveAndIdle = () => <Both><ActiveAndIdle_ /></Both>;
