'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { BacktestPanel } from '@/components/BacktestPanel';
import { OptimizerPanel } from '@/components/OptimizerPanel';

export default function BacktestPage() {
  const router = useRouter();
  const [tab, setTab] = useState<'backtest' | 'optimize'>('backtest');

  return (
    <div className="min-h-screen bg-bg0 text-txt0">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-line bg-bg1 sticky top-0 z-10">
        <button onClick={() => router.push('/')} className="p-1.5 rounded-md hover:bg-bg3 transition text-txt1" title="Back to terminal">
          <Icon name="x" size={18} />
        </button>
        <span className="font-mono text-sm font-semibold">Backtest Lab</span>
        <div className="flex-1" />
        <div className="flex gap-1 text-[11px] font-mono">
          <button onClick={() => setTab('backtest')} className={`tabbtn ${tab === 'backtest' ? 'bg-bg3 text-amber' : 'text-txt2'}`}>
            Backtest
          </button>
          <button onClick={() => setTab('optimize')} className={`tabbtn ${tab === 'optimize' ? 'bg-bg3 text-amber' : 'text-txt2'}`}>
            Optimizer
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        {tab === 'backtest' ? <BacktestPanel /> : <OptimizerPanel />}
      </main>
    </div>
  );
}
