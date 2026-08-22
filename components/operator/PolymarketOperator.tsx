'use client';

import { PolymarketPanel } from '@/components/PolymarketPanel';
import { OperatorSection } from './OperatorSection';

export function PolymarketOperator() {
  return (
    <OperatorSection
      title="Prediction-market panel"
      note="The client-side view of the same feed. Confirming a mapping is a human-only action — the API rejects a confirmation that does not carry set_by_human."
    >
      <PolymarketPanel />
    </OperatorSection>
  );
}
