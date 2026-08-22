// ---------------------------------------------------------------------
// Where the FastAPI backend lives, and which paths it actually serves.
//
// WHY THIS FILE EXISTS
//
// Six components had `http://localhost:8000` (or `http://127.0.0.1:8000`)
// hardcoded, with two different spellings of localhost between them. That
// breaks in any deployment that isn't the developer's own machine, and it made
// the next problem invisible: several of those URLs pointed at paths the
// FastAPI backend does not serve.
//
// The mismatches, all of which returned 404:
//
//   frontend called                      FastAPI actually serves
//   ---------------------------------    -----------------------------------
//   /api/health                          /api/monitoring
//   /api/trades                          /api/execution
//   /api/ws/agent-events   (WebSocket)   /api/dashboard/agent-events
//
// The first two are subtle rather than obvious typos: `/api/health` and
// `/api/trades` are real routes — of the NEXT.JS app, at its own origin. So the
// components were using Next route names against the FastAPI host. Both servers
// existed, both had a route by that name in one of them, and the request 404'd.
//
// WHICH SERVER OWNS WHAT
//
// Next.js route handlers under `app/api/` read the JSON stores in `.data/` and
// work with no external dependency. The FastAPI equivalents read Postgres.
// Since Postgres is not required to run this app, anything the Next.js layer
// already serves is fetched from the SAME ORIGIN with a relative URL — no host,
// no CORS, no config. Only capabilities that exist *solely* in FastAPI (today:
// the agent-event WebSocket) go to BACKEND_BASE.
// ---------------------------------------------------------------------

/** FastAPI origin. Override with NEXT_PUBLIC_BACKEND_URL at build time. */
export const BACKEND_BASE =
  process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || 'http://localhost:8000';

/**
 * WebSocket URL for the agent-event stream.
 *
 * Derived from BACKEND_BASE rather than written out separately, so the host can
 * never drift between the HTTP and WS config — and http/https is mapped to
 * ws/wss so an https deployment doesn't try to open an insecure socket, which
 * browsers block outright.
 */
export function agentEventsWsUrl(): string {
  const base = BACKEND_BASE.replace(/^http/, 'ws');
  // The real path. It is `/api/dashboard/agent-events` because the WebSocket is
  // declared in `backend/api/dashboard.py` and that router is mounted at
  // `/api/dashboard`. It was previously written as `/api/ws/agent-events`,
  // which nothing serves.
  return `${base}/api/dashboard/agent-events`;
}

/** Paths on the FastAPI backend, so a rename is a one-line change here. */
export const BACKEND_PATHS = {
  monitoring: '/api/monitoring',
  trades: '/api/execution',
  auditLog: '/api/execution/audit',
  dashboard: '/api/dashboard',
  adminStatus: '/api/admin/status',
  pause: '/api/admin/pause',
  resume: '/api/admin/resume',
  emergencyStop: '/api/admin/emergency-stop',
  agents: '/api/ai/agents',
  researchQueue: '/api/research/queue',

  // --- The LangGraph reasoning layer (spec Section 39.5) -------------------
  //
  // These exist ONLY on FastAPI. Everything above has a Next.js equivalent
  // reading `.data/`, but the seven graphs run in the Python process and their
  // traces, node contracts and decisions have no JSON-store mirror — so unlike
  // the rest of this table, these genuinely require the backend to be running.
  //
  // Before these existed, the reasoning layer was computed, traced to disk and
  // completely unreachable from the dashboard: layers 1-3 of the recommended
  // stack were connected and layer 4 had no API surface at all.
  graphs: '/api/graphs',
  graphNodes: '/api/graphs/nodes',
  graphRuns: '/api/graphs/runs',
  graphPositions: '/api/graphs/positions',
  metaLearning: '/api/graphs/meta-learning',

  // --- Polymarket prediction-market feed (Phase 37) -----------------------
  //
  // FastAPI only, for the same reason as the graph paths above: the poller runs in
  // the Python process and its stores have no `.data/` mirror the Next.js layer
  // reads.
  //
  // `polymarketConfirm` is the human gate. `polymarket_store.confirm_mapping`
  // refuses to mark a mapping confirmed without `set_by_human=True`, and that route
  // is the only place in the codebase that passes it — so this path is what makes an
  // otherwise unreachable safety check actually usable.
  polymarket: '/api/polymarket',
  polymarketSignals: '/api/polymarket/signals',
  polymarketMappings: '/api/polymarket/mappings',
  polymarketConfirm: '/api/polymarket/mappings/confirm',
  polymarketSnapshots: '/api/polymarket/snapshots',
  polymarketSeries: '/api/polymarket/series',

  // --- Catalog: the three read-only views added to unblock BLOCKED routes ----
  //
  // Each exposes data that was already in the Python process with no route to it.
  // All read-only; see backend/api/catalog.py for what each honestly is NOT.
  catalog: '/api/catalog',
  catalogOrders: '/api/catalog/orders',
  catalogStrategies: '/api/catalog/strategies',
  catalogReplay: '/api/catalog/replay',

  // --- Everything else the new routes read -----------------------------------
  portfolio: '/api/dashboard/portfolio',
  exchangeStatus: '/api/exchange/status',
  marketPrices: '/api/market/prices',
  memoryStats: '/api/memory/stats',
  memoryReport: '/api/memory/report',
  memoryMistakes: '/api/memory/mistakes',
  researchDashboard: '/api/research/dashboard',
  executionAudit: '/api/execution/audit',
} as const;

/**
 * WebSocket URL for live node-by-node graph progress (spec Section 39.5).
 *
 * Derived from BACKEND_BASE for the same reason `agentEventsWsUrl` is: the host
 * cannot drift between HTTP and WS, and http/https maps to ws/wss so an https
 * deployment does not open an insecure socket that browsers block outright.
 *
 * Send `{ symbol }` after opening. Each message is one NODE, carrying counts
 * rather than the state itself — the state holds candles, seven specialist
 * findings and a portfolio snapshot, and streaming it per node would push
 * megabytes over the socket for a 20-node run.
 */
export function graphStreamWsUrl(): string {
  const base = BACKEND_BASE.replace(/^http/, 'ws');
  return `${base}/api/graphs/stream`;
}

export function backendUrl(path: string): string {
  return `${BACKEND_BASE}${path}`;
}
