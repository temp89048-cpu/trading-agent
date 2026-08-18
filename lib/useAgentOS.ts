import { useEffect, useState } from 'react';

import {
  type AgentStreamEvent,
  clearAgentEvents,
  subscribeToAgentEvents,
} from './agentEventStream';

export type AgentEvent = AgentStreamEvent;

/**
 * Agent-event stream (same data as `useAgentWebSocket`, different return shape).
 *
 * Both hooks now read the SAME shared connection from
 * `lib/agentEventStream.ts`. Previously each opened its own WebSocket, so the
 * five components between them held five sockets to one endpoint — and each
 * buffered events independently, meaning two panels could disagree about what
 * had just happened.
 *
 * This version also gains reconnection, which it did not have: the old
 * implementation opened a socket in a `useEffect` and, if it dropped, simply
 * stopped receiving events with no retry and no visible error.
 *
 * `clearEvents` clears the shared buffer, so it affects every panel. That is
 * intended — there is one event history, not one per panel.
 */
export function useAgentOS() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    return subscribeToAgentEvents((state) => {
      setEvents(state.events);
      setIsConnected(state.isConnected);
    });
  }, []);

  return {
    events,
    isConnected,
    clearEvents: clearAgentEvents,
  };
}
