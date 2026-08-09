import type { TradeLogEntry } from './types';

// ---------------------------------------------------------------------
// Learning Dashboard (Level 17).
//
// Everything here is computed from the real trade log (Commit 14) —
// nothing simulated, nothing backtested. Two honest limitations worth
// stating up front, both because the underlying ledger genuinely
// doesn't carry the data a fuller version of this would want:
//
// 1. "Best/worst performing STRATEGIES" — the Strategy Ensemble
//    (Commit 12) is informational-only and never auto-executes, so
//    there is no real link between an executed trade and which of the
//    seven strategy agents "caused" it. This groups by trade ORIGIN
//    instead (debate-driven / chat trade-action / autonomous agent
//    plan / typed user-command / manual click) — the closest thing to
//    "strategy" the data actually supports, tagged at execution time
//    since Commit 23 (lib/types.ts's TradeLogEntry.originTag). Trades
//    placed before this existed fall into 'unknown'.
// 2. Hold time / market-condition / volatility-regime are reconstructed
//    from the ledger's own running qty per (symbol, tab) and from the
//    entry-context snapshot string already captured at buy time
//    (Commit 15). This is a real reconstruction, not a fabrication, but
//    it's an approximation for symbols that get repeatedly averaged
//    into and partially sold — it treats a position as one continuous
//    holding from when qty first goes above zero to when it returns to
//    zero, not precise per-lot FIFO accounting.
// ---------------------------------------------------------------------

export type ClosedTrade = {
  // The CLOSING trade-log entry's id. Reflections and hypotheses are
  // both keyed by this same id (see lib/reflectionStore.server.ts and
  // lib/hypothesisStore.server.ts, which key off the closing trade), so
  // exposing it is what lets lib/knowledgeGraph.ts link a round-trip to
  // its own lesson without re-deriving round-trips a second, possibly
  // inconsistent way.
  exitTradeId: string;
  symbol: string;
  tab: string;
  entryTs: number;
  exitTs: number;
  holdMinutes: number;
  pnl: number;
  originTag: TradeLogEntry['originTag'] | 'unknown';
  marketCondition: 'bullish' | 'bearish' | 'range' | 'unknown';
  volatilityRegime: 'low' | 'medium' | 'high' | 'unknown';
  hasReflection: boolean;
};

const DUST_QTY = 1e-8;

function classifyEntryContext(entryContext: string | undefined, entryPrice: number): { marketCondition: ClosedTrade['marketCondition']; volatilityRegime: ClosedTrade['volatilityRegime'] } {
  if (!entryContext) return { marketCondition: 'unknown', volatilityRegime: 'unknown' };

  const trendMatch = entryContext.match(/structure trend=(\w+)/);
  let marketCondition: ClosedTrade['marketCondition'] = 'unknown';
  if (trendMatch) {
    const raw = trendMatch[1];
    marketCondition = raw === 'bullish' ? 'bullish' : raw === 'bearish' ? 'bearish' : raw === 'undefined' ? 'range' : 'unknown';
  }

  const atrMatch = entryContext.match(/ATR\(14\)=([\d.]+)/);
  let volatilityRegime: ClosedTrade['volatilityRegime'] = 'unknown';
  if (atrMatch && entryPrice > 0) {
    const atrPct = (parseFloat(atrMatch[1]) / entryPrice) * 100;
    volatilityRegime = atrPct < 1 ? 'low' : atrPct < 3 ? 'medium' : 'high';
  }

  return { marketCondition, volatilityRegime };
}

type OpenState = { openedAt: number; originTag: TradeLogEntry['originTag'] | 'unknown'; entryContext?: string; entryPrice: number; runningQty: number };

export function reconstructClosedTrades(tradeLog: TradeLogEntry[], reflectedTradeIds: Set<string> = new Set()): ClosedTrade[] {
  const sorted = [...tradeLog].sort((a, b) => a.ts - b.ts);
  const openState: Record<string, OpenState> = {};
  const closed: ClosedTrade[] = [];

  for (const t of sorted) {
    const key = `${t.tab}:${t.symbol}`;
    if (t.side === 'buy') {
      const state = openState[key];
      if (!state || state.runningQty <= DUST_QTY) {
        openState[key] = { openedAt: t.ts, originTag: t.originTag ?? 'unknown', entryContext: t.entryContext, entryPrice: t.price, runningQty: t.qty };
      } else {
        state.runningQty += t.qty; // averaging in — position stays continuously open since it first opened
      }
    } else {
      const state = openState[key];
      if (!state) continue; // a sell/close with no tracked open state (log starts mid-position) — skip, don't invent a hold time
      state.runningQty -= t.qty;
      if (state.runningQty <= DUST_QTY && t.pnl !== undefined) {
        const { marketCondition, volatilityRegime } = classifyEntryContext(state.entryContext, state.entryPrice);
        closed.push({
          exitTradeId: t.id,
          symbol: t.symbol,
          tab: t.tab,
          entryTs: state.openedAt,
          exitTs: t.ts,
          holdMinutes: (t.ts - state.openedAt) / 60000,
          pnl: t.pnl,
          originTag: state.originTag,
          marketCondition,
          volatilityRegime,
          hasReflection: reflectedTradeIds.has(t.id),
        });
        delete openState[key];
      }
    }
  }
  return closed;
}

// ---------------------------------------------------------------------
// Generic grouped breakdown — same shape reused for origin / market
// condition / volatility regime / hour / weekday so the dashboard and
// API route don't repeat this five times.
// ---------------------------------------------------------------------
export type GroupStats = {
  group: string;
  trades: number;
  wins: number;
  winRatePct: number | null; // null when below MIN_SAMPLE, not shown as a shaky number
  totalPnl: number;
  avgPnl: number;
};

const MIN_SAMPLE = 3;

function groupBy(closed: ClosedTrade[], keyFn: (c: ClosedTrade) => string): GroupStats[] {
  const buckets = new Map<string, ClosedTrade[]>();
  for (const c of closed) {
    const k = keyFn(c);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(c);
  }
  return Array.from(buckets.entries())
    .map(([group, trades]) => {
      const wins = trades.filter((t) => t.pnl > 0).length;
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
      return {
        group,
        trades: trades.length,
        wins,
        winRatePct: trades.length >= MIN_SAMPLE ? (wins / trades.length) * 100 : null,
        totalPnl,
        avgPnl: totalPnl / trades.length,
      };
    })
    .sort((a, b) => b.trades - a.trades);
}

export function winRateByOrigin(closed: ClosedTrade[]): GroupStats[] {
  return groupBy(closed, (c) => c.originTag ?? 'unknown');
}
export function winRateByMarketCondition(closed: ClosedTrade[]): GroupStats[] {
  return groupBy(closed, (c) => c.marketCondition);
}
export function winRateByVolatilityRegime(closed: ClosedTrade[]): GroupStats[] {
  return groupBy(closed, (c) => c.volatilityRegime);
}
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function performanceByWeekday(closed: ClosedTrade[]): GroupStats[] {
  return groupBy(closed, (c) => WEEKDAY_LABELS[new Date(c.entryTs).getUTCDay()]).sort(
    (a, b) => WEEKDAY_LABELS.indexOf(a.group) - WEEKDAY_LABELS.indexOf(b.group),
  );
}
export function performanceByHourOfDay(closed: ClosedTrade[]): GroupStats[] {
  return groupBy(closed, (c) => String(new Date(c.entryTs).getUTCHours()).padStart(2, '0') + ':00 UTC').sort(
    (a, b) => parseInt(a.group) - parseInt(b.group),
  );
}

// ---------------------------------------------------------------------
// Best/worst "performing strategies" — grouped by origin (see module
// header for why), ranked by total realized P&L. Needs MIN_SAMPLE
// trades to be ranked at all — a single lucky/unlucky trade isn't a
// "best performing strategy."
// ---------------------------------------------------------------------
export function bestAndWorstOrigins(closed: ClosedTrade[]): { best: GroupStats[]; worst: GroupStats[] } {
  const eligible = winRateByOrigin(closed).filter((g) => g.trades >= MIN_SAMPLE);
  const sorted = [...eligible].sort((a, b) => b.totalPnl - a.totalPnl);
  if (sorted.length === 0) return { best: [], worst: [] };
  // Non-overlapping top/bottom split, capped at 3 each — with few
  // eligible groups this still gives a genuine best AND worst (e.g. 2
  // groups -> 1 best, 1 worst) rather than one list swallowing the
  // other via a naive top-3/bottom-3 overlap check.
  const bestCount = Math.min(3, Math.ceil(sorted.length / 2));
  const worstCount = Math.min(3, sorted.length - bestCount);
  const best = sorted.slice(0, bestCount);
  const worst = sorted.slice(sorted.length - worstCount).reverse();
  return { best, worst };
}

// ---------------------------------------------------------------------
// Expectancy — standard formula: (win rate * avg win) - (loss rate * avg |loss|).
// The expected $ P&L per trade, given this system's own real track record.
// ---------------------------------------------------------------------
export type ExpectancyResult = { expectancyUsd: number | null; winRatePct: number | null; avgWin: number; avgLoss: number; sampleSize: number };

export function computeExpectancy(closed: ClosedTrade[]): ExpectancyResult {
  if (closed.length < MIN_SAMPLE) {
    return { expectancyUsd: null, winRatePct: null, avgWin: 0, avgLoss: 0, sampleSize: closed.length };
  }
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const winRate = wins.length / closed.length;
  const lossRate = losses.length / closed.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  return { expectancyUsd: winRate * avgWin - lossRate * avgLoss, winRatePct: winRate * 100, avgWin, avgLoss, sampleSize: closed.length };
}

// ---------------------------------------------------------------------
// Hold time — mean and median across closed trades.
// ---------------------------------------------------------------------
export function averageHoldTime(closed: ClosedTrade[]): { avgMinutes: number | null; medianMinutes: number | null; sampleSize: number } {
  if (closed.length === 0) return { avgMinutes: null, medianMinutes: null, sampleSize: 0 };
  const sorted = [...closed].map((c) => c.holdMinutes).sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { avgMinutes: avg, medianMinutes: median, sampleSize: sorted.length };
}

// ---------------------------------------------------------------------
// Max drawdown — from the cumulative REALIZED P&L curve of closed
// trades, in chronological order. This is explicitly a P&L-only curve,
// not a full account-equity curve (it doesn't include cash balance,
// unrealized positions, or deposits/withdrawals) — labeled as such
// rather than presented as a complete equity drawdown.
// ---------------------------------------------------------------------
export function computeMaxDrawdown(closed: ClosedTrade[]): { maxDrawdownUsd: number; peakUsd: number; troughUsd: number } {
  const chronological = [...closed].sort((a, b) => a.exitTs - b.exitTs);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let peakAtMaxDd = 0;
  let troughAtMaxDd = 0;
  for (const t of chronological) {
    cumulative += t.pnl;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      peakAtMaxDd = peak;
      troughAtMaxDd = cumulative;
    }
  }
  return { maxDrawdownUsd: maxDrawdown, peakUsd: peakAtMaxDd, troughUsd: troughAtMaxDd };
}

// ---------------------------------------------------------------------
// Full dashboard payload — what /api/stats returns and app/dashboard
// renders.
// ---------------------------------------------------------------------
export type DashboardStats = {
  totalClosedTrades: number;
  byOrigin: GroupStats[];
  bestOrigins: GroupStats[];
  worstOrigins: GroupStats[];
  byMarketCondition: GroupStats[];
  byVolatilityRegime: GroupStats[];
  byWeekday: GroupStats[];
  byHourOfDay: GroupStats[];
  expectancy: ExpectancyResult;
  holdTime: { avgMinutes: number | null; medianMinutes: number | null; sampleSize: number };
  maxDrawdown: { maxDrawdownUsd: number; peakUsd: number; troughUsd: number };
  reflectionCoveragePct: number | null;
};

export function buildDashboardStats(tradeLog: TradeLogEntry[], reflectedTradeIds: Set<string> = new Set()): DashboardStats {
  const closed = reconstructClosedTrades(tradeLog, reflectedTradeIds);
  const { best, worst } = bestAndWorstOrigins(closed);
  const withReflection = closed.filter((c) => c.hasReflection).length;

  return {
    totalClosedTrades: closed.length,
    byOrigin: winRateByOrigin(closed),
    bestOrigins: best,
    worstOrigins: worst,
    byMarketCondition: winRateByMarketCondition(closed),
    byVolatilityRegime: winRateByVolatilityRegime(closed),
    byWeekday: performanceByWeekday(closed),
    byHourOfDay: performanceByHourOfDay(closed),
    expectancy: computeExpectancy(closed),
    holdTime: averageHoldTime(closed),
    maxDrawdown: computeMaxDrawdown(closed),
    reflectionCoveragePct: closed.length > 0 ? (withReflection / closed.length) * 100 : null,
  };
}
