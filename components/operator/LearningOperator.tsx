'use client';

import { AutonomousResearchPanel } from '@/components/AutonomousResearchPanel';
import { MemoryPanel } from '@/components/MemoryPanel';
import { OperatorSection } from './OperatorSection';

export function LearningOperator() {
  return (
    <>
      <OperatorSection
        title="Memory"
        note="Stored experience the chat system prompt reads. Nothing here writes to risk config or strategy selection."
      >
        <MemoryPanel />
      </OperatorSection>
      <OperatorSection title="Autonomous research">
        <AutonomousResearchPanel />
      </OperatorSection>
    </>
  );
}
