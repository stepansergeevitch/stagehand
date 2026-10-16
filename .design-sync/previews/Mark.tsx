import { Mark } from '@vortex/ds';
import { Both } from "./_Both";

const row = { display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' } as const;

const Sizes_ = () => (
  <div style={{ ...row, color: 'var(--accent)' }}>
    <Mark size={16} />
    <Mark size={24} />
    <Mark size={32} />
    <Mark size={64} />
  </div>
);

const OnAccent_ = () => (
  <div style={{ display: 'inline-flex', padding: 16, borderRadius: 'var(--r-lg)', background: 'var(--accent)', color: 'var(--accent-ink)' }}>
    <Mark size={48} />
  </div>
);

export const Sizes = () => <Both><Sizes_ /></Both>;
export const OnAccent = () => <Both><OnAccent_ /></Both>;
