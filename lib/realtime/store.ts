// ---------------------------------------------------------------------
// Event Router + Global Store — the missing middle of the Phase 5 architecture:
//
//     Realtime Connection  ->  Event Router  ->  Global Store  ->  components
//     (already exists)         (this file)       (this file)
//
// WHAT ALREADY EXISTED, AND WHY THIS DOES NOT REPLACE IT
//
// `lib/agentEventStream.ts` is already the shared connection the brief asks for:
// ONE module-scope WebSocket, reference-counted by subscriber, closed by the last
// unsubscribe. Its header records the two bugs it exists to prevent — five
// components each opening their own socket, and a reconnect timer that fired
// after unmount. None of that is rebuilt here.
//
// What was missing is everything after the socket. Consumers each re-scanned the
// raw 200-event buffer and applied their own filters, so:
//
//   * every component re-derived the same state on every event, and
//   * two panels could disagree about the current node, because each kept its
//     own idea of which events mattered.
//
// This module subscribes ONCE, routes each event into typed slices, and lets
// components select a slice. Adding a page costs a selector, not another scan.
//
// SUBSCRIPTION LIFECYCLE
//
// `subscribe()` returns an unsubscribe function and the LAST unsubscribe releases
// the underlying socket subscription. That is the pattern the reference's
// `clearInterval` on `closeLiveInspector()` establishes and the brief asks to
// preserve: a modal attaches to the existing stream, filtered, and detaches
// cleanly on unmount rather than opening its own connection.
// ---------------------------------------------------------------------

import {
  type AgentStreamEvent,
  subscribeToAgentEvents,
} from '../agentEventStream';

/* ===================================================================== */
/* Slices                                                                */
/* ===================================================================== */

export type NodeStatus = 'COMPLETED' | 'RUNNING' | 'WAITING' | 'IDLE' | 'SKIPPED' | 'FAILED';

export type GraphNodeState = {
  name: string;
  status: NodeStatus;
  /** Wall-clock ms the node took, when the event carried it. `null` = the event
   *  did not report a duration — NOT zero. */
  durationMs: number | null;
  detail: string | null;
  at: number;
};

export type TriggerEventState = {
  symbol: string;
  kind: string;
  detail: string;
  /** False means detected-and-deliberately-suppressed. Surfaced because "we saw
   *  it and chose not to act" and "we never saw it" are different facts and only
   *  one is a bug — the trigger layer publishes both for exactly this reason. */
  acted: boolean;
  suppressedReason: string | null;
  at: number;
};

export type RealtimeState = {
  connected: boolean;
  /** Raw tail, for the timeline and log views. */
  events: AgentStreamEvent[];
  /** Node name -> latest known state, for the flow diagram. */
  nodes: Record<string, GraphNodeState>;
  /** The node currently RUNNING, which is what drives the flowing-dot edge.
   *  `null` when nothing is running — the reference animates on a guessed
   *  "active" state; this is the real one. */
  currentNode: string | null;
  /** Symbol -> last tick price seen on the stream. */
  prices: Record<string, number>;
  triggers: TriggerEventState[];
  /** Symbol -> the most recent decision the stream reported. */
  lastDecision: Record<string, { action: string; detail: string; at: number }>;
  lastEventAt: number | null;
};

const MAX_TRIGGERS = 100;

const initial: RealtimeState = {
  connected: false,
  events: [],
  nodes: {},
  currentNode: null,
  prices: {},
  triggers: [],
  lastDecision: {},
  lastEventAt: null,
};

let state: RealtimeState = initial;

type Listener = (s: RealtimeState) => void;
const listeners = new Set<Listener>();
let releaseUpstream: (() => void) | null = null;

/* ===================================================================== */
/* Router                                                                */
/* ===================================================================== */

function str(e: AgentStreamEvent, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function num(e: AgentStreamEvent, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function eventTime(e: AgentStreamEvent): number {
  if (typeof e.timestamp === 'string') {
    const t = Date.parse(e.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

const NODE_STATUSES = new Set<string>(['COMPLETED', 'RUNNING', 'WAITING', 'IDLE', 'SKIPPED', 'FAILED']);

/** Fold one event into the slices. Pure apart from reading `Date.now()` via
 *  `eventTime`, so it is unit-testable against recorded payloads. */
export function route(prev: RealtimeState, e: AgentStreamEvent): RealtimeState {
  const type = String(e.event_type ?? '').toUpperCase();
  const at = eventTime(e);

  const next: RealtimeState = {
    ...prev,
    events: [...prev.events.slice(-199), e],
    lastEventAt: at,
  };

  switch (type) {
    case 'TICK_RECEIVED': {
      const symbol = str(e, 'symbol');
      const price = num(e, 'price');
      if (symbol && price !== null) next.prices = { ...prev.prices, [symbol]: price };
      break;
    }

    case 'TRIGGER_FIRED': {
      const symbol = str(e, 'symbol');
      if (symbol) {
        const entry: TriggerEventState = {
          symbol,
          kind: str(e, 'kind') ?? 'unknown',
          detail: str(e, 'detail') ?? '',
          // Explicitly `!== false`: a payload missing the field is treated as
          // acted, matching the backend, where a suppression always carries
          // `acted: false` plus a reason.
          acted: e.acted !== false,
          suppressedReason: str(e, 'suppressed_reason', 'suppressedReason'),
          at,
        };
        next.triggers = [...prev.triggers, entry].slice(-MAX_TRIGGERS);
      }
      break;
    }

    // Node-level graph progress. This is the real granularity the backend
    // emits — see `NODE_LEVEL_ONLY` below for why the Live Console cannot be
    // finer than this without fabricating.
    case 'GRAPH_NODE_STARTED':
    case 'GRAPH_NODE_COMPLETED':
    case 'GRAPH_NODE_FAILED': {
      const name = str(e, 'node', 'node_name', 'name');
      if (name) {
        const explicit = str(e, 'status')?.toUpperCase();
        const status: NodeStatus =
          explicit && NODE_STATUSES.has(explicit)
            ? (explicit as NodeStatus)
            : type === 'GRAPH_NODE_STARTED'
              ? 'RUNNING'
              : type === 'GRAPH_NODE_FAILED'
                ? 'FAILED'
                : 'COMPLETED';

        next.nodes = {
          ...prev.nodes,
          [name]: {
            name,
            status,
            durationMs: num(e, 'duration_ms', 'durationMs'),
            detail: str(e, 'detail', 'summary', 'out'),
            at,
          },
        };
        next.currentNode = status === 'RUNNING' ? name : prev.currentNode === name ? null : prev.currentNode;
      }
      break;
    }

    case 'DECISION_MADE':
    case 'TAR_SUBMITTED':
    case 'TAR_APPROVED':
    case 'TAR_REJECTED': {
      const symbol = str(e, 'symbol');
      if (symbol) {
        next.lastDecision = {
          ...prev.lastDecision,
          [symbol]: {
            action: str(e, 'action', 'decision') ?? type,
            detail: str(e, 'detail', 'rationale', 'reason') ?? '',
            at,
          },
        };
      }
      break;
    }

    default:
      // Unrecognised events still land in `events` so the timeline and log
      // views show them. Silently dropping them would make a new backend event
      // type invisible rather than merely unstyled.
      break;
  }

  return next;
}

/* ===================================================================== */
/* Store                                                                 */
/* ===================================================================== */

let seenCount = 0;

function attach() {
  if (releaseUpstream) return;
  releaseUpstream = subscribeToAgentEvents((upstream) => {
    // The upstream buffer is a rolling window, not a delta feed, so only the
    // events beyond what has already been routed are folded in. Re-routing the
    // whole buffer on every message would re-apply each event O(n) times and
    // duplicate every trigger in the list.
    const fresh = upstream.events.slice(seenCount);
    seenCount = upstream.events.length;

    let nextState = state;
    if (upstream.isConnected !== state.connected) {
      nextState = { ...nextState, connected: upstream.isConnected };
    }
    for (const e of fresh) nextState = route(nextState, e);

    if (nextState !== state) {
      state = nextState;
      for (const l of listeners) l(state);
    }
  });
}

function detach() {
  releaseUpstream?.();
  releaseUpstream = null;
  seenCount = 0;
}

/** Subscribe to the routed store. Returns an unsubscribe function.
 *
 *  The last unsubscribe releases the upstream socket subscription, so a modal
 *  that attaches and detaches does not leave a connection open — the lifecycle
 *  the brief asks to preserve. */
export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  attach();
  listener(state);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

export function realtimeSnapshot(): RealtimeState {
  return state;
}

/** Test-only reset. Not called in production. */
export function _resetRealtimeStore(): void {
  state = initial;
  seenCount = 0;
  listeners.clear();
  detach();
}

/* ===================================================================== */
/* Honesty declaration                                                   */
/* ===================================================================== */

/** The backend emits NODE-level graph events, not per-action ones.
 *
 *  The reference's Live Agent Console streams lines like "Scoring headline
 *  relevance and sentiment against ETHUSDT exposure" every 1.5 seconds from a
 *  14-template array. There is no backend event stream at that granularity —
 *  `graphs/runtime.stream_run` yields one message per NODE, carrying
 *  `{node, progress, total, wroteKeys, unavailableCount, errorCount}`.
 *
 *  The brief is explicit about this case: *"If the backend does not emit
 *  granular per-action events (only coarse node-level events), say so explicitly
 *  in the deliverables report — do not fabricate a plausible-looking log."*
 *
 *  So the console renders real node transitions and is labelled with this
 *  string. It will look calmer than the mockup, and that is the honest result.
 */
export const NODE_LEVEL_ONLY =
  'node-level events only — the backend emits one event per graph node, not per ' +
  'individual agent action. Lines below are real node transitions, not a simulated feed.';
