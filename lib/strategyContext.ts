import { rsi, macd, ema, bollingerBands, atr, vwap, type Candle, type MacdResult, type BollingerResult } from './indicators';
import { computeMtfSnapshot, type SymbolMtfSnapshot, type MtfLookup } from './multiTimeframe';
import { computeMarketStructure, type StructureSnapshot } from './marketStructure';
import { computeLiquidity, type LiquiditySnapshot } from './liquidity';
import { computeVolumeProfile, type VolumeProfile } from './volumeProfile';
import { computeOrderFlow, type OrderFlowSnapshot, type RawOrderFlowData } from './orderFlow';
import type { WatchItem } from './types';

// One object every strategy agent reads from — built once per symbol
// from the same real data Commits 8-11 already compute (multi-timeframe
// trend, market structure, liquidity zones, volume profile, order
// flow), plus the core indicators. No agent below fetches anything or
// invents a number; they only branch on what's already here.
export type StrategyContext = {
  symbol: string;
  price: number;
  candles: Candle[]; // primary timeframe (1h) candles
  rsiValue: number | null;
  macdValue: MacdResult | null;
  ema20: number | null;
  ema50: number | null;
  bb: BollingerResult | null;
  atrValue: number | null;
  vwapValue: number | null;
  mtf: SymbolMtfSnapshot;
  structure: StructureSnapshot;
  liquidity: LiquiditySnapshot;
  volumeProfile: VolumeProfile | null;
  orderFlow: OrderFlowSnapshot | null; // null when unsupported (equities) or not loaded yet
};

const MIN_CANDLES = 55; // needs enough for EMA50 + the rest of the indicator stack to be meaningful

export function buildStrategyContext(
  item: WatchItem,
  primaryCandles: Candle[],
  mtfLookup: MtfLookup,
  rawOrderFlow: RawOrderFlowData | undefined,
): StrategyContext | null {
  if (primaryCandles.length < MIN_CANDLES) return null;
  const closes = primaryCandles.map((c) => c.c);
  const price = closes[closes.length - 1];

  return {
    symbol: item.symbol,
    price,
    candles: primaryCandles,
    rsiValue: rsi(closes),
    macdValue: macd(closes),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    bb: bollingerBands(closes),
    atrValue: atr(primaryCandles),
    vwapValue: vwap(primaryCandles),
    mtf: computeMtfSnapshot(item, mtfLookup),
    structure: computeMarketStructure(primaryCandles),
    liquidity: computeLiquidity(primaryCandles),
    volumeProfile: computeVolumeProfile(primaryCandles),
    orderFlow: rawOrderFlow ? computeOrderFlow(rawOrderFlow) : null,
  };
}

// ---------------------------------------------------------------------
// Shared signal shape every strategy agent returns.
// ---------------------------------------------------------------------
export type StrategySignal = {
  agent: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0..1 — this agent's own conviction, not the ensemble's
  reason: string;
};
