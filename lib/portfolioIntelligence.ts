import type { WatchItem } from './types';

// ---------------------------------------------------------------------
// Portfolio Intelligence (Level 13) — correlation matrix, coarse
// category tagging, and a simple risk-parity sizing suggestion.
//
// Closes the honest stub left in lib/riskManager.ts's checkCorrelation
// since Commit 13: it always returned 'unavailable' because there was
// no cross-asset data to check against yet. This module supplies
// exactly that — from price history the app already has cached (no new
// data source needed for correlation itself, unlike multi-exchange
// aggregation in lib/multiExchange.ts, which is a genuinely new feed).
// ---------------------------------------------------------------------

export type CorrelationMatrix = Record<string, Record<string, number>>;

const MIN_BARS_FOR_CORRELATION = 30;

function pctReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue;
    out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

// Pearson correlation over the last N returns, where N is the smaller
// series' length — an approximation that assumes both series' bars are
// roughly time-aligned (same interval, same fetch time), which holds
// for this app's own 1h-candle cache but isn't independently verified
// bar-by-bar here.
function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < MIN_BARS_FOR_CORRELATION) return null;
  const av = a.slice(a.length - n);
  const bv = b.slice(b.length - n);
  const meanA = av.reduce((s, v) => s + v, 0) / n;
  const meanB = bv.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = av[i] - meanA;
    const db = bv[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null; // a constant return series — correlation is undefined, not zero
  return cov / Math.sqrt(varA * varB);
}

// Builds a full pairwise matrix from whatever primary-timeframe candle
// closes are already cached for each symbol — no fetching here. Pairs
// with too little overlapping history simply get no entry (checked
// honestly downstream via getCorrelation, never defaulted to 0).
export function computeCorrelationMatrix(priceHistories: Record<string, number[]>): CorrelationMatrix {
  const symbols = Object.keys(priceHistories);
  const returns: Record<string, number[]> = {};
  for (const s of symbols) returns[s] = pctReturns(priceHistories[s]);

  const matrix: CorrelationMatrix = {};
  for (const a of symbols) {
    matrix[a] = {};
    for (const b of symbols) {
      if (a === b) {
        matrix[a][b] = 1;
        continue;
      }
      const corr = pearson(returns[a], returns[b]);
      if (corr !== null) matrix[a][b] = corr;
    }
  }
  return matrix;
}

export function getCorrelation(matrix: CorrelationMatrix, a: string, b: string): number | null {
  return matrix[a]?.[b] ?? matrix[b]?.[a] ?? null;
}

// Realized volatility (stdev of per-bar % returns) from the same cached
// price history used for correlation — the input suggestRiskParityWeights
// needs. Same overlapping-bars floor as correlation, and same honest
// omission (not a zero) for symbols without enough history yet.
export function computeVolatilities(priceHistories: Record<string, number[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [symbol, closes] of Object.entries(priceHistories)) {
    const returns = pctReturns(closes);
    if (returns.length < MIN_BARS_FOR_CORRELATION) continue;
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
    out[symbol] = Math.sqrt(variance);
  }
  return out;
}

// ---------------------------------------------------------------------
// Coarse category tagging — a small hardcoded reference list, NOT a
// licensed sector-classification data feed. Flagged as approximate on
// every symbol not in the list, and even for symbols that ARE in the
// list, so this never gets mistaken for real sector data.
// ---------------------------------------------------------------------
const CRYPTO_CATEGORY: Record<string, string> = {
  BTC: 'Crypto — Large Cap',
  ETH: 'Crypto — Large Cap',
  SOL: 'Crypto — L1/Alt',
  ADA: 'Crypto — L1/Alt',
  AVAX: 'Crypto — L1/Alt',
  DOT: 'Crypto — L1/Alt',
  NEAR: 'Crypto — L1/Alt',
  UNI: 'Crypto — DeFi',
  AAVE: 'Crypto — DeFi',
  LINK: 'Crypto — DeFi',
  MKR: 'Crypto — DeFi',
  DOGE: 'Crypto — Meme',
  SHIB: 'Crypto — Meme',
  PEPE: 'Crypto — Meme',
  USDT: 'Crypto — Stablecoin',
  USDC: 'Crypto — Stablecoin',
};

const EQUITY_SECTOR: Record<string, string> = {
  AAPL: 'Equity — Technology',
  MSFT: 'Equity — Technology',
  GOOGL: 'Equity — Technology',
  GOOG: 'Equity — Technology',
  NVDA: 'Equity — Technology',
  META: 'Equity — Technology',
  AMD: 'Equity — Technology',
  AMZN: 'Equity — Consumer Discretionary',
  TSLA: 'Equity — Consumer Discretionary',
  JPM: 'Equity — Financials',
  BAC: 'Equity — Financials',
  GS: 'Equity — Financials',
  XOM: 'Equity — Energy',
  CVX: 'Equity — Energy',
  JNJ: 'Equity — Healthcare',
  PFE: 'Equity — Healthcare',
  UNH: 'Equity — Healthcare',
};

export function tagCategory(item: WatchItem): { category: string; approximate: boolean } {
  if (item.type === 'crypto') {
    const base = item.symbol.split('/')[0].toUpperCase();
    return CRYPTO_CATEGORY[base]
      ? { category: CRYPTO_CATEGORY[base], approximate: true }
      : { category: 'Crypto — Uncategorized', approximate: true };
  }
  const sym = item.symbol.toUpperCase();
  return EQUITY_SECTOR[sym]
    ? { category: EQUITY_SECTOR[sym], approximate: true }
    : { category: 'Equity — Uncategorized (no sector data provider wired up)', approximate: true };
}

// ---------------------------------------------------------------------
// Simple risk-parity suggestion: inverse-volatility weighting. A real
// risk-parity optimizer solves for equal marginal risk contribution
// using the full covariance matrix; this is the well-known simpler
// heuristic (weight inversely proportional to each asset's own realized
// volatility, ignoring cross-correlation in the sizing math itself even
// though correlation is used elsewhere in this module for concentration
// checks). Documented as exactly that — a heuristic, not an optimizer.
// ---------------------------------------------------------------------
export type RiskParitySuggestion = { symbol: string; weightPct: number; volatilityPct: number };

export function suggestRiskParityWeights(volatilities: Record<string, number>): RiskParitySuggestion[] {
  const entries = Object.entries(volatilities).filter(([, v]) => v > 0 && isFinite(v));
  if (entries.length === 0) return [];
  const inverseVols = entries.map(([symbol, vol]) => ({ symbol, inv: 1 / vol, vol }));
  const total = inverseVols.reduce((s, e) => s + e.inv, 0);
  return inverseVols
    .map((e) => ({ symbol: e.symbol, weightPct: (e.inv / total) * 100, volatilityPct: e.vol * 100 }))
    .sort((a, b) => b.weightPct - a.weightPct);
}

// ---------------------------------------------------------------------
// Concentration risk: the number that actually matters isn't the
// correlation alone, it's correlation PLUS enough combined position
// size for it to matter. Flags pairs of currently-held positions whose
// correlation exceeds `threshold` AND whose combined value exceeds
// `exposureLimitPct` of equity.
// ---------------------------------------------------------------------
export type ConcentrationFlag = {
  symbolA: string;
  symbolB: string;
  correlation: number;
  combinedExposureUsd: number;
  combinedExposurePct: number;
};

export const DEFAULT_CORRELATION_THRESHOLD = 0.75;
export const DEFAULT_EXPOSURE_LIMIT_PCT = 0.4; // 40% of equity concentrated in one correlated cluster

export function findConcentrationRisk(
  matrix: CorrelationMatrix,
  positions: { symbol: string; valueUsd: number }[],
  equityUsd: number,
  threshold: number = DEFAULT_CORRELATION_THRESHOLD,
  exposureLimitPct: number = DEFAULT_EXPOSURE_LIMIT_PCT,
): ConcentrationFlag[] {
  const flags: ConcentrationFlag[] = [];
  if (equityUsd <= 0) return flags;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const corr = getCorrelation(matrix, positions[i].symbol, positions[j].symbol);
      if (corr === null || corr < threshold) continue;
      const combined = positions[i].valueUsd + positions[j].valueUsd;
      const combinedPct = combined / equityUsd;
      if (combinedPct >= exposureLimitPct) {
        flags.push({
          symbolA: positions[i].symbol,
          symbolB: positions[j].symbol,
          correlation: corr,
          combinedExposureUsd: combined,
          combinedExposurePct: combinedPct * 100,
        });
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------
// Chat context injection.
// ---------------------------------------------------------------------
export function buildPortfolioIntelligenceContext(
  watchlist: WatchItem[],
  matrix: CorrelationMatrix,
  positions: { symbol: string; valueUsd: number }[],
  equityUsd: number | null,
  priceHistories: Record<string, number[]> = {},
): string {
  if (watchlist.length === 0) return 'PORTFOLIO INTELLIGENCE: no watchlist symbols to analyze.';

  const categoryLines = watchlist.map((item) => {
    const tag = tagCategory(item);
    return `  ${item.symbol}: ${tag.category} (approximate — hardcoded reference list, not a licensed sector-classification feed)`;
  });

  const pairs: string[] = [];
  for (let i = 0; i < watchlist.length; i++) {
    for (let j = i + 1; j < watchlist.length; j++) {
      const corr = getCorrelation(matrix, watchlist[i].symbol, watchlist[j].symbol);
      if (corr !== null) pairs.push(`  ${watchlist[i].symbol} <> ${watchlist[j].symbol}: ${corr.toFixed(2)}`);
    }
  }

  const concentration = equityUsd !== null ? findConcentrationRisk(matrix, positions, equityUsd) : [];
  const concentrationLines =
    concentration.length > 0
      ? concentration.map(
          (f) =>
            `  \u26a0 ${f.symbolA} & ${f.symbolB}: correlation ${f.correlation.toFixed(2)}, combined exposure $${f.combinedExposureUsd.toFixed(2)} (${f.combinedExposurePct.toFixed(0)}% of equity)`,
        )
      : ['  none flagged'];

  const volatilities = computeVolatilities(priceHistories);
  const riskParity = suggestRiskParityWeights(volatilities);
  const riskParityLines =
    riskParity.length > 0
      ? riskParity.map((r) => `  ${r.symbol}: ${r.weightPct.toFixed(1)}% (volatility ${r.volatilityPct.toFixed(2)}%/bar)`)
      : ['  not enough overlapping history yet to suggest weights'];

  return `PORTFOLIO INTELLIGENCE (correlation from cached 1h candle returns, ${MIN_BARS_FOR_CORRELATION}+ overlapping bars required — pairs below that threshold are omitted entirely, never shown as zero):
Categories:
${categoryLines.join('\n')}

Pairwise correlation:
${pairs.length > 0 ? pairs.join('\n') : '  not enough overlapping history for any pair yet'}

Concentration risk flags (correlation >= ${DEFAULT_CORRELATION_THRESHOLD}, combined exposure >= ${(DEFAULT_EXPOSURE_LIMIT_PCT * 100).toFixed(0)}% of equity):
${concentrationLines.join('\n')}

Suggested risk-parity capital allocation (inverse-volatility weighting heuristic, ignores cross-correlation — not a full covariance optimizer):
${riskParityLines.join('\n')}

This feeds the same-named check in the Risk Manager (previously an honest "not yet built" stub) — a real rejection path now, not just informational display.`;
}
