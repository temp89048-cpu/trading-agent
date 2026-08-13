import { useState, useEffect, useCallback } from 'react';

export interface AgentEvent {
  event_type: string;
  timestamp: string;
  agent_id: string;
  [key: string]: any;
}

export function useAgentOS() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // In production, we'd use environment variables for the WebSocket URL
    const ws = new WebSocket('ws://localhost:8000/api/ws/agent-events');

    ws.onopen = () => {
      setIsConnected(true);
      console.log('Connected to AgentOS WebSocket');
    };

    ws.onmessage = (event) => {
      try {
        const data: AgentEvent = JSON.parse(event.data);
        setEvents((prev) => {
          // Keep the last 100 events
          const newEvents = [data, ...prev];
          return newEvents.slice(0, 100);
        });
      } catch (e) {
        console.error('Error parsing WebSocket message', e);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      console.log('Disconnected from AgentOS WebSocket');
    };

    return () => {
      ws.close();
    };
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return { events, isConnected, clearEvents };
}
