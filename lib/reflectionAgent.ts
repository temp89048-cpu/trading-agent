import type { TradeSide, TradeTab } from './types';
import { computeIndicatorSnapshot } from './indicatorContext';
import { computeMarketStructure } from './marketStructure';
import type { Candle } from './indicators';

// Read/advisory only — this module NEVER produces anything that gets
// parsed as a trade command. Its only output is a plain string (the
// model's post-mortem commentary), stored via lib/reflectionStore.server.ts
// and displayed on the trade detail page. It has no path back into
// executeTradeCommand(), agentEngine.ts, or any Config/execution code —
// per the Level 6 requirement, reflection cannot touch execution.

export type SnapshotLookup = (symbol: string, interval: string) => { candles: Candle[] } | undefined;

// Same compact one-liner used for both entry and exit snapshots, so a
// reflection prompt can compare like-for-like. Reuses the exact same
// pure compute functions Commits 1/9 already ship (computeIndicatorSnapshot,
// computeMarketStructure) — no new math invented for this.
export function captureContextSnapshot(symbol: string, getCandles: SnapshotLookup, timeframe: string = '1h'): string {
  const primary = getCandles(symbol, timeframe);
  if (!primary || primary.candles.length === 0) {
    return `${symbol}: no candle data available at this timeframe.`;
  }
  const indicators = computeIndicatorSnapshot(primary.candles);
  const structure = computeMarketStructure(primary.candles);

  const parts: string[] = [];
  if (indicators) {
    if (indicators.rsi14 !== null) parts.push(`RSI(14)=${indicators.rsi14.toFixed(1)}`);
    if (indicators.ema20 !== null && indicators.ema50 !== null) {
      parts.push(`EMA20 ${indicators.ema20 > indicators.ema50 ? '>' : '<'} EMA50`);
    }
    if (indicators.macd) parts.push(`MACD hist=${indicators.macd.histogram.toFixed(3)}`);
    if (indicators.atr14 !== null) parts.push(`ATR(14)=${indicators.atr14.toFixed(3)}`);
  } else {
    parts.push('insufficient history for indicators');
  }
  parts.push(`structure trend=${structure.currentTrend}`);
  if (structure.events.length > 0) {
    const lastEvent = structure.events[structure.events.length - 1];
    parts.push(`last structure event: ${lastEvent.type} (${lastEvent.direction})`);
  }

  return `${symbol} @ ${timeframe}: ${parts.join(', ')}.`;
}

export type ReflectionInput = {
  tradeId: string;
  symbol: string;
  tab: TradeTab;
  side: TradeSide; // side of the CLOSING trade
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  entryContext: string | null; // null = not captured (pre-dates this feature, or an imported/restored log)
  exitContext: string;
};

// Five explicit, labeled fields (Level 6: why lost, which indicator
// failed, could exit earlier, was confidence too high, should adjust) —
// forced into a fixed, parseable shape (parseReflectionSections below)
// rather than left as incidental free text, so the app can extract and
// surface each dimension on its own instead of hoping the model happened
// to touch on it somewhere in a paragraph.
const REFLECTION_SYSTEM_PROMPT = `You are a trading post-mortem analyst. You are given the entry and exit
details of one already-closed trade, plus the market context (indicators/structure) captured at both
moments. Your job is strictly retrospective analysis of this one trade — nothing else.

Hard rules:
- Do not suggest, recommend, or imply any new trade, position, or execution action.
- Do not output anything that looks like a trade command (no "buy"/"sell"/quantities as instructions).
- Do not discuss any symbol other than the one given.
- This is commentary only — it will be stored as a read-only note attached to the trade, never executed.

Respond in EXACTLY this format — five lines, each starting with the exact label shown (in capitals,
followed by a colon), one concise sentence per line, no extra commentary before/after/between them:
WHY: <why this trade won or lost, based on the entry vs. exit context given>
FAILED_SIGNAL: <which specific indicator/signal in the entry context (if any) turned out misleading or didn't hold up — say "none identified" if nothing specific stands out>
EARLIER_EXIT: <could this have been exited earlier or later for a better result, and why>
CONFIDENCE: <was the original confidence/conviction too high given how it played out — answer plainly>
LESSON: <one-sentence takeaway for next time>`;

export type ReflectionSections = {
  whyOutcome: string | null;
  failedSignal: string | null;
  earlierExit: string | null;
  confidenceAssessment: string | null;
  lesson: string | null;
};

const SECTION_LABELS: { key: keyof ReflectionSections; label: string }[] = [
  { key: 'whyOutcome', label: 'WHY' },
  { key: 'failedSignal', label: 'FAILED_SIGNAL' },
  { key: 'earlierExit', label: 'EARLIER_EXIT' },
  { key: 'confidenceAssessment', label: 'CONFIDENCE' },
  { key: 'lesson', label: 'LESSON' },
];

// Tolerant parser: if the model didn't follow the labeled format (or
// only partially did), whichever labels are found are still extracted;
// anything not found stays honestly null rather than guessed from
// surrounding prose. Never throws — a completely unparsed response
// just means every field is null and the UI falls back to the raw text.
export function parseReflectionSections(content: string): ReflectionSections {
  const result: ReflectionSections = { whyOutcome: null, failedSignal: null, earlierExit: null, confidenceAssessment: null, lesson: null };
  const labelPattern = SECTION_LABELS.map((s) => s.label).join('|');
  const re = new RegExp(`^(${labelPattern}):\\s*([\\s\\S]*?)(?=(?:\\n(?:${labelPattern}):)|$)`, 'gm');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const entry = SECTION_LABELS.find((s) => s.label === match![1]);
    if (entry) {
      const value = match[2].trim();
      if (value) result[entry.key] = value;
    }
  }
  return result;
}

export function buildReflectionMessages(input: ReflectionInput): { role: string; content: string }[] {
  const outcome = input.pnl >= 0 ? 'WIN' : 'LOSS';
  const user = [
    `Trade: ${input.side.toUpperCase()} ${input.qty} ${input.symbol} (${input.tab})`,
    `Entry price: ${input.entryPrice}`,
    `Exit price: ${input.exitPrice}`,
    `Realized P&L: ${input.pnl >= 0 ? '+' : ''}${input.pnl.toFixed(2)} (${outcome})`,
    `Entry context: ${input.entryContext ?? 'not captured — this trade was opened before entry-snapshotting existed, or came from an imported log. Answer question 1 using only the exit context and P&L outcome, and say plainly that entry context is unavailable.'}`,
    `Exit context: ${input.exitContext}`,
  ].join('\n');

  return [
    { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
