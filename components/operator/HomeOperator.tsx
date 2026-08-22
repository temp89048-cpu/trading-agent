'use client';

// Mission planning. It belongs on /home because a Mission is the standing
// objective every other page's numbers are read against.

import { MissionPlannerPanel } from '@/components/MissionPlannerPanel';
import { OperatorSection } from './OperatorSection';

export function HomeOperator() {
  return (
    <OperatorSection
      title="Mission"
      note="A capital-target Mission has no deadline and only ever produces advisory caution notes — never a hard rule and never a sizing override. Writes to the Mission store via MissionPlannerProvider."
    >
      <MissionPlannerPanel />
    </OperatorSection>
  );
}
