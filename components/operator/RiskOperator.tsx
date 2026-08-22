'use client';

import { useState } from 'react';

import { RiskManagerPanel } from '@/components/RiskManagerPanel';
import { RiskMeter } from '@/components/RiskMeter';
import { TradingControlsPanel } from '@/components/TradingControlsPanel';
import { OperatorSection, TabSwitch } from './OperatorSection';

export function RiskOperator() {
  const [tab, setTab] = useState<'paper' | 'real'>('paper');

  return (
    <>
      <OperatorSection title="Concentration & buffer" action={<TabSwitch tab={tab} onChange={setTab} />}>
        <RiskMeter tab={tab} />
      </OperatorSection>

      <OperatorSection
        title="Risk manager"
        note="Position sizing and the stop that every position must have. A trade with no computable stop is rejected outright — that is not softened here."
      >
        <RiskManagerPanel />
      </OperatorSection>

      <OperatorSection
        title="Trading controls — writes live limits"
        note="The real editable risk configuration: limits, the real-account starting capital the real-tab checks need, and the second-opinion model. The 3x real / 10x paper leverage ceiling is NOT in this config and cannot be raised from here by design."
      >
        <TradingControlsPanel />
      </OperatorSection>
    </>
  );
}
