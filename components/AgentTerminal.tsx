'use client';

import { useAgentOS } from '@/lib/useAgentOS';
import { useRef, useEffect } from 'react';

export function AgentTerminal() {
  const { events, isConnected, clearEvents } = useAgentOS();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const getEventColor = (type: string) => {
    switch (type) {
      case 'ORDER_FILLED': return 'text-green';
      case 'TAR_SUBMITTED': return 'text-amber';
      case 'TAR_APPROVED': return 'text-cyan';
      case 'TAR_REJECTED': return 'text-red';
      case 'PORTFOLIO_SYNC': return 'text-txt1';
      default: return 'text-txt2';
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <div className="flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: isConnected ? 'var(--green)' : 'var(--red)' }}
          />
          <span className={isConnected ? 'text-green' : 'text-red'}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <button onClick={clearEvents} className="text-txt2 hover:text-txt1 transition">
          Clear
        </button>
      </div>

      <div className="bg-bg0 border border-line rounded-md p-2 h-64 overflow-y-auto font-mono text-[10px] flex flex-col gap-1">
        {events.length === 0 ? (
          <div className="text-txt2 italic p-2 text-center h-full flex items-center justify-center">
            Listening for AgentOS events...
          </div>
        ) : (
          events.slice().reverse().map((ev, i) => (
            <div key={i} className="flex gap-2 hover:bg-bg2/50 px-1 py-0.5 rounded">
              <span className="text-txt2 shrink-0">
                {new Date(ev.timestamp).toLocaleTimeString([], { hour12: false })}
              </span>
              <div className="flex-1 min-w-0">
                <span className={`font-semibold mr-2 ${getEventColor(ev.event_type)}`}>
                  [{ev.event_type}]
                </span>
                <span className="text-txt1 break-all">
                  {ev.agent_id ? `<${ev.agent_id}> ` : ''}
                  {JSON.stringify(Object.fromEntries(
                    Object.entries(ev).filter(([k]) => !['event_type', 'timestamp', 'agent_id'].includes(k))
                  ))}
                </span>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
