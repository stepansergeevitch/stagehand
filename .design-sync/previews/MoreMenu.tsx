import { useEffect, useRef } from 'react';
import { Button, Icon, MenuItem, MoreMenu } from '@vortex/ds';
import { Both } from "./_Both";

// Opens the real menu on mount so the card shows the open state; in the product it opens on click.
const Open = ({ children }: { children: React.ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.click(); }, []);
  return <div ref={ref} style={{ minHeight: 190, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', paddingRight: 8 }}>{children}</div>;
};

const Closed_ = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
    <Button variant="primary">Approve</Button>
    <MoreMenu />
  </div>
);

const Open_ = () => (
  <Open>
    <MoreMenu label="Task actions">
      <MenuItem><Icon name="refresh" /> Rebase onto main</MenuItem>
      <MenuItem><Icon name="external" /> Open pull request</MenuItem>
      <hr />
      <MenuItem danger><Icon name="close" /> Delete task</MenuItem>
    </MoreMenu>
  </Open>
);

export const Closed = () => <Both><Closed_ /></Both>;
export const OpenMenu = () => <Both><Open_ /></Both>;
