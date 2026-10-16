import { Menu, MenuItem } from '@vortex/ds';
import { Both } from "./_Both";

const States_ = () => (
  <Menu style={{ maxWidth: 220 }}>
    <MenuItem>Default</MenuItem>
    <MenuItem danger>Danger</MenuItem>
    <MenuItem disabled>Disabled</MenuItem>
  </Menu>
);
export const States = () => <Both><States_ /></Both>;
