'use client';

import { useAgentWebSocket } from '@/lib/useAgentWebSocket';
import { useRef, useEffect } from 'react';

export function AgentActivityTerminal() {
  const { events, isConnected } = useAgentWebSocket();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events]);

  const getEventStyle = (type: string) => {
    switch (type) {
      case 'ORDER_FILLED': return 'text-green border-green/20 bg-green/10';
      case 'ORDER_ROUTED': return 'text-cyan border-cyan/20 bg-cyan/10';
      case 'SIGNAL_GENERATED': return 'text-amber border-amber/20 bg-amber/10';
      case 'TAR_APPROVED': return 'text-cyan border-cyan/20 bg-cyan/10';
      case 'TAR_REJECTED': return 'text-red border-red/20 bg-red/10';
      case 'FEATURES_COMPUTED': return 'text-txt1 border-line bg-bg1/50';
      case 'TICK_RECEIVED': return 'text-txt2 border-transparent hover:bg-bg1/30';
      default: return 'text-txt1 border-line bg-bg1/50';
    }
  };

  return (
    <div className="glass-panel rounded-xl flex flex-col h-full overflow-hidden flex-1 min-h-[300px]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-bg1/40">
        <div className="flex items-center gap-2">
          <div className="font-semibold tracking-wide text-sm">Live Agent Activity</div>
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-bg0/50 border border-white/5">
            <span
              className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green pulse' : 'bg-red'}`}
            />
            <span className="text-[10px] uppercase font-mono text-txt1 tracking-widest">
              {isConnected ? 'OS Active' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] space-y-2 flex flex-col custom-scrollbar">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-txt2/50 italic">
            Awaiting kernel events...
          </div>
        ) : (
          events.slice().reverse().map((ev, i) => (
            <div 
              key={i} 
              className={`p-2 rounded-lg border transition-all duration-300 rise ${getEventStyle(ev.event_type)}`}
            >
              <div className="flex gap-3">
                <span className="opacity-50 shrink-0 mt-0.5">
                  {new Date(ev.timestamp).toISOString().split('T')[1].slice(0, -1)}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="font-bold mr-2 opacity-90 tracking-wider">
                    [{ev.event_type}]
                  </span>
                  <span className="break-all opacity-80 leading-relaxed">
                    {ev.agent ? `<${ev.agent}> ` : ''}
                    {JSON.stringify(
                      Object.fromEntries(
                        Object.entries(ev).filter(([k]) => !['event_type', 'timestamp', 'agent'].includes(k))
                      )
                    )}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} className="h-2" />
      </div>
    </div>
  );
}
