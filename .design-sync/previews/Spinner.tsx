import { Button, Spinner } from '@vortex/ds';
import { Both } from "./_Both";

const InContext_ = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
    <Spinner />
    <Button disabled><Spinner label="Running" /> Running QA</Button>
    <span style={{ color: 'var(--accent)' }}><Spinner /></span>
  </div>
);
export const InContext = () => <Both><InContext_ /></Both>;
