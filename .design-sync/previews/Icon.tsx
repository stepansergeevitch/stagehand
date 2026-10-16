import { Icon } from '@vortex/ds';

const names = ['close','plus','search','columns','filter','chevronDown','chevronRight','check','info','refresh','arrowLeft','external'] as const;

export const AllIcons = () => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, maxWidth: 420 }}>
    {names.map((n) => (
      <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11 }}>
        <Icon name={n} width={20} height={20} /> {n}
      </div>
    ))}
  </div>
);
