import { CodeArea } from '@vortex/ds';
import { Both } from "./_Both";

const col = { display: 'grid', gap: 10, maxWidth: 420 } as const;

const Sizes_ = () => (
  <div style={col}>
    <CodeArea size="sm" defaultValue={'npm ci\nnpm run build'} />
    <CodeArea size="md" defaultValue={'psql "$DATABASE_URL" -c "select 1"\nnpm run migrate'} />
    <CodeArea size="lg" defaultValue={'#!/bin/sh\nset -e\ngit fetch origin\ngit rebase origin/main\nnpm test'} />
  </div>
);

const Prose_ = () => (
  <div style={col}>
    <CodeArea prose size="md" defaultValue="Seed one organisation with two users, then open the billing page and check the invoice total matches the ticket." />
    <CodeArea invalid defaultValue="npm run" />
    <CodeArea disabled defaultValue="locked by the environment" />
  </div>
);

export const Sizes = () => <Both><Sizes_ /></Both>;
export const ProseAndStates = () => <Both><Prose_ /></Both>;
