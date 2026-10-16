import { Divider } from '@vortex/ds';
import { Both } from "./_Both";

const Horizontal_ = () => (<div><div>Setup</div><Divider /><div>Verification</div></div>);
const Vertical_ = () => (<div style={{ display: 'flex', alignItems: 'center', height: 28 }}><span>Files</span><Divider vertical /><span>Tests</span><Divider vertical /><span>Diff</span></div>);
export const Horizontal = () => <Both><Horizontal_ /></Both>;
export const Vertical = () => <Both><Vertical_ /></Both>;
