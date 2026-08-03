import type { Candle } from './indicators';
import type { WatchItem, TradeLogEntry } from './types';
import { tagCategory } from './portfolioIntelligence';
import { reconstructClosedTrades, bestAndWorstOrigins, type GroupStats } from './learningDashboard';
import type { MarketEvent } from './eventDetection';

// ---------------------------------------------------------------------
// Autonomous Research (Level 10) — the one roadmap level that was
// entirely reactive before this: every other "intelligent" feature in
// this app only runs when a user asks or opens a page. This module is
// the pure-analysis half of fixing that; components/AutonomousResearch.tsx
// is the half that actually calls it on a timer without being asked.
//
// Deliberately built from data this app ALREADY has cached (candles,
// event detection, trade log) rather than any new paid API — "trending
// coins" here means "trending within your own watchlist," not a global
// market scanner, and "sector performance" reuses the same hardcoded,
// honestly-approximate category tags lib/portfolioIntelligence.ts
// already uses elsewhere. No fabricated global-market claims.
// ---------------------------------------------------------------------

const LOOKBACK_BARS = 24; // ~24h of 1h candles — "overnight"/"today" window

function pctChangeOverLookback(candles: Candle[]): number | null {
  if (candles.length < LOOKBACK_BARS + 1) return null;
  const first = candles[candles.length - 1 - LOOKBACK_BARS].c;
  const last = candles[candles.length - 1].c;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

function volumeRatioOverLookback(candles: Candle[]): number | null {
  if (candles.length < LOOKBACK_BARS * 2) return null;
  const recentBars = candles.slice(-LOOKBACK_BARS);
  const priorBars = candles.slice(-LOOKBACK_BARS * 2, -LOOKBACK_BARS);
  const recentVol = recentBars.reduce((s, c) => s + c.v, 0);
  const priorVol = priorBars.reduce((s, c) => s + c.v, 0);
  if (priorVol <= 0) return null;
  return recentVol / priorVol;
}

// ---------------------------------------------------------------------
// "What coins are trending?" — ranked by absolute price move over the
// lookback window among the user's OWN watchlist (this app has no
// global market-scan data source), tagged with a volume-confirmation
// ratio so a big move on thin volume reads differently from one with
// real participation behind it.
// ---------------------------------------------------------------------
export type TrendingSymbol = { symbol: string; pctChange: number; volumeRatio: number | null; direction: 'up' | 'down' };

export function rankTrendingSymbols(watchlist: WatchItem[], candlesBySymbol: Record<string, Candle[] | undefined>): TrendingSymbol[] {
  const out: TrendingSymbol[] = [];
  for (const item of watchlist) {
    const candles = candlesBySymbol[item.symbol];
    if (!candles) continue;
    const pctChange = pctChangeOverLookback(candles);
    if (pctChange === null) continue;
    out.push({ symbol: item.symbol, pctChange, volumeRatio: volumeRatioOverLookback(candles), direction: pctChange >= 0 ? 'up' : 'down' });
  }
  return out.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));
}

// ---------------------------------------------------------------------
// "Which sectors are outperforming?" — average of the same per-symbol
// % change, grouped by the same coarse/approximate category tags used
// in Portfolio Intelligence. Explicitly NOT real sector-classification
// data (see tagCategory's own docs) — this only tells you which of
// YOUR watchlist's categories moved more, not a market-wide sector read.
// ---------------------------------------------------------------------
export type SectorPerformance = { category: string; avgPctChange: number; symbolCount: number; approximate: true };

export function rankSectorPerformance(watchlist: WatchItem[], candlesBySymbol: Record<string, Candle[] | undefined>): SectorPerformance[] {
  const bucket = new Map<string, number[]>();
  for (const item of watchlist) {
    const candles = candlesBySymbol[item.symbol];
    if (!candles) continue;
    const pctChange = pctChangeOverLookback(candles);
    if (pctChange === null) continue;
    const category = tagCategory(item).category;
    if (!bucket.has(category)) bucket.set(category, []);
    bucket.get(category)!.push(pctChange);
  }
  return Array.from(bucket.entries())
    .map(([category, changes]) => ({ category, avgPctChange: changes.reduce((s, v) => s + v, 0) / changes.length, symbolCount: changes.length, approximate: true as const }))
    .sort((a, b) => b.avgPctChange - a.avgPctChange);
}

// ---------------------------------------------------------------------
// "Which setups have the highest historical edge?" — reuses the same
// win-rate-by-origin the Learning Dashboard (Level 17) already computes
// from the real trade log. Ranked by win rate (an "edge" question),
// not total P&L (a "size" question) — same MIN_SAMPLE floor as the
// dashboard, so a lucky 2-trade streak never gets called an edge.
// ---------------------------------------------------------------------
export function findHighestEdgeSetups(tradeLog: TradeLogEntry[]): GroupStats[] {
  const closed = reconstructClosedTrades(tradeLog);
  const { best } = bestAndWorstOrigins(closed);
  return [...best].sort((a, b) => (b.winRatePct ?? -1) - (a.winRatePct ?? -1));
}

// ---------------------------------------------------------------------
// "What changed overnight?" — the same lookback-window price move plus
// whatever real MarketEvents (Level 16: funding spikes, volatility
// explosions, unusual volume, gap opens) landed in that window for each
// symbol. Only symbols with an actual event OR a non-trivial price move
// are surfaced — a flat, event-free night for a symbol just isn't news.
// ---------------------------------------------------------------------
export type OvernightChange = { symbol: string; pctChange: number | null; events: MarketEvent[] };

const NOTABLE_OVERNIGHT_PCT = 2; // below this AND no events, a symbol isn't worth surfacing as "changed overnight"

export function findOvernightChanges(
  watchlist: WatchItem[],
  candlesBySymbol: Record<string, Candle[] | undefined>,
  eventsBySymbol: Record<string, MarketEvent[] | undefined>,
): OvernightChange[] {
  const out: OvernightChange[] = [];
  const sinceMs = Date.now() - LOOKBACK_BARS * 60 * 60_000;
  for (const item of watchlist) {
    const candles = candlesBySymbol[item.symbol];
    const pctChange = candles ? pctChangeOverLookback(candles) : null;
    const events = (eventsBySymbol[item.symbol] ?? []).filter((e) => e.ts >= sinceMs);
    if (events.length === 0 && (pctChange === null || Math.abs(pctChange) < NOTABLE_OVERNIGHT_PCT)) continue;
    out.push({ symbol: item.symbol, pctChange, events });
  }
  return out.sort((a, b) => b.events.length - a.events.length || Math.abs(b.pctChange ?? 0) - Math.abs(a.pctChange ?? 0));
}

// ---------------------------------------------------------------------
// The full digest — one snapshot combining all four questions above.
// ---------------------------------------------------------------------
export type ResearchDigest = {
  ts: number;
  trending: TrendingSymbol[];
  sectors: SectorPerformance[];
  highestEdgeSetups: GroupStats[];
  overnightChanges: OvernightChange[];
};

export function buildResearchDigest(
  watchlist: WatchItem[],
  candlesBySymbol: Record<string, Candle[] | undefined>,
  eventsBySymbol: Record<string, MarketEvent[] | undefined>,
  tradeLog: TradeLogEntry[],
  ts: number,
): ResearchDigest {
  return {
    ts,
    trending: rankTrendingSymbols(watchlist, candlesBySymbol),
    sectors: rankSectorPerformance(watchlist, candlesBySymbol),
    highestEdgeSetups: findHighestEdgeSetups(tradeLog),
    overnightChanges: findOvernightChanges(watchlist, candlesBySymbol, eventsBySymbol),
  };
}

// ---------------------------------------------------------------------
// Chat context injection — so the model can proactively reference this
// digest instead of the user having to ask for each analysis by hand.
// ---------------------------------------------------------------------
export function buildAutonomousResearchContext(digest: ResearchDigest | null): string {
  if (!digest) {
    return 'AUTONOMOUS RESEARCH: no digest generated yet — the periodic research scheduler runs automatically while the app is open (see Autonomous Research panel), or can be triggered manually.';
  }
  const ageMinutes = Math.round((Date.now() - digest.ts) / 60_000);
  const lines: string[] = [`AUTONOMOUS RESEARCH (proactively generated ${ageMinutes}m ago, not requested by the user — watchlist-scoped, not a global market scan):`];

  lines.push(digest.trending.length > 0
    ? `Trending within your watchlist (24h |% move|, ranked): ${digest.trending.slice(0, 5).map((t) => `${t.symbol} ${t.pctChange >= 0 ? '+' : ''}${t.pctChange.toFixed(1)}%${t.volumeRatio !== null ? ` (vol ${t.volumeRatio.toFixed(1)}x)` : ''}`).join(', ')}`
    : 'Trending: not enough 24h candle history cached yet for any watchlist symbol.');

  lines.push(digest.sectors.length > 0
    ? `Category performance (approximate — hardcoded reference list, not licensed sector data): ${digest.sectors.map((s) => `${s.category} ${s.avgPctChange >= 0 ? '+' : ''}${s.avgPctChange.toFixed(1)}% (${s.symbolCount} symbol${s.symbolCount > 1 ? 's' : ''})`).join(', ')}`
    : 'Category performance: not enough data yet.');

  lines.push(digest.highestEdgeSetups.length > 0
    ? `Highest historical-edge setups (by win rate, real trade log, min sample enforced): ${digest.highestEdgeSetups.map((g) => `${g.group} ${g.winRatePct?.toFixed(0)}% win rate over ${g.trades} trades`).join(', ')}`
    : 'Highest historical-edge setups: not enough closed trades per origin yet to call one out honestly.');

  lines.push(digest.overnightChanges.length > 0
    ? `What changed overnight: ${digest.overnightChanges.map((o) => `${o.symbol}${o.pctChange !== null ? ` (${o.pctChange >= 0 ? '+' : ''}${o.pctChange.toFixed(1)}%)` : ''}${o.events.length > 0 ? ` — ${o.events.map((e) => e.detail).join('; ')}` : ''}`).join(' | ')}`
    : 'What changed overnight: nothing notable detected across the watchlist.');

  return lines.join('\n');
}
