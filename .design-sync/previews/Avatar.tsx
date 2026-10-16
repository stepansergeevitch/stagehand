import { Avatar } from '@vortex/ds';
import { Both } from "./_Both";

const Sizes_ = () => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
    <Avatar name="Ada Lovelace" size={22} />
    <Avatar name="Ada Lovelace" />
    <Avatar name="Grace Hopper" size={40} tone="ok" />
    <Avatar name="Linus Torvalds" size={40} tone="wait" />
    <Avatar name="Margaret Hamilton" size={40} tone="warn" />
  </div>
);
export const Sizes = () => <Both><Sizes_ /></Both>;
