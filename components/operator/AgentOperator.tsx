'use client';

import { AgentOSPanel } from '@/components/AgentOSPanel';
import { AgentPanel } from '@/components/AgentPanel';
import { AutonomousTraderPanel } from '@/components/AutonomousTraderPanel';
import { DebatePanel } from '@/components/DebatePanel';
import { DebateVisualizer } from '@/components/DebateVisualizer';
import { OperatorSection } from './OperatorSection';

export function AgentOperator() {
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <OperatorSection
          title="Agent control"
          note="Starts and stops the client-side analysis loop."
        >
          <AgentPanel />
        </OperatorSection>
        <OperatorSection
          title="Autonomous trader"
          note="When on, agent-originated trades still pass through the Supervisor gate — that path has no bypass. Closes are never blocked by a pause."
        >
          <AutonomousTraderPanel />
        </OperatorSection>
      </div>

      <OperatorSection
        title="Debate"
        note="Deterministic, not an LLM call: the moderator reasons over numbers already computed, so it is reproducible and cannot hallucinate a figure."
      >
        <DebatePanel />
      </OperatorSection>

      <OperatorSection title="Debate stream" note="Rounds as they arrive on the shared event connection.">
        <DebateVisualizer />
      </OperatorSection>

      <OperatorSection title="Agent OS">
        <AgentOSPanel />
      </OperatorSection>
    </>
  );
}
