'use client';

import { OrderFlowPanel } from '@/components/OrderFlowPanel';
import { OperatorSection } from './OperatorSection';

export function ExecutionOperator() {
  return (
    <OperatorSection title="Order flow" note="Live book pressure, from the exchange depth stream.">
      <OrderFlowPanel />
    </OperatorSection>
  );
}
