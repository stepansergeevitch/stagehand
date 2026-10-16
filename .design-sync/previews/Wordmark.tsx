import { Wordmark } from '@vortex/ds';
import { Both } from "./_Both";

const row = { display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' } as const;

const Sizes_ = () => (
  <div style={row}>
    <Wordmark size="sm" />
    <Wordmark />
    <Wordmark size="lg" />
  </div>
);

const MarkOnly_ = () => (
  <div style={row}>
    <Wordmark markOnly size="sm" />
    <Wordmark markOnly />
    <Wordmark markOnly size="lg" />
  </div>
);

const InTopbar_ = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', maxWidth: 480 }}>
    <Wordmark />
    <span style={{ flex: 1 }} />
    <span style={{ color: 'var(--ink-3)', fontSize: 'var(--fs-sm)' }}>3 tasks running</span>
  </div>
);

export const Sizes = () => <Both><Sizes_ /></Both>;
export const MarkOnly = () => <Both><MarkOnly_ /></Both>;
export const InTopbar = () => <Both><InTopbar_ /></Both>;
