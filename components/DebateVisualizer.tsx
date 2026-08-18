'use client';

import { useAgentWebSocket } from '@/lib/useAgentWebSocket';
import { eventNumber, eventString } from '@/lib/agentEventStream';
import { useMemo } from 'react';

export function DebateVisualizer() {
  const { events } = useAgentWebSocket();
  
  // Most recent concluded debate.
  //
  // This filtered for 'SIGNAL_GENERATED', which NOTHING IN THE BACKEND
  // PUBLISHES. `SignalGeneratedEvent` is defined in models/events.py and no
  // agent emits it, so this panel could only ever show "Awaiting market
  // signals..." — permanently, with no error to explain why.
  //
  // DEBATE_CONCLUDED is both published (by the Debate agent) and the correct
  // event for a Bull-vs-Bear panel: it carries the winning direction, the
  // consensus confidence, and the actual rationale.
  const latestSignal = useMemo(() => {
    const debates = events.filter((e) => e.event_type === 'DEBATE_CONCLUDED');
    return debates.length > 0 ? debates[0] : null;
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

  // Field names come from DebateConcludedEvent, with the old SignalGenerated
  // names accepted as a fallback so either shape renders.
  const direction =
    eventString(latestSignal, 'winning_direction') ?? eventString(latestSignal, 'direction');
  const symbol = eventString(latestSignal, 'symbol') ?? '—';
  const price = eventNumber(latestSignal, 'price');
  const confidence =
    eventNumber(latestSignal, 'consensus_confidence') ?? eventNumber(latestSignal, 'confidence');
  const isBull = direction === 'LONG';

  // The agent's OWN rationale, or an explicit statement that none was supplied.
  //
  // This used to substitute invented text when the event carried no rationale:
  //
  //   // Create some simulated rationale if the agent didn't provide it
  //   const rationale = latestSignal.rationale || (isBull
  //     ? "EMA 9 crossed above EMA 21, indicating strong bullish momentum. ..."
  //     : "Price rejected at resistance, EMA crossover turning bearish. ...");
  //
  // So the panel whose entire purpose is to show WHY a decision was made
  // displayed fabricated reasoning, indistinguishable from the real thing — and
  // it cited specific indicators ("EMA 9 crossed above EMA 21") that may have
  // had nothing to do with the actual signal. An operator reviewing a trade
  // would have been reading fiction. CLAUDE.md invariant 6: if something isn't
  // available, say so rather than inventing a plausible value.
  const rationale =
    eventString(latestSignal, 'supervisor_rationale') ?? eventString(latestSignal, 'rationale');
  const strategy = eventString(latestSignal, 'strategy');

  return (
    <div className="glass-panel rounded-xl flex flex-col h-64 overflow-hidden relative group transition-all duration-500">
      <div className="px-4 py-3 border-b border-white/5 bg-bg1/40 flex justify-between items-center">
        <div className="font-semibold tracking-wide text-sm">Bull vs Bear Debate</div>
        <div className="text-xs font-mono px-2 py-1 bg-bg0 rounded text-txt1 border border-line">
          {symbol} @ {price !== null ? price.toFixed(2) : '---'}
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
              {rationale ?? (
                <span className="text-txt2 italic">
                  No rationale was supplied with this signal.
                  {strategy ? ` Strategy: ${strategy}.` : ''}
                </span>
              )}
            </div>
          )}
          {isBull && (
            <div className="mt-auto flex items-end gap-2">
              <div className="text-[10px] text-txt1 uppercase tracking-widest">Confidence</div>
              <div className="text-2xl font-mono text-green leading-none">{confidence !== null ? `${Math.round(confidence * 100)}%` : 'n/a'}</div>
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
              {rationale ?? (
                <span className="text-txt2 italic">
                  No rationale was supplied with this signal.
                  {strategy ? ` Strategy: ${strategy}.` : ''}
                </span>
              )}
            </div>
          )}
          {!isBull && (
            <div className="mt-auto flex items-end gap-2">
              <div className="text-[10px] text-txt1 uppercase tracking-widest">Confidence</div>
              <div className="text-2xl font-mono text-red leading-none">{confidence !== null ? `${Math.round(confidence * 100)}%` : 'n/a'}</div>
            </div>
          )}
          {/* Animated subtle background line */}
          {!isBull && <div className="absolute inset-0 border-l-2 border-red/30 pulse pointer-events-none" />}
        </div>
      </div>
    </div>
  );
}
