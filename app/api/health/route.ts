import { ping } from '@/lib/db.server';
import { listTrades } from '@/lib/tradeStore.server';

// ---------------------------------------------------------------------
// Real, server-side active health checks — distinct from
// SystemHealthPanel's client-side rollup of state it already has cached
// (candle presence, MCP reachability last time someone checked). Those
// only reflect what the browser already knows; this route independently
// exercises the two things this app's own server process actually
// depends on, so a genuine outage shows up even if the client's cached
// state still looks fine:
//   - Postgres: a real connect-and-query, so a bad DATABASE_URL or an
//     unreachable host is visible HERE rather than as an empty table on some
//     page. It reports which store the trade read came from too, because a
//     silent fall back to the JSON file means the dashboard and the agent are
//     reading different books.
//   - the trade store (Postgres, JSON fallback — see lib/tradeStore.server.ts):
//     a real read round-trip, not just "the file exists"
//   - Binance's public REST API — the spine of this app's real market
//     data (candles, order flow, funding/OI) — via its dedicated /ping
//     endpoint (near-zero cost, meant exactly for this)
// Nothing here is a synthetic uptime probe against THIS app's own
// process (that would need an external pinger, out of scope for a
// route the app calls on itself) — it's checking the two real external
// dependencies this app can't function without.
// ---------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type HealthCheckResult = { label: string; ok: boolean; detail: string; latencyMs: number };

async function checkDatabase(): Promise<HealthCheckResult> {
  const started = Date.now();
  const result = await ping();
  const latencyMs = Date.now() - started;
  if (result.ok) {
    return {
      label: 'Postgres',
      ok: true,
      detail: `server ${result.serverVersion}, ${result.tables} table(s)`,
      latencyMs,
    };
  }
  // NOT ok. A missing DATABASE_URL is a configuration state rather than an
  // outage, but it still means every store is serving the JSON fallback, so it
  // must not read as healthy — that is how two books get read as one.
  return { label: 'Postgres', ok: false, detail: result.reason, latencyMs };
}

async function checkTradeStore(): Promise<HealthCheckResult> {
  const started = Date.now();
  try {
    const trades = await listTrades();
    return {
      label: 'Trade store',
      ok: true,
      detail: `read ${trades.length} trade${trades.length === 1 ? '' : 's'}`,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { label: 'Trade store', ok: false, detail: err instanceof Error ? err.message : 'read failed', latencyMs: Date.now() - started };
  }
}

async function checkBinance(): Promise<HealthCheckResult> {
  const started = Date.now();
  try {
    const res = await fetch('https://api.binance.com/api/v3/ping', {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal health check)' },
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { label: 'Binance API', ok: false, detail: `HTTP ${res.status}`, latencyMs };
    return { label: 'Binance API', ok: true, detail: 'reachable', latencyMs };
  } catch (err) {
    return { label: 'Binance API', ok: false, detail: err instanceof Error ? err.message : 'unreachable', latencyMs: Date.now() - started };
  }
}

export async function GET() {
  const [database, tradeStore, binance] = await Promise.all([
    checkDatabase(),
    checkTradeStore(),
    checkBinance(),
  ]);
  const checks = [database, tradeStore, binance];
  const failing = checks.filter((c) => !c.ok).length;
  const overall = failing === 0 ? 'healthy' : failing === checks.length ? 'unhealthy' : 'degraded';
  return Response.json({ overall, checks, checkedAt: Date.now() });
}
