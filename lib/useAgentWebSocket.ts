import { useEffect, useState } from 'react';

import {
  type AgentStreamEvent,
  subscribeToAgentEvents,
} from './agentEventStream';

export type AgentEvent = AgentStreamEvent;

/**
 * Agent-event stream.
 *
 * Now a thin wrapper over the SHARED connection in `lib/agentEventStream.ts`.
 * It previously opened its own WebSocket per call site; three components use
 * this hook and two use `useAgentOS`, so the app held five sockets to one
 * endpoint. See that module's header for the reconnect-timer bug that came with
 * the old implementation.
 *
 * The return shape is unchanged so existing consumers need no edits.
 *
 * The `url` parameter is gone: it was defaulted to a path nothing serves
 * (`/api/ws/agent-events`), and a per-call-site URL is incompatible with one
 * shared connection. The endpoint now comes from `lib/backendConfig.ts`, which
 * derives ws/wss from the configured backend origin.
 */
export function useAgentWebSocket() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    return subscribeToAgentEvents((state) => {
      setEvents(state.events);
      setIsConnected(state.isConnected);
    });
  }, []);

  const getEventsByType = (type: string) => events.filter((e) => e.event_type === type);

  return {
    events,
    isConnected,
    getEventsByType,
    latestEvent: events.length > 0 ? events[0] : null,
  };
}
