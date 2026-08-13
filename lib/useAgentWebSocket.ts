import { useEffect, useState, useCallback, useRef } from 'react';

export type AgentEvent = {
  event_type: string;
  agent: string;
  timestamp: string;
  [key: string]: any;
};

export function useAgentWebSocket(url: string = 'ws://127.0.0.1:8000/api/ws/agent-events') {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to AgentOS WebSocket');
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as AgentEvent;
        // Prepend new events so the newest is at index 0
        setEvents((prev) => [data, ...prev].slice(0, 100)); // Keep last 100
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from AgentOS WebSocket. Reconnecting in 3s...');
      setIsConnected(false);
      setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      ws.close();
    };
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on unmount
        wsRef.current.close();
      }
    };
  }, [connect]);

  // A helper to filter events easily
  const getEventsByType = (type: string) => events.filter(e => e.event_type === type);

  return {
    events,
    isConnected,
    getEventsByType,
    latestEvent: events.length > 0 ? events[0] : null
  };
}
