import type { ReactNode } from 'react';

// Every preview renders its stories on both themes side by side; dark/light are pinned with data-theme so the card does not depend on the browser setting.
const pane = (theme: 'light' | 'dark'): React.CSSProperties => ({ background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'var(--sans)', fontSize: 'var(--fs-md)', lineHeight: 1.5, padding: 16, minWidth: 0, colorScheme: theme });

export const Both = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
    <div data-theme="light" style={pane('light')}>{children}</div>
    <div data-theme="dark" style={pane('dark')}>{children}</div>
  </div>
);
