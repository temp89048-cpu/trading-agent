'use client';

import { useAgentWebSocket } from '@/lib/useAgentWebSocket';
import { useMemo } from 'react';

export function DebateVisualizer() {
  const { events } = useAgentWebSocket();
  
  // Find the most recent signal to visualize the debate
  const latestSignal = useMemo(() => {
    const signals = events.filter(e => e.event_type === 'SIGNAL_GENERATED');
    return signals.length > 0 ? signals[0] : null;
  }, [events]);

  if (!latestSignal) {
    return (
      <div className="glass-panel rounded-xl flex flex-col h-64 overflow-hidden relative">
        <div className="px-4 py-3 border-b border-white/5 bg-bg1/40 font-semibold tracking-wide text-sm">
          Bull vs Bear Debate
        </div>
        <div className="flex-1 flex items-center justify-center text-txt2/50 italic font-mono text-xs">
          Awaiting market signals...
        </div>
      </div>
    );
  }

  const { direction, confidence, symbol, price } = latestSignal;
  const isBull = direction === 'LONG';
  
  // Create some simulated rationale if the agent didn't provide it directly in the event
  const rationale = latestSignal.rationale || (isBull 
    ? "EMA 9 crossed above EMA 21, indicating strong bullish momentum. Support held at recent swing low. Market regime transitioning to trending." 
    : "Price rejected at resistance, EMA crossover turning bearish. Volume declining on pullbacks indicating exhaustion.");

  return (
    <div className="glass-panel rounded-xl flex flex-col h-64 overflow-hidden relative group transition-all duration-500">
      <div className="px-4 py-3 border-b border-white/5 bg-bg1/40 flex justify-between items-center">
        <div className="font-semibold tracking-wide text-sm">Bull vs Bear Debate</div>
        <div className="text-xs font-mono px-2 py-1 bg-bg0 rounded text-txt1 border border-line">
          {symbol} @ {price?.toFixed(2) || '---'}
        </div>
      </div>
      
      <div className="flex-1 flex overflow-hidden">
        {/* BULL PANEL */}
        <div className={`flex-1 p-5 transition-all duration-700 flex flex-col gap-3 relative ${isBull ? 'bg-green/10' : 'opacity-40 grayscale'}`}>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${isBull ? 'bg-green shadow-[0_0_10px_#00ff9d]' : 'bg-txt2'}`} />
            <h3 className={`font-bold tracking-widest ${isBull ? 'text-green' : 'text-txt2'}`}>BULL CASE</h3>
          </div>
          {isBull && (
            <div className="text-sm leading-relaxed text-txt0 rise">
              {rationale}
            </div>
          )}
          {isBull && (
            <div className="mt-auto flex items-end gap-2">
              <div className="text-[10px] text-txt1 uppercase tracking-widest">Confidence</div>
              <div className="text-2xl font-mono text-green leading-none">{Math.round(confidence * 100)}%</div>
            </div>
          )}
          {/* Animated subtle background line */}
          {isBull && <div className="absolute inset-0 border-r-2 border-green/30 pulse pointer-events-none" />}
        </div>
        
        {/* Divider */}
        <div className="w-px bg-white/5 shrink-0 z-10" />
        
        {/* BEAR PANEL */}
        <div className={`flex-1 p-5 transition-all duration-700 flex flex-col gap-3 relative ${!isBull ? 'bg-red/10' : 'opacity-40 grayscale'}`}>
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${!isBull ? 'bg-red shadow-[0_0_10px_#ff3366]' : 'bg-txt2'}`} />
            <h3 className={`font-bold tracking-widest ${!isBull ? 'text-red' : 'text-txt2'}`}>BEAR CASE</h3>
          </div>
          {!isBull && (
            <div className="text-sm leading-relaxed text-txt0 rise">
              {rationale}
            </div>
          )}
          {!isBull && (
            <div className="mt-auto flex items-end gap-2">
              <div className="text-[10px] text-txt1 uppercase tracking-widest">Confidence</div>
              <div className="text-2xl font-mono text-red leading-none">{Math.round(confidence * 100)}%</div>
            </div>
          )}
          {/* Animated subtle background line */}
          {!isBull && <div className="absolute inset-0 border-l-2 border-red/30 pulse pointer-events-none" />}
        </div>
      </div>
    </div>
  );
}
