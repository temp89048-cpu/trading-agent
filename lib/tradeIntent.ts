import type { WatchItem } from './types';
import type { AgentMode, TradeSide, TradeTab } from './types';
import { resolveSymbol } from './symbolResolve';
import { isValidPlanCondition, type PlanCondition } from './plannerAgent';
import type { NewAgentSpec } from '../components/Agent';

export type TradeIntentTab = TradeTab;

// Detects a bare mention anywhere in the message — not just as a strict
// leading command — so "hey agent @real trade me the sol usdt with
// analysis..." triggers this path. If BOTH are mentioned, real wins
// (it's the more consequential ledger to be careful with).
export function detectTradeIntentTab(text: string): TradeIntentTab | null {
  if (/@real\b/i.test(text)) return 'real';
  if (/@papertrade\b/i.test(text)) return 'paper';
  return null;
}

// The bug this exists to fix: if the previous turn ended in "Didn't
// start an agent — confidence too low" and the user just replies "start
// agent" (no @tag repeated), the old code found no tag on THIS message,
// attached no instruction at all, and the model — completely
// ungoverned — free-styled an entire fake trade simulation in prose
// with invented prices and invented TP/SL triggers, none of which
// happened. This looks back at the conversation: if the last assistant
// message was clearly a pending/rejected trade decision, it reuses the
// tab from whichever earlier user message actually mentioned it, so the
// follow-up still gets governed by the same real trade-action /
// agent-action mechanism instead of the model improvising freely.
const PENDING_MARKERS = /Didn't start an agent|Didn't log a trade automatically/;

export function inferContinuationTab(recentMessages: { role: string; content: string }[]): TradeIntentTab | null {
  const lastAssistant = [...recentMessages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant || !PENDING_MARKERS.test(lastAssistant.content)) return null;

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const m = recentMessages[i];
    if (m.role !== 'user') continue;
    const tab = detectTradeIntentTab(m.content);
    if (tab) return tab;
  }
  return null;
}

// Appended as an extra system message only on requests that mention
// @real/@papertrade. Asks the model to do its normal analysis first,
// then emit ONE machine-readable block at the very end — either a
// single trade-action, or (for "take 5 trades", "every 2 minutes",
// "wait for TP then do the next one" style requests) an agent-action
// describing a repeating plan. Deliberately never asks the model for a
// price: it can't be trusted to use the exact live figure instead of a
// plausible-looking made-up one, and a wrong price would corrupt the
// log. The app computes every qty/price itself, and — critically for
// multi-trade requests — the app's own real clock decides WHEN each leg
// actually fires, never the model pretending time passed inside one reply.
export function buildTradeIntentInstruction(tab: TradeIntentTab): string {
  return `The user's message includes @${tab === 'real' ? 'real' : 'papertrade'}, meaning they want this conversation to end with something logged to their ${tab === 'real' ? 'Real' : 'Paper'} trade log, not just discussed.

Do your normal analysis first — market structure, patterns, support/resistance, whatever they asked for. Then, as the LAST thing in your reply, output exactly ONE fenced block — pick whichever of these two matches what they asked for:

**A single one-off trade** (they described one trade, once):
\`\`\`trade-action
{"tab":"${tab}","side":"buy","symbol":"SOL/USDT","marginUsd":2,"leverage":5,"confidence":0.8,"rationale":"one short reason"}
\`\`\`

**A repeating plan** (they said something like "take N trades", "every X minutes", "if TP hits then take the next one", "keep doing this"):
\`\`\`agent-action
{"tab":"${tab}","side":"buy","symbol":"SOL/USDT","totalTrades":5,"mode":"interval","intervalMinutes":2,"marginUsd":2,"leverage":5,"confidence":0.8,"rationale":"one short reason"}
\`\`\`
or, for "wait until it hits X% profit, then reinvest and take the next one":
\`\`\`agent-action
{"tab":"${tab}","side":"buy","symbol":"SOL/USDT","totalTrades":5,"mode":"take-profit","tpPercent":5,"slPercent":3,"marginUsd":2,"leverage":5,"confidence":0.8,"rationale":"one short reason"}
\`\`\`
or, for "if price drops to X, then watch for RSI/EMA condition Y, then enter" style conditional plans:
\`\`\`agent-action
{"tab":"${tab}","side":"buy","symbol":"SOL/USDT","totalTrades":1,"mode":"conditional-watch","triggerCondition":{"kind":"price-below","value":140},"watchCondition":{"kind":"rsi-above","value":40},"tpPercent":5,"slPercent":3,"marginUsd":2,"leverage":5,"confidence":0.8,"rationale":"one short reason"}
\`\`\`
or, for "if BTC reaches X, watch for breakout, if volume confirms enter" style plans:
\`\`\`agent-action
{"tab":"${tab}","side":"buy","symbol":"BTC/USDT","totalTrades":1,"mode":"conditional-watch","triggerCondition":{"kind":"price-above","value":118500},"watchCondition":{"kind":"volume-above-average","value":1.5},"tpPercent":5,"slPercent":3,"marginUsd":2,"leverage":5,"confidence":0.8,"rationale":"one short reason"}
\`\`\`
"triggerCondition" is required for conditional-watch (the app waits for this before doing anything). "watchCondition" is optional — omit it if the trigger itself should be the entry signal, include it for a genuine two-stage "wait for X, THEN watch for Y" plan. Valid condition "kind" values: "price-above", "price-below" (needs a numeric "value"), "rsi-above", "rsi-below" (needs a numeric "value", RSI(14)), "ema20-above-ema50", "ema20-below-ema50" (no "value" needed — compares the two EMAs' current state, not a detected crossover moment), "volume-above-average" (optional numeric "value" = multiplier of the 20-bar average volume required to confirm, defaults to 1.5x if omitted — real per-bar volume from the same candles, never invented). Always include "tpPercent" (and "slPercent" if the user wants a stop) for what happens once the plan actually enters — same fields as take-profit mode.

Optional advanced fields (agent-action only, take-profit/conditional-watch modes — omit all of these for the plain fixed-TP/SL behavior shown above):
- "trailingStopPercent": if the user wants the stop to trail behind price as it moves favorably ("trailing stop", "let it run and trail my stop") instead of staying fixed. A number, e.g. 2 for a 2% trail.
- "scaleOutLevels": for "take partial profit at X%, let the rest ride to Y%" style requests — an array of {"tpPercent": number, "closeFraction": number 0-1} in ascending tpPercent order, e.g. [{"tpPercent":2,"closeFraction":0.5},{"tpPercent":5,"closeFraction":0.5}]. closeFraction is the fraction of the ORIGINAL position size to close at that level. The stop automatically moves to breakeven after the first level fires.
- "useAtrStops": true if the user wants the stop/target to scale with the symbol's actual current volatility ("ATR-based stop", "volatility-adjusted") instead of a fixed percent — when true, "tpPercent"/"slPercent" are ignored in favor of "atrMultiplierTp"/"atrMultiplierSl" (each a number, default 2 and 1) times the live ATR.
- "requireSignalConfirmation": true if the user wants entries gated on the Strategy Ensemble and/or Debate System actually agreeing with the trade direction first ("only enter if the strategies agree", "wait for confirmation") rather than firing on schedule/condition alone. Optionally "minEnsembleConfidencePct" (default 55) and/or "minDebateConfidencePct" (only enforced if a Debate result already exists for the symbol) to require a specific confidence floor.

CRITICAL — you will NOT be asked again for each individual leg. You are setting up the whole plan right now, in this one reply. Do not narrate "let's wait 2 minutes" and then pretend the wait happened and invent a second trade yourself — you have no way to actually know what happens after this reply ends. The app's own clock and live price feed run each leg for real, at the real time or the real TP threshold, and will tell the user about each one as it actually happens. Your job is only to set the plan's parameters correctly, once.

Rules for both block types:
- "side" is "buy" to open/add, or "sell" to close/reduce (agent-action only supports "buy" plans — a real repeating short/close plan isn't something this app models).
- "symbol" should match a symbol already on the user's watchlist if one clearly corresponds (e.g. "sol usdt" -> "SOL/USDT"); otherwise your best guess at the ticker.
- Give EITHER "marginUsd" + "leverage" (app computes size as marginUsd × leverage ÷ its own live price) OR a plain "qty" on trade-action if they stated a size directly instead. Default leverage to 1 if unmentioned.
- agent-action "totalTrades" must be a whole number: 2-50 for "interval"/"take-profit" mode, or 1-50 for "conditional-watch" mode (a single "wait for this, then enter once" plan is valid there). "mode" is "interval" (fires every intervalMinutes, fixed size each leg), "take-profit" (opens, waits for real price to move tpPercent in favor, closes, then opens the next leg sized from the original margin PLUS whatever's been realized so far — i.e. it compounds), or "conditional-watch" (waits for triggerCondition, optionally then watchCondition, before opening — see above).
- "confidence" is your own 0-1 estimate of how sure you are you understood the request correctly. Ambiguous size/symbol/direction -> use a low confidence (below 0.5) rather than guessing; the app skips logging/starting anything below that and just shows your analysis instead.
- If you cannot determine even roughly what to log/start, output {"tab":"${tab}","error":"why not"} instead (works for either block type) and nothing will be logged or started.
- Always output a block, even at low confidence — that's how the app knows not to act, versus you forgetting entirely.`;
}

export type TradeIntent =
  | { tab: TradeIntentTab; side: TradeSide; symbol: string; marginUsd?: number; leverage?: number; qty?: number; confidence: number; rationale?: string }
  | { tab: TradeIntentTab; error: string };

export type AgentIntent =
  | {
      tab: TradeIntentTab;
      side: TradeSide;
      symbol: string;
      totalTrades: number;
      mode: AgentMode;
      intervalMinutes?: number;
      tpPercent?: number;
      slPercent?: number;
      triggerCondition?: PlanCondition;
      watchCondition?: PlanCondition;
      marginUsd: number;
      leverage: number;
      confidence: number;
      rationale?: string;
      trailingStopPercent?: number;
      scaleOutLevels?: { tpPercent: number; closeFraction: number }[];
      useAtrStops?: boolean;
      atrMultiplierTp?: number;
      atrMultiplierSl?: number;
      requireSignalConfirmation?: boolean;
      minEnsembleConfidencePct?: number;
      minDebateConfidencePct?: number;
    }
  | { tab: TradeIntentTab; error: string };

// Loose structural validation only (same spirit as isValidPlanCondition)
// — the model's JSON is untrusted input, never assumed well-formed.
function isValidScaleOutLevels(value: unknown): value is { tpPercent: number; closeFraction: number }[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (lvl) =>
      lvl && typeof lvl === 'object' &&
      typeof (lvl as any).tpPercent === 'number' && (lvl as any).tpPercent > 0 &&
      typeof (lvl as any).closeFraction === 'number' && (lvl as any).closeFraction > 0 && (lvl as any).closeFraction <= 1,
  );
}

export type ExtractedIntent = { kind: 'trade'; intent: TradeIntent } | { kind: 'agent'; intent: AgentIntent } | null;

// Pulls the trailing ```trade-action or ```agent-action fenced block out
// of the model's full response, parses+loosely validates it, and returns
// both the parsed intent and the display text with that block removed
// (the user should see clean analysis + our own confirmation, never raw
// JSON).
export function extractTradeIntent(fullText: string): { extracted: ExtractedIntent; displayText: string } {
  const match = fullText.match(/```(trade-action|agent-action)\s*([\s\S]*?)```/i);
  if (!match) return { extracted: null, displayText: fullText };

  const displayText = (fullText.slice(0, match.index) + fullText.slice(match.index! + match[0].length)).trim();
  const kind: 'trade' | 'agent' = match[1].toLowerCase() === 'agent-action' ? 'agent' : 'trade';

  let parsed: any;
  try {
    parsed = JSON.parse(match[2].trim());
  } catch {
    return { extracted: null, displayText };
  }

  if (parsed.error) {
    return { extracted: { kind, intent: { tab: parsed.tab, error: String(parsed.error) } } as ExtractedIntent, displayText };
  }
  if (parsed.tab !== 'paper' && parsed.tab !== 'real') return { extracted: null, displayText };
  if (parsed.side !== 'buy' && parsed.side !== 'sell') return { extracted: null, displayText };
  if (!parsed.symbol || typeof parsed.symbol !== 'string') return { extracted: null, displayText };
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

  if (kind === 'trade') {
    return {
      extracted: {
        kind: 'trade',
        intent: {
          tab: parsed.tab,
          side: parsed.side,
          symbol: parsed.symbol,
          marginUsd: typeof parsed.marginUsd === 'number' ? parsed.marginUsd : undefined,
          leverage: typeof parsed.leverage === 'number' ? parsed.leverage : undefined,
          qty: typeof parsed.qty === 'number' ? parsed.qty : undefined,
          confidence,
          rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
        },
      },
      displayText,
    };
  }

  const totalTrades = Math.round(parsed.totalTrades);
  const mode: AgentMode = parsed.mode === 'take-profit' ? 'take-profit' : parsed.mode === 'conditional-watch' ? 'conditional-watch' : 'interval';
  return {
    extracted: {
      kind: 'agent',
      intent: {
        tab: parsed.tab,
        side: parsed.side,
        symbol: parsed.symbol,
        totalTrades,
        mode,
        intervalMinutes: typeof parsed.intervalMinutes === 'number' ? parsed.intervalMinutes : undefined,
        tpPercent: typeof parsed.tpPercent === 'number' ? parsed.tpPercent : undefined,
        slPercent: typeof parsed.slPercent === 'number' ? parsed.slPercent : undefined,
        triggerCondition: isValidPlanCondition(parsed.triggerCondition) ? parsed.triggerCondition : undefined,
        watchCondition: isValidPlanCondition(parsed.watchCondition) ? parsed.watchCondition : undefined,
        marginUsd: typeof parsed.marginUsd === 'number' ? parsed.marginUsd : 0,
        leverage: typeof parsed.leverage === 'number' ? parsed.leverage : 1,
        confidence,
        rationale: typeof parsed.rationale === 'string' ? parsed.rationale : undefined,
        trailingStopPercent: typeof parsed.trailingStopPercent === 'number' ? parsed.trailingStopPercent : undefined,
        scaleOutLevels: isValidScaleOutLevels(parsed.scaleOutLevels) ? parsed.scaleOutLevels : undefined,
        useAtrStops: parsed.useAtrStops === true,
        atrMultiplierTp: typeof parsed.atrMultiplierTp === 'number' ? parsed.atrMultiplierTp : undefined,
        atrMultiplierSl: typeof parsed.atrMultiplierSl === 'number' ? parsed.atrMultiplierSl : undefined,
        requireSignalConfirmation: parsed.requireSignalConfirmation === true,
        minEnsembleConfidencePct: typeof parsed.minEnsembleConfidencePct === 'number' ? parsed.minEnsembleConfidencePct : undefined,
        minDebateConfidencePct: typeof parsed.minDebateConfidencePct === 'number' ? parsed.minDebateConfidencePct : undefined,
      },
    },
    displayText,
  };
}

const MIN_CONFIDENCE = 0.5;

export type ResolvedTrade =
  | { ok: true; tab: TradeIntentTab; side: TradeSide; symbol: string; qty: number; price: number; note: string }
  | { ok: false; reason: string };

// Turns a validated-but-still-untrusted TradeIntent into actual numbers,
// using ONLY the app's own live ticks for price — never anything the
// model said. This is the safety gate: low confidence, an unresolvable
// symbol, or a missing live price all bail out to "don't log" rather
// than guessing.
export function resolveTradeIntent(intent: TradeIntent, watchlist: WatchItem[], ticks: Record<string, { price: number }>): ResolvedTrade {
  if ('error' in intent) return { ok: false, reason: intent.error };
  if (intent.confidence < MIN_CONFIDENCE) {
    return { ok: false, reason: `confidence too low (${intent.confidence.toFixed(2)}) to auto-log — ambiguous request` };
  }

  const symbol = resolveSymbol(intent.symbol, watchlist);
  const price = ticks[symbol]?.price;
  if (!price) {
    return { ok: false, reason: `no live price available for ${symbol} — add it to the watchlist first` };
  }

  let qty: number | undefined = intent.qty;
  let sizeNote = '';
  if (qty === undefined && intent.marginUsd !== undefined) {
    const leverage = intent.leverage ?? 1;
    const notional = intent.marginUsd * leverage;
    qty = notional / price;
    sizeNote = ` (notional $${notional.toLocaleString(undefined, { maximumFractionDigits: 2 })} = $${intent.marginUsd} margin × ${leverage}x leverage — this app tracks position size only, not real margin/liquidation mechanics)`;
  }
  if (!qty || qty <= 0 || !isFinite(qty)) {
    return { ok: false, reason: 'could not determine a position size (no quantity, and no margin+leverage, given)' };
  }

  const note = `auto-logged from agent analysis${intent.rationale ? ` — ${intent.rationale}` : ''}${sizeNote}`;
  return { ok: true, tab: intent.tab, side: intent.side, symbol, qty, price, note };
}

export type ResolvedAgentSpec = { ok: true; spec: NewAgentSpec } | { ok: false; reason: string };

// Same safety gate philosophy as resolveTradeIntent, but for a repeating
// plan: validates ranges (no 10,000-trade runaway plans, no 0-minute
// intervals hammering the tick loop) and resolves the symbol against the
// watchlist. Does NOT require a live price up front — the real-time
// engine checks that on every tick once the plan is running, and simply
// won't fire a leg until a price is actually available.
export function resolveAgentIntent(intent: AgentIntent, watchlist: WatchItem[]): ResolvedAgentSpec {
  if ('error' in intent) return { ok: false, reason: intent.error };
  if (intent.confidence < MIN_CONFIDENCE) {
    return { ok: false, reason: `confidence too low (${intent.confidence.toFixed(2)}) to start an agent — ambiguous request` };
  }
  const minTotalTrades = intent.mode === 'conditional-watch' ? 1 : 2;
  if (!Number.isFinite(intent.totalTrades) || intent.totalTrades < minTotalTrades || intent.totalTrades > 50) {
    return { ok: false, reason: `totalTrades must be between ${minTotalTrades} and 50 (got ${intent.totalTrades})` };
  }
  if (intent.side !== 'buy') {
    return { ok: false, reason: 'agent plans only support "buy" legs in this app' };
  }
  if (intent.mode === 'interval') {
    if (!intent.intervalMinutes || intent.intervalMinutes <= 0 || intent.intervalMinutes > 1440) {
      return { ok: false, reason: 'intervalMinutes must be a positive number, up to 1440 (24h)' };
    }
  } else if (intent.mode === 'take-profit') {
    if (!intent.tpPercent || intent.tpPercent <= 0 || intent.tpPercent > 100) {
      return { ok: false, reason: 'tpPercent must be a positive percentage up to 100' };
    }
  } else {
    // conditional-watch
    if (!intent.triggerCondition) {
      return { ok: false, reason: 'conditional-watch plans need a triggerCondition' };
    }
    if (!intent.tpPercent || intent.tpPercent <= 0 || intent.tpPercent > 100) {
      return { ok: false, reason: 'tpPercent must be a positive percentage up to 100 (what happens once the plan actually enters)' };
    }
  }
  if (!intent.marginUsd || intent.marginUsd <= 0) {
    return { ok: false, reason: 'marginUsd must be a positive amount' };
  }
  if (intent.trailingStopPercent !== undefined && (intent.trailingStopPercent <= 0 || intent.trailingStopPercent > 100)) {
    return { ok: false, reason: 'trailingStopPercent must be a positive percentage up to 100' };
  }
  if (intent.scaleOutLevels !== undefined) {
    const totalFraction = intent.scaleOutLevels.reduce((sum, lvl) => sum + lvl.closeFraction, 0);
    if (totalFraction > 1.0001) {
      return { ok: false, reason: 'scaleOutLevels closeFractions must sum to at most 1 (100% of the position)' };
    }
    const ascending = intent.scaleOutLevels.every((lvl, i) => i === 0 || lvl.tpPercent > intent.scaleOutLevels![i - 1].tpPercent);
    if (!ascending) {
      return { ok: false, reason: 'scaleOutLevels must be in strictly ascending tpPercent order' };
    }
  }
  if (intent.useAtrStops) {
    if (intent.atrMultiplierTp !== undefined && intent.atrMultiplierTp <= 0) {
      return { ok: false, reason: 'atrMultiplierTp must be positive' };
    }
    if (intent.atrMultiplierSl !== undefined && intent.atrMultiplierSl <= 0) {
      return { ok: false, reason: 'atrMultiplierSl must be positive' };
    }
  }
  if (intent.minEnsembleConfidencePct !== undefined && (intent.minEnsembleConfidencePct < 0 || intent.minEnsembleConfidencePct > 100)) {
    return { ok: false, reason: 'minEnsembleConfidencePct must be between 0 and 100' };
  }
  if (intent.minDebateConfidencePct !== undefined && (intent.minDebateConfidencePct < 0 || intent.minDebateConfidencePct > 100)) {
    return { ok: false, reason: 'minDebateConfidencePct must be between 0 and 100' };
  }

  const symbol = resolveSymbol(intent.symbol, watchlist);
  return {
    ok: true,
    spec: {
      tab: intent.tab,
      symbol,
      side: intent.side,
      marginUsd: intent.marginUsd,
      leverage: intent.leverage || 1,
      totalTrades: intent.totalTrades,
      mode: intent.mode,
      intervalMinutes: intent.intervalMinutes,
      tpPercent: intent.tpPercent,
      slPercent: intent.slPercent,
      triggerCondition: intent.triggerCondition,
      watchCondition: intent.watchCondition,
      rationale: intent.rationale,
      trailingStopPercent: intent.trailingStopPercent,
      scaleOutLevels: intent.scaleOutLevels,
      useAtrStops: intent.useAtrStops,
      atrMultiplierTp: intent.atrMultiplierTp,
      atrMultiplierSl: intent.atrMultiplierSl,
      requireSignalConfirmation: intent.requireSignalConfirmation,
      minEnsembleConfidencePct: intent.minEnsembleConfidencePct,
      minDebateConfidencePct: intent.minDebateConfidencePct,
    },
  };
}
