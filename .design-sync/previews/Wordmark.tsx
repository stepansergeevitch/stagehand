import { Wordmark } from '@vortex/ds';

const row = { display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' } as const;

export const Sizes = () => (
  <div style={row}>
    <Wordmark size="sm" />
    <Wordmark />
    <Wordmark size="lg" />
  </div>
);

export const MarkOnly = () => (
  <div style={row}>
    <Wordmark markOnly size="sm" />
    <Wordmark markOnly />
    <Wordmark markOnly size="lg" />
  </div>
);

export const InTopbar = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', maxWidth: 480 }}>
    <Wordmark />
    <span style={{ flex: 1 }} />
    <span style={{ color: 'var(--ink-3)', fontSize: 'var(--fs-sm)' }}>3 tasks running</span>
  </div>
);
