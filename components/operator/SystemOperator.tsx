'use client';

import { ExchangeConnectionsPanel } from '@/components/ExchangeConnectionsPanel';
import { SystemHealthPanel } from '@/components/SystemHealthPanel';
import { OperatorSection } from './OperatorSection';

export function SystemOperator() {
  return (
    <>
      <OperatorSection title="Client-side health" note="What this browser session can see, distinct from the backend checks above.">
        <SystemHealthPanel />
      </OperatorSection>
      <OperatorSection
        title="Exchange connections"
        note="API keys are held in this browser. Adding one here does not enable live trading — only the backend's LIVE_TRADING flag does that."
      >
        <ExchangeConnectionsPanel />
      </OperatorSection>
    </>
  );
}
