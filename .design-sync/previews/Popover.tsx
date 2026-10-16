import { Button, Input, Popover } from '@vortex/ds';
import { Both } from "./_Both";

const Form_ = () => (
  <Popover style={{ maxWidth: 280 }}>
    <div style={{ display: 'grid', gap: 8 }}>
      <strong>Add a label</strong>
      <Input placeholder="Label text" />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><Button variant="ghost" size="sm">Cancel</Button><Button variant="primary" size="sm">Add</Button></div>
    </div>
  </Popover>
);
export const Form = () => <Both><Form_ /></Both>;
