import { Mark } from '@vortex/ds';

const row = { display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' } as const;

export const Sizes = () => (
  <div style={{ ...row, color: 'var(--accent)' }}>
    <Mark size={16} />
    <Mark size={24} />
    <Mark size={32} />
    <Mark size={64} />
  </div>
);

export const OnAccent = () => (
  <div style={{ display: 'inline-flex', padding: 16, borderRadius: 'var(--r-lg)', background: 'var(--accent)', color: 'var(--accent-ink)' }}>
    <Mark size={48} />
  </div>
);
