import { Button, Hint, Tooltip } from '@vortex/ds';
import { Both } from "./_Both";

// The bubble is shown open here so the card shows it; in the product it appears on hover or focus.
const open = `.tip .tip-bubble { opacity: 1 !important; visibility: visible !important; transform: translate(-50%, 0) !important; }`;

const Bubble_ = () => (
  <div style={{ display: 'grid', gap: 52, padding: '40px 90px 12px' }}>
    <style>{open}</style>
    <Tooltip text="Runs the setup command in a fresh worktree"><Button>Prepare</Button></Tooltip>
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>Base branch <Hint text="The branch this task rebases onto" /></span>
  </div>
);
export const Bubble = () => <Both><Bubble_ /></Both>;
