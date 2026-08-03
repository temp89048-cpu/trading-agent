import { listTrades } from '@/lib/tradeStore.server';

// ---------------------------------------------------------------------
// Real, server-side active health checks — distinct from
// SystemHealthPanel's client-side rollup of state it already has cached
// (candle presence, MCP reachability last time someone checked). Those
// only reflect what the browser already knows; this route independently
// exercises the two things this app's own server process actually
// depends on, so a genuine outage shows up even if the client's cached
// state still looks fine:
//   - the trade store (file-backed JSON — see lib/tradeStore.server.ts):
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

async function checkTradeStore(): Promise<HealthCheckResult> {
  const started = Date.now();
  try {
    const trades = await listTrades();
    return { label: 'Trade store', ok: true, detail: `read ${trades.length} trade${trades.length === 1 ? '' : 's'} from disk`, latencyMs: Date.now() - started };
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
  const [tradeStore, binance] = await Promise.all([checkTradeStore(), checkBinance()]);
  const checks = [tradeStore, binance];
  const failing = checks.filter((c) => !c.ok).length;
  const overall = failing === 0 ? 'healthy' : failing === checks.length ? 'unhealthy' : 'degraded';
  return Response.json({ overall, checks, checkedAt: Date.now() });
}
