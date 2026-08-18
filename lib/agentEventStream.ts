// ---------------------------------------------------------------------
// One shared WebSocket to the agent-event stream, for any number of consumers.
//
// THE BUG THIS FIXES
//
// There were two near-identical hooks — `lib/useAgentOS.ts` and
// `lib/useAgentWebSocket.ts` — and each opened its OWN WebSocket inside a
// `useEffect`. Five components use them (AgentTerminal, AgentActivityTerminal,
// DebateVisualizer, TradeHistoryTable, TradeLogPanel), so the app opened
// **five simultaneous connections** to the same endpoint, each maintaining a
// separate copy of the same event buffer.
//
// That is worse than wasteful. Each socket independently reconnects on drop, so
// a backend restart produced a reconnect storm; and because each buffer was
// filled independently, two panels could disagree about what had just happened,
// which is confusing in a UI whose job is to explain what the system did.
//
// This module keeps ONE connection at module scope, reference-counted by
// subscriber. The last consumer to unmount closes it.
//
// A RECONNECT BUG ALSO FIXED HERE
//
// The old `useAgentWebSocket` reconnected with `setTimeout(connect, 3000)` and,
// on unmount, set `ws.onclose = null` to prevent a reconnect. But a timer
// already scheduled was never cleared — so unmounting during the 3-second
// window still reconnected afterwards, to a socket nobody was listening to.
// The timer handle is tracked and cleared here.
// ---------------------------------------------------------------------

import { agentEventsWsUrl } from './backendConfig';

export type AgentStreamEvent = {
  event_type: string;
  timestamp?: string;
  agent_id?: string;
  agent?: string;
  [key: string]: unknown;
};

export type StreamState = {
  events: AgentStreamEvent[];
  isConnected: boolean;
};

const MAX_BUFFERED_EVENTS = 200;

// Backoff rather than a fixed 3s retry: a backend that is down stays down for a
// while, and five-per-second reconnect attempts from a browser tab achieve
// nothing except filling the console.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type Listener = (state: StreamState) => void;

let socket: WebSocket | null = null;
let listeners = new Set<Listener>();
let buffer: AgentStreamEvent[] = [];
let connected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

function snapshot(): StreamState {
  // A fresh array each time: handing out the internal buffer would let a
  // consumer mutate every other consumer's view of history.
  return { events: [...buffer], isConnected: connected };
}

function emit(): void {
  const state = snapshot();
  listeners.forEach((fn) => fn(state));
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  clearReconnectTimer();
  // No consumers left — do not reconnect. Without this check a drop that
  // coincides with the last unmount would reopen a socket nobody reads.
  if (listeners.size === 0) return;

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function openSocket(): void {
  // Guard against opening a second socket: `useEffect` runs twice per mount
  // under React 18 Strict Mode, which is exactly how a "shared" connection
  // quietly becomes two.
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (typeof window === 'undefined') return; // no sockets during SSR

  let ws: WebSocket;
  try {
    ws = new WebSocket(agentEventsWsUrl());
  } catch {
    // Constructor throws on a malformed URL. Treated as a failed connection so
    // the backoff applies rather than the stream silently never starting.
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    connected = true;
    reconnectAttempts = 0; // reset backoff only after a real connection
    emit();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as AgentStreamEvent;
      // Newest first, matching what both old hooks did.
      buffer = [data, ...buffer].slice(0, MAX_BUFFERED_EVENTS);
      emit();
    } catch {
      // A malformed frame is dropped rather than throwing inside the handler,
      // which would tear down the socket for every consumer.
    }
  };

  ws.onclose = () => {
    connected = false;
    socket = null;
    emit();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // `onclose` always follows `onerror`, so reconnection is handled there.
    // Closing here would double-fire it.
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };
}

/** Subscribe to the shared stream. Returns an unsubscribe function. */
export function subscribeToAgentEvents(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot()); // deliver current state immediately
  openSocket();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearReconnectTimer();
      reconnectAttempts = 0;
      if (socket) {
        // Detach the handler first so closing doesn't schedule a reconnect.
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      connected = false;
    }
  };
}

/** Clear the shared buffer. Affects every consumer, which is intended —
 *  there is one history, not one per panel. */
export function clearAgentEvents(): void {
  buffer = [];
  emit();
}

// ---------------------------------------------------------------------
// Safe field accessors.
//
// Events arrive as JSON from the bus, so every field beyond `event_type` is
// genuinely optional — `backend/api/dashboard.py::_event_to_dict` only includes
// `timestamp` when the event carries one, and different event types carry
// different payloads. The old hooks typed the payload as
// `[key: string]: any` and `timestamp: string`, which compiled fine and then
// produced `new Date(undefined)` → "Invalid Date" in the UI, and
// `confidence.toFixed()` → TypeError when the field was absent.
// ---------------------------------------------------------------------

/** Local time string for an event, or a placeholder when it carries no timestamp. */
export function eventTimeLabel(event: AgentStreamEvent): string {
  const raw = event.timestamp;
  if (typeof raw !== 'string' && typeof raw !== 'number') return '--:--:--';
  const date = new Date(raw);
  // An unparseable timestamp yields NaN. Showing "--:--:--" is honest; showing
  // "Invalid Date" looks like a rendering fault rather than missing data.
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString([], { hour12: false });
}

/** Epoch ms for an event, or null when it has no usable timestamp. */
export function eventTimeMs(event: AgentStreamEvent): number | null {
  const raw = event.timestamp;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** A numeric field, or null. Never coerces a missing field to 0 — a confidence
 *  of 0 and an unknown confidence are different facts. */
export function eventNumber(event: AgentStreamEvent, key: string): number | null {
  const value = event[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A string field, or null. */
export function eventString(event: AgentStreamEvent, key: string): string | null {
  const value = event[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Test/debug helper: how many sockets are open (0 or 1, never more). */
export function _activeSocketCount(): number {
  return socket ? 1 : 0;
}

export function _listenerCount(): number {
  return listeners.size;
}
