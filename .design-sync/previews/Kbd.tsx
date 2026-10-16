import { Kbd } from '@vortex/ds';
import { Both } from "./_Both";

const Shortcuts_ = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <span><Kbd>⌘</Kbd> <Kbd>K</Kbd> Search tasks</span>
    <span><Kbd>g</Kbd> <Kbd>t</Kbd> Go to tasks</span>
    <span><Kbd>Esc</Kbd> Close</span>
  </div>
);
export const Shortcuts = () => <Both><Shortcuts_ /></Both>;
