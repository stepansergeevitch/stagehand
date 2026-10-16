import { Icon, Kbd, Menu, MenuItem } from '@vortex/ds';
import { Both } from "./_Both";

const Actions_ = () => (
  <Menu style={{ maxWidth: 240 }}>
    <MenuItem><Icon name="refresh" /> Rebase onto main <Kbd>R</Kbd></MenuItem>
    <MenuItem><Icon name="external" /> Open pull request</MenuItem>
    <hr />
    <MenuItem danger><Icon name="close" /> Delete branch</MenuItem>
    <MenuItem disabled>Merge (checks running)</MenuItem>
  </Menu>
);
export const Actions = () => <Both><Actions_ /></Both>;
