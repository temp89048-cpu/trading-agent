'use client';

import { StrategyEnsemblePanel } from '@/components/StrategyEnsemblePanel';
import { OperatorSection } from './OperatorSection';

export function StrategiesOperator() {
  return (
    <OperatorSection
      title="Strategy ensemble"
      note="The client-side ensemble vote. Distinct from the backend's specialist panel above — this one scores the TypeScript strategies in lib/strategies."
    >
      <StrategyEnsemblePanel />
    </OperatorSection>
  );
}
