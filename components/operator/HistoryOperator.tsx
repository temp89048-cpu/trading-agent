'use client';

// TradeLogPanel is mounted here rather than reimplemented because it carries the
// per-row DELETE that the old /log route had. Rebuilding the table without it
// would have quietly removed the only way to correct a mis-logged trade.

import { useState } from 'react';

import { TradeLogPanel } from '@/components/TradeLogPanel';
import { OperatorSection, TabSwitch } from './OperatorSection';

export function HistoryOperator() {
  const [tab, setTab] = useState<'paper' | 'real'>('paper');

  return (
    <OperatorSection
      title="Trade log — editable"
      note="Deleting a row rewrites .data/trades.json through /api/trades/{id}. It changes every derived figure on this page and on Performance, and cannot be undone."
      action={<TabSwitch tab={tab} onChange={setTab} />}
    >
      <TradeLogPanel tab={tab} />
    </OperatorSection>
  );
}
