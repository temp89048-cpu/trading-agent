'use client';

import { useState } from 'react';

import { PaperTradePanel } from '@/components/PaperTradePanel';
import { PortfolioAnalytics } from '@/components/PortfolioAnalytics';
import { PortfolioIntelligencePanel } from '@/components/PortfolioIntelligencePanel';
import { PortfolioStats } from '@/components/PortfolioStats';
import { RealPortfolioPanel } from '@/components/RealPortfolioPanel';
import { OperatorSection, TabSwitch } from './OperatorSection';

export function PositionsOperator() {
  const [tab, setTab] = useState<'paper' | 'real'>('paper');

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <OperatorSection
          title="Place a paper trade"
          note="A MANUAL human order. It deliberately does not pass through the Supervisor gate — supervising agents means supervising agents, not overriding the operator."
        >
          <PaperTradePanel />
        </OperatorSection>
        <OperatorSection
          title="Real holdings"
          note="Declared real positions. Recording one here does not place an order with any exchange."
        >
          <RealPortfolioPanel />
        </OperatorSection>
      </div>

      <OperatorSection
        title="Portfolio statistics"
        action={<TabSwitch tab={tab} onChange={setTab} />}
      >
        <PortfolioStats tab={tab} />
      </OperatorSection>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <OperatorSection title={`Analytics — ${tab}`}>
          <PortfolioAnalytics tab={tab} />
        </OperatorSection>
        <OperatorSection title="Portfolio intelligence">
          <PortfolioIntelligencePanel />
        </OperatorSection>
      </div>
    </>
  );
}
