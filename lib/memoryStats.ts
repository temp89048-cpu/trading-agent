import type { TradeLogEntry } from './types';

// Canonical definition — memoryStore.server.ts imports this type rather
// than the other way around, so this pure/client-safe module never has
// even a type-only dependency on the fs-backed server module.
export type RiskPreference = 'conservative' | 'moderate' | 'aggressive';

// Everything here is derived LIVE from tradeLog on every call — no
// separate persisted aggregate, per the same "single source of truth"
// principle already used elsewhere in this app (e.g. RiskManagerPanel
// recomputing daily-loss/drawdown straight from tradeLog rather than a
// cached number). If a trade is edited or deleted, these numbers are
// correct on the very next render with zero migration/sync work.

export type ClosedTrade = TradeLogEntry & { pnl: number };

export function closedTrades(trades: TradeLogEntry[]): ClosedTrade[] {
  return trades.filter((t): t is ClosedTrade => typeof t.pnl === 'number' && isFinite(t.pnl));
}

export type OverallStats = {
  totalTrades: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null; // null until at least one closed trade exists
  totalPnl: number;
  avgPnl: number | null;
};

export function computeOverallStats(trades: TradeLogEntry[]): OverallStats {
  const closed = closedTrades(trades);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl < 0).length;
  const totalPnl = closed.reduce((sum, t) => sum + t.pnl, 0);
  return {
    totalTrades: trades.length,
    closedCount: closed.length,
    wins,
    losses,
    winRate: closed.length > 0 ? wins / closed.length : null,
    totalPnl,
    avgPnl: closed.length > 0 ? totalPnl / closed.length : null,
  };
}

export type SymbolStats = {
  symbol: string;
  trades: number;
  closedCount: number;
  winRate: number | null;
  totalPnl: number;
  avgNotional: number;
};

export function computeSymbolStats(trades: TradeLogEntry[]): SymbolStats[] {
  const bySymbol = new Map<string, TradeLogEntry[]>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }
  const out: SymbolStats[] = [];
  for (const [symbol, list] of bySymbol) {
    const closed = closedTrades(list);
    const wins = closed.filter((t) => t.pnl > 0).length;
    const totalPnl = closed.reduce((sum, t) => sum + t.pnl, 0);
    const avgNotional = list.reduce((sum, t) => sum + t.qty * t.price, 0) / list.length;
    out.push({
      symbol,
      trades: list.length,
      closedCount: closed.length,
      winRate: closed.length > 0 ? wins / closed.length : null,
      totalPnl,
      avgNotional,
    });
  }
  return out;
}

export type FavoriteAssets = {
  mostTraded: { symbol: string; trades: number } | null;
  bestPerforming: { symbol: string; totalPnl: number; closedCount: number } | null;
};

// "Best performing" requires at least 2 closed trades on that symbol —
// one lucky trade isn't a "best performer", it's a sample size of one.
// Below that threshold this stays honestly null rather than crowning a
// symbol off a single data point.
const MIN_CLOSED_FOR_BEST_PERFORMER = 2;

export function computeFavoriteAssets(trades: TradeLogEntry[]): FavoriteAssets {
  const stats = computeSymbolStats(trades);
  const mostTraded = stats.length > 0 ? stats.reduce((a, b) => (b.trades > a.trades ? b : a)) : null;
  const eligible = stats.filter((s) => s.closedCount >= MIN_CLOSED_FOR_BEST_PERFORMER);
  const bestPerforming = eligible.length > 0 ? eligible.reduce((a, b) => (b.totalPnl > a.totalPnl ? b : a)) : null;
  return {
    mostTraded: mostTraded ? { symbol: mostTraded.symbol, trades: mostTraded.trades } : null,
    bestPerforming: bestPerforming ? { symbol: bestPerforming.symbol, totalPnl: bestPerforming.totalPnl, closedCount: bestPerforming.closedCount } : null,
  };
}

export type ActiveHours = {
  peakWindowUtc: string | null; // e.g. "09:00–11:00 UTC"
  histogram: number[]; // 24 buckets, hour-of-day UTC
};

// Minimum sample size before claiming a "pattern" — otherwise 3 trades
// all placed at 14:00 would falsely read as a strong daily habit.
const MIN_TRADES_FOR_HOUR_PATTERN = 8;

export function computeActiveHours(trades: TradeLogEntry[]): ActiveHours {
  const histogram = new Array(24).fill(0) as number[];
  for (const t of trades) {
    const hour = new Date(t.ts).getUTCHours();
    histogram[hour] += 1;
  }
  if (trades.length < MIN_TRADES_FOR_HOUR_PATTERN) {
    return { peakWindowUtc: null, histogram };
  }
  // Find the best contiguous 2-hour window by trade count.
  let bestStart = 0;
  let bestCount = -1;
  for (let h = 0; h < 24; h++) {
    const count = histogram[h] + histogram[(h + 1) % 24];
    if (count > bestCount) {
      bestCount = count;
      bestStart = h;
    }
  }
  if (bestCount <= 0) return { peakWindowUtc: null, histogram };
  const pad = (n: number) => n.toString().padStart(2, '0');
  const endHour = (bestStart + 2) % 24;
  return { peakWindowUtc: `${pad(bestStart)}:00–${pad(endHour)}:00 UTC`, histogram };
}

export type InferredRiskPreference = {
  preference: RiskPreference | null;
  reason: string;
};

// Heuristic, explicitly labeled as such: average realized P&L magnitude
// as a percentage of position notional, across closed trades. This is a
// rough proxy for how much adverse/favorable move a trade is typically
// allowed to run before it's closed — not a real risk assessment, and
// it's always overridden by an explicitly stated preference if one is
// set (see buildMemoryContext in lib/memoryContext.ts).
const MIN_CLOSED_FOR_INFERENCE = 5;
const CONSERVATIVE_MAX_PCT = 1.5;
const MODERATE_MAX_PCT = 4;

export function inferRiskPreference(trades: TradeLogEntry[]): InferredRiskPreference {
  const closed = closedTrades(trades);
  if (closed.length < MIN_CLOSED_FOR_INFERENCE) {
    return { preference: null, reason: `not enough closed trades yet (${closed.length}/${MIN_CLOSED_FOR_INFERENCE} needed)` };
  }
  const pcts = closed
    .map((t) => {
      const notional = t.qty * t.price;
      return notional > 0 ? (Math.abs(t.pnl) / notional) * 100 : null;
    })
    .filter((v): v is number => v !== null);
  if (pcts.length === 0) {
    return { preference: null, reason: 'closed trades have no usable notional to measure against' };
  }
  const avgPct = pcts.reduce((sum, v) => sum + v, 0) / pcts.length;
  if (avgPct <= CONSERVATIVE_MAX_PCT) {
    return { preference: 'conservative', reason: `avg realized P&L magnitude ~${avgPct.toFixed(1)}% of position size across ${pcts.length} closed trades` };
  }
  if (avgPct <= MODERATE_MAX_PCT) {
    return { preference: 'moderate', reason: `avg realized P&L magnitude ~${avgPct.toFixed(1)}% of position size across ${pcts.length} closed trades` };
  }
  return { preference: 'aggressive', reason: `avg realized P&L magnitude ~${avgPct.toFixed(1)}% of position size across ${pcts.length} closed trades` };
}
