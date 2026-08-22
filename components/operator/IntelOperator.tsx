'use client';

import { EventDetectionPanel } from '@/components/EventDetectionPanel';
import { MarketIntelPanel } from '@/components/MarketIntelPanel';
import { MultiExchangePanel } from '@/components/MultiExchangePanel';
import { OperatorSection } from './OperatorSection';

export function IntelOperator() {
  return (
    <>
      <OperatorSection title="Market intelligence">
        <MarketIntelPanel />
      </OperatorSection>
      <OperatorSection
        title="Event detection"
        note="Detected events become advisory caution notes on the Supervisor's review. They never block a close."
      >
        <EventDetectionPanel />
      </OperatorSection>
      <OperatorSection title="Cross-exchange" note="Price and depth comparison across the configured venues.">
        <MultiExchangePanel />
      </OperatorSection>
    </>
  );
}
