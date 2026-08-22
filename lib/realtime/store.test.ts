// The event router is the piece between the shared socket and every component,
// so a bug here is a bug on every page at once.
//
// `route()` is exported as a pure function specifically so it can be tested against
// recorded payload shapes without a socket, a DOM, or a running backend.

import { describe, expect, it } from 'vitest';

import { NODE_LEVEL_ONLY, type RealtimeState, route } from './store';

const EMPTY: RealtimeState = {
  connected: false,
  events: [],
  nodes: {},
  currentNode: null,
  prices: {},
  triggers: [],
  lastDecision: {},
  lastEventAt: null,
};

const at = '2026-08-21T10:00:00.000Z';

describe('event router', () => {
  it('folds a tick into the price slice', () => {
    const s = route(EMPTY, { event_type: 'TICK_RECEIVED', symbol: 'BTC/USDT', price: 61234.5, timestamp: at });
    expect(s.prices['BTC/USDT']).toBe(61234.5);
    expect(s.events).toHaveLength(1);
  });

  it('ignores a tick with no usable price rather than storing zero', () => {
    // A missing price is not a price of 0. Storing 0 would render as a real quote.
    const s = route(EMPTY, { event_type: 'TICK_RECEIVED', symbol: 'BTC/USDT', timestamp: at });
    expect(s.prices['BTC/USDT']).toBeUndefined();
  });

  it('tracks the running node and clears it on completion', () => {
    let s = route(EMPTY, { event_type: 'GRAPH_NODE_STARTED', node: 'specialist_market', timestamp: at });
    expect(s.currentNode).toBe('specialist_market');
    expect(s.nodes.specialist_market.status).toBe('RUNNING');

    s = route(s, { event_type: 'GRAPH_NODE_COMPLETED', node: 'specialist_market', duration_ms: 82, timestamp: at });
    expect(s.currentNode).toBeNull();
    expect(s.nodes.specialist_market.status).toBe('COMPLETED');
    expect(s.nodes.specialist_market.durationMs).toBe(82);
  });

  it('reports a missing duration as null, not zero', () => {
    // `0ms` is a claim about how long a node took. `null` is the absence of one, and
    // the whole system is built on keeping those apart.
    const s = route(EMPTY, { event_type: 'GRAPH_NODE_COMPLETED', node: 'debate', timestamp: at });
    expect(s.nodes.debate.durationMs).toBeNull();
  });

  it('does not clear currentNode when a DIFFERENT node completes', () => {
    // Two nodes run in one superstep in the fan-out. Completing one must not blank
    // the edge animation for the other, which was the first shape of this reducer.
    let s = route(EMPTY, { event_type: 'GRAPH_NODE_STARTED', node: 'specialist_risk', timestamp: at });
    s = route(s, { event_type: 'GRAPH_NODE_COMPLETED', node: 'specialist_market', timestamp: at });
    expect(s.currentNode).toBe('specialist_risk');
  });

  it('marks a failed node FAILED', () => {
    const s = route(EMPTY, { event_type: 'GRAPH_NODE_FAILED', node: 'supervisor', timestamp: at });
    expect(s.nodes.supervisor.status).toBe('FAILED');
  });

  it('records a suppressed trigger as suppressed rather than dropping it', () => {
    // "We detected it and chose not to act" and "we never detected it" are different
    // facts, and only one is a bug. The trigger layer publishes both for exactly this
    // reason, so the UI must be able to tell them apart.
    const s = route(EMPTY, {
      event_type: 'TRIGGER_FIRED',
      symbol: 'BTC/USDT',
      kind: 'prediction_market_shift',
      detail: 'X:YES repriced +0.100',
      acted: false,
      suppressed_reason: 'debounced',
      timestamp: at,
    });
    expect(s.triggers).toHaveLength(1);
    expect(s.triggers[0].acted).toBe(false);
    expect(s.triggers[0].suppressedReason).toBe('debounced');
  });

  it('treats a trigger with no acted field as acted', () => {
    // Matching the backend, where a suppression always carries acted:false plus a
    // reason. Defaulting the other way would show every trigger as suppressed.
    const s = route(EMPTY, { event_type: 'TRIGGER_FIRED', symbol: 'ETH/USDT', kind: 'price_move', timestamp: at });
    expect(s.triggers[0].acted).toBe(true);
  });

  it('caps the trigger list', () => {
    let s = EMPTY;
    for (let i = 0; i < 250; i += 1) {
      s = route(s, { event_type: 'TRIGGER_FIRED', symbol: 'BTC/USDT', kind: 'price_move', timestamp: at });
    }
    expect(s.triggers.length).toBeLessThanOrEqual(100);
  });

  it('caps the raw event buffer', () => {
    let s = EMPTY;
    for (let i = 0; i < 400; i += 1) {
      s = route(s, { event_type: 'SOMETHING', timestamp: at });
    }
    expect(s.events.length).toBeLessThanOrEqual(200);
  });

  it('keeps an unrecognised event in the feed instead of discarding it', () => {
    // A new backend event type should be visible-but-unstyled, not invisible.
    const s = route(EMPTY, { event_type: 'BRAND_NEW_EVENT', timestamp: at });
    expect(s.events).toHaveLength(1);
    expect(s.events[0].event_type).toBe('BRAND_NEW_EVENT');
  });

  it('records the last decision per symbol', () => {
    let s = route(EMPTY, { event_type: 'DECISION_MADE', symbol: 'BTC/USDT', action: 'WAIT', detail: 'below floor', timestamp: at });
    expect(s.lastDecision['BTC/USDT'].action).toBe('WAIT');
    s = route(s, { event_type: 'TAR_REJECTED', symbol: 'BTC/USDT', reason: 'risk', timestamp: at });
    expect(s.lastDecision['BTC/USDT'].action).toBe('TAR_REJECTED');
  });

  it('returns the same slice object when an event does not touch it', () => {
    // This is what makes a price tick not re-render the flow diagram:
    // `useRealtimeSelector` compares by reference, so an untouched slice must keep
    // its identity. A reducer that rebuilt every slice each event would make the
    // selector equality check useless and re-render the whole app on every tick.
    const base = route(EMPTY, { event_type: 'GRAPH_NODE_STARTED', node: 'debate', timestamp: at });
    const next = route(base, { event_type: 'TICK_RECEIVED', symbol: 'BTC/USDT', price: 1, timestamp: at });
    expect(next.nodes).toBe(base.nodes);
    expect(next.triggers).toBe(base.triggers);
    expect(next.lastDecision).toBe(base.lastDecision);
  });

  it('advances lastEventAt', () => {
    const s = route(EMPTY, { event_type: 'X', timestamp: at });
    expect(s.lastEventAt).toBe(Date.parse(at));
  });
});

describe('honesty declarations', () => {
  it('states that the stream is node-level only', () => {
    // The brief: if the backend does not emit granular per-action events, say so
    // explicitly rather than fabricating a plausible log. This constant is that
    // statement, rendered in the Live Console, so it is asserted rather than left
    // as a comment someone could delete.
    expect(NODE_LEVEL_ONLY).toMatch(/node-level/i);
    expect(NODE_LEVEL_ONLY).toMatch(/not a simulated feed/i);
  });
});
