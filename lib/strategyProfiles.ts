import type { RegimeLabel } from './marketRegime';

// ---------------------------------------------------------------------
// Strategy Profiles — the engineering spec's Section 11.3 template,
// declared IN CODE rather than only in prose.
//
// Why in code: the spec says "no strategy goes live without every field
// filled in and validated." A markdown table can't enforce that, and it
// drifts from the implementation the moment either changes. Declared here,
// the profile is type-checked, greppable, assertable in tests, and — most
// importantly — actually USABLE: `activeRegimes` is what lets the
// ensemble gate a strategy off when its conditions aren't present, which
// is the whole point of the "market regime fit" field.
//
// HONESTY RULE for `historicalSuccessRate`: this app has no live track
// record, and a backtest number pasted here would be presented as
// something it isn't. Every entry is therefore `null`, with the meaning
// "not established" rather than "zero". Populate it only from real
// recorded results, and only through the Section 12 validation pipeline.
// ---------------------------------------------------------------------

export type HoldingTimeframe = 'seconds-minutes' | 'minutes-hours' | 'hours-days' | 'days-weeks' | 'weeks-months';

/** Whether the strategy can actually be ACTED on, distinct from whether it can form an opinion. */
export type ExecutionStatus =
  | 'executable' // this app can place the orders this strategy requires
  | 'advisory-only' // can vote, but this app cannot execute its mechanics
  | 'planned'; // not implemented at all

export type StrategyProfile = {
  /** Must match the `agent` string the strategy's signal returns, so profile and signal can be joined. */
  agent: string;
  bestConditions: string;
  worstConditions: string;
  holdingTimeframe: HoldingTimeframe;
  /** Typical reward:risk this strategy targets. */
  targetRewardRisk: number;
  indicatorsUsed: string[];
  entryLogic: string;
  exitLogic: string;
  positionSizingRule: string;
  /** Regimes in which this strategy is allowed to cast a directional vote. */
  activeRegimes: RegimeLabel[];
  /** null = not established. NEVER populate from a backtest and present as live. */
  historicalSuccessRate: number | null;
  /** Minimum own-confidence for this strategy's vote to count at all. */
  minConfidence: number;
  maxConcurrentPositions: number;
  /** Documented ways this approach fails — the field most often skipped and most useful. */
  failureModes: string[];
  selfEvaluation: string;
  executionStatus: ExecutionStatus;
};

const ALL_TRENDING: RegimeLabel[] = ['strong-bull', 'weak-bull', 'strong-bear', 'weak-bear'];

export const STRATEGY_PROFILES: StrategyProfile[] = [
  {
    agent: 'Trend Following',
    bestConditions: 'A confirmed directional structure (HH/HL or LL/LH) that multiple timeframes agree on.',
    worstConditions: 'Ranging or compressing markets, where every apparent trend reverses before it pays.',
    holdingTimeframe: 'hours-days',
    targetRewardRisk: 2,
    indicatorsUsed: ['market structure (HH/HL/LL/LH)', 'multi-timeframe trend rollup', 'EMA50'],
    entryLogic: 'Structure trend, MTF rollup, and price-vs-EMA50 must all agree on direction.',
    exitLogic: 'ATR-derived stop (structural swing level when available); 2R target; trailing once in profit.',
    positionSizingRule: 'Fixed-fractional off the computed stop distance, Kelly-capped.',
    activeRegimes: ALL_TRENDING,
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 3,
    failureModes: [
      'Whipsaws in a range: structure flips repeatedly, producing a string of small losses.',
      'Late entry after a trend is already extended, buying the final leg.',
      'Multi-timeframe agreement is a lagging condition — by the time all frames align, much of the move is gone.',
    ],
    selfEvaluation: 'Compare realized R against the 2R target, and win rate specifically within trending regimes rather than overall.',
    executionStatus: 'executable',
  },
  {
    agent: 'Momentum',
    bestConditions: 'Strong directional moves with expanding participation.',
    worstConditions: 'Low-volatility chop; exhausted moves near a reversal.',
    holdingTimeframe: 'minutes-hours',
    targetRewardRisk: 2,
    indicatorsUsed: ['RSI', 'MACD histogram', 'volume'],
    entryLogic: 'Momentum indicators confirm direction with participation behind it.',
    exitLogic: 'ATR stop; exit on momentum divergence or target.',
    positionSizingRule: 'Fixed-fractional, reduced when volatility is elevated.',
    activeRegimes: ['strong-bull', 'strong-bear', 'weak-bull', 'weak-bear'],
    historicalSuccessRate: null,
    minConfidence: 0.55,
    maxConcurrentPositions: 3,
    failureModes: [
      'Buys climax moves at the point of exhaustion.',
      'RSI stays "overbought" for the entire best part of a strong trend, so the signal mistimes exits.',
    ],
    selfEvaluation: 'Track how often entries occur in the final third of a move (a proxy for late entry).',
    executionStatus: 'executable',
  },
  {
    agent: 'Scalping',
    bestConditions: 'High liquidity, tight spreads, enough short-term volatility to cover costs.',
    worstConditions: 'Wide spreads or thin books — costs exceed the edge. Also unsuitable here structurally (see failure modes).',
    holdingTimeframe: 'seconds-minutes',
    targetRewardRisk: 1,
    indicatorsUsed: ['short-period EMA', 'RSI', 'order-flow pressure', 'spread'],
    entryLogic: 'Short-term mean deviation with order-flow confirmation.',
    exitLogic: 'Tight fixed target/stop; time-based exit if neither hits.',
    positionSizingRule: 'Fixed-fractional with a hard cap — high trade count means correlated repeated risk.',
    activeRegimes: ['ranging', 'weak-bull', 'weak-bear'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 1,
    failureModes: [
      'THIS APP IS STRUCTURALLY UNSUITED TO TRUE SCALPING: the agent tick loop runs every 3 seconds and market orders cross the spread. Real scalping needs sub-second latency and limit orders.',
      'Fees and slippage dominate a 1R target — the strategy can be signal-correct and still lose money.',
    ],
    selfEvaluation: 'Compare gross vs net P&L; if fees/slippage consume most of the edge, the strategy is not viable here regardless of win rate.',
    executionStatus: 'advisory-only',
  },
  {
    agent: 'Swing Trading',
    bestConditions: 'Established trend with clean pullbacks to a level.',
    worstConditions: 'Choppy, newsy conditions where levels do not hold.',
    holdingTimeframe: 'days-weeks',
    targetRewardRisk: 3,
    indicatorsUsed: ['market structure', 'EMA20/50', 'higher-timeframe trend'],
    entryLogic: 'Pullback into a structural level while the higher-timeframe trend remains intact.',
    exitLogic: 'Structural stop below the pullback low; 3R target; partial scale-out.',
    positionSizingRule: 'Fixed-fractional off a wider structural stop, so size is naturally smaller.',
    activeRegimes: ALL_TRENDING,
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 3,
    failureModes: [
      'Overnight/weekend gap risk — this app cannot place resting stops on the exchange, so a gap through the stop is unprotected.',
      'A pullback that becomes a reversal looks identical at entry.',
    ],
    selfEvaluation: 'Track how often the structural stop was gapped through rather than cleanly hit.',
    executionStatus: 'executable',
  },
  {
    agent: 'Mean Reversion',
    bestConditions: 'Range-bound markets with statistically stretched excursions from the mean.',
    worstConditions: 'Strong trends — "stretched" is the normal state of a trend, and fading it is how accounts die.',
    holdingTimeframe: 'minutes-hours',
    targetRewardRisk: 1.5,
    indicatorsUsed: ['Bollinger Bands', 'RSI', 'VWAP'],
    entryLogic: 'Price at a statistical extreme with no confirmed trend in that direction.',
    exitLogic: 'Target the mean (middle band/VWAP); stop beyond the extreme.',
    positionSizingRule: 'Fixed-fractional, reduced because reversion trades often need to survive further adverse movement.',
    // The single most important gate in this file: mean reversion is
    // explicitly barred from strong trends.
    activeRegimes: ['ranging', 'compression'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 2,
    failureModes: [
      'Fading a genuine trend: unbounded loss potential against a bounded target.',
      'Wins are small and frequent while losses are large and rare, so a healthy-looking win rate can still be net negative.',
    ],
    selfEvaluation: 'Average loss vs average win must be tracked, not win rate — this strategy is designed to have a high win rate and can still lose.',
    executionStatus: 'executable',
  },
  {
    agent: 'Breakout',
    bestConditions: 'Compressed range with volume expanding on the break.',
    worstConditions: 'Already-extended trends (late break), or low-volume fake breaks.',
    holdingTimeframe: 'hours-days',
    targetRewardRisk: 2.5,
    indicatorsUsed: ['range highs/lows', 'ATR compression', 'volume', 'liquidity levels'],
    entryLogic: 'Break of a defined range boundary with volume confirmation.',
    exitLogic: 'Stop back inside the range; measured-move target.',
    positionSizingRule: 'Fixed-fractional off the range boundary as the stop.',
    activeRegimes: ['compression', 'ranging', 'weak-bull', 'weak-bear'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 2,
    failureModes: [
      'False breakouts — the most common failure, especially without volume confirmation.',
      'Slippage on entry is worst exactly when breakouts are real and fast.',
    ],
    selfEvaluation: 'Track the false-break rate and entry slippage separately; a good signal with bad fills is an execution problem, not a strategy one.',
    executionStatus: 'executable',
  },
  {
    agent: 'Range Trading',
    bestConditions: 'Clearly defined, repeatedly respected support and resistance.',
    worstConditions: 'Trending or breaking markets.',
    holdingTimeframe: 'minutes-hours',
    targetRewardRisk: 1.5,
    indicatorsUsed: ['support/resistance levels', 'volume profile value area', 'RSI'],
    entryLogic: 'Enter near a range edge that has held before, toward the opposite edge.',
    exitLogic: 'Target the opposing edge; stop on a confirmed break of the entry edge.',
    positionSizingRule: 'Fixed-fractional off the range-edge stop.',
    activeRegimes: ['ranging', 'compression'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 2,
    failureModes: [
      'The range breaks, which it eventually always does — a range strategy without a break rule is a losing strategy.',
      'Ranges are only identifiable in hindsight; an emerging trend looks like a range edge.',
    ],
    selfEvaluation: 'Track P&L specifically on the trade that coincided with the range breaking.',
    executionStatus: 'executable',
  },
  {
    // Must match the string runGridAgent() emits exactly, or the profile
    // never joins to the signal and the strategy silently escapes regime
    // gating. Guarded by a test that runs the real ensemble and asserts
    // every emitted agent has a profile.
    agent: 'Grid Strategy',
    bestConditions: 'Sideways, mean-reverting markets with steady volatility.',
    worstConditions: 'Trending markets — a grid accumulates against a sustained move.',
    holdingTimeframe: 'hours-days',
    targetRewardRisk: 1,
    indicatorsUsed: ['range boundaries', 'ATR', 'volume profile'],
    entryLogic: 'Would place laddered orders across a range. Currently only ASSESSES whether conditions favor a grid.',
    exitLogic: 'Would close each rung at the next level up/down.',
    positionSizingRule: 'Total grid exposure capped as one position for risk purposes.',
    activeRegimes: ['ranging', 'compression'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 1,
    failureModes: [
      'A trend runs through the whole grid, leaving maximum exposure at the worst price.',
      'Requires many simultaneous resting limit orders, which this app cannot place.',
    ],
    selfEvaluation: 'Not evaluable from live results — never executed. Always abstains (HOLD).',
    executionStatus: 'advisory-only',
  },
  {
    agent: 'Arbitrage',
    bestConditions: 'A real, persistent price dislocation between venues exceeding fees plus transfer cost.',
    worstConditions: 'Spreads inside fee cost — the apparent edge is an illusion.',
    holdingTimeframe: 'seconds-minutes',
    targetRewardRisk: 1,
    indicatorsUsed: ['cross-exchange price aggregation'],
    entryLogic: 'Votes directionally off a real detected cross-venue spread.',
    exitLogic: 'Would close when the spread converges.',
    positionSizingRule: 'Bounded by the smaller venue depth.',
    activeRegimes: ['strong-bull', 'weak-bull', 'strong-bear', 'weak-bear', 'ranging', 'compression'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 1,
    failureModes: [
      'True arbitrage needs simultaneous two-venue execution and inventory on both; this app trades one venue at a time, so the "arbitrage" cannot actually be captured.',
      'Observed spreads are frequently stale-quote artifacts rather than tradable.',
    ],
    selfEvaluation: 'Not evaluable — the mechanic is never executed. Directional votes only.',
    executionStatus: 'advisory-only',
  },
  {
    agent: 'Smart Money (SMC/ICT)',
    bestConditions: 'A liquidity sweep (stops taken) followed by a BOS/CHoCH confirming direction, with price back in the favourable discount/premium zone.',
    worstConditions: 'Ranging markets with no clean structural breaks — every minor high/low looks like a sweep.',
    holdingTimeframe: 'hours-days',
    targetRewardRisk: 3,
    indicatorsUsed: ['market structure (BOS/CHoCH)', 'liquidity zones and sweeps', 'premium/discount range position'],
    entryLogic: 'Liquidity sweep near the broken swing, then a BOS/CHoCH in the same direction; highest conviction when price is also in the discount (long) or premium (short) half of the structural range.',
    exitLogic: 'Stop beyond the swept level (where the thesis is invalidated); 3R target.',
    positionSizingRule: 'Fixed-fractional off the swept-level stop.',
    activeRegimes: ALL_TRENDING,
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 2,
    failureModes: [
      'SMC/ICT terminology is loosely defined and easy to fit to any chart after the fact — the sweep-then-break SEQUENCE is enforced here precisely to avoid that.',
      'Order blocks and fair value gaps are deliberately NOT approximated from 1h candles: doing so would produce plausible-looking levels that are not what the terms actually mean.',
      'A CHoCH without a preceding sweep is frequently just a failed continuation, not a real character change.',
    ],
    selfEvaluation: 'Track win rate specifically on the full-sequence setups vs the late-entry ones; if they are indistinguishable, the sequence filter is not adding value.',
    executionStatus: 'executable',
  },
  {
    agent: 'VWAP',
    bestConditions: 'Trending: a pullback to VWAP in the trend direction. Ranging: a stretched excursion away from VWAP.',
    worstConditions: 'Fading a stretched move during a strong trend — the documented way this strategy loses.',
    holdingTimeframe: 'minutes-hours',
    targetRewardRisk: 2,
    indicatorsUsed: ['VWAP', 'market structure trend'],
    entryLogic: 'If structure confirms a trend, buy/sell pullbacks that reach VWAP. If not, revert excursions beyond 1.5% from VWAP back toward it.',
    exitLogic: 'Trend mode: ATR stop, target the prior extreme. Reversion mode: target VWAP, stop beyond the excursion.',
    positionSizingRule: 'Fixed-fractional; smaller in reversion mode since those trades often need to survive further adverse movement.',
    activeRegimes: ['strong-bull', 'weak-bull', 'strong-bear', 'weak-bear', 'ranging'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 2,
    failureModes: [
      'Using the reversion reading during a trend. Guarded twice: the agent itself refuses to fade a confirmed trend, and the regime gate is a second layer.',
      'VWAP is session-anchored in its classic form; this uses the cached candle window instead, which is an approximation of a session anchor.',
    ],
    selfEvaluation: 'Separate win rates for trend-pullback vs reversion entries — they are different strategies sharing an indicator.',
    executionStatus: 'executable',
  },
  {
    agent: 'Volume Profile',
    bestConditions: 'Price at a value-area edge in a range, or traversing a low-volume node with structure supplying direction.',
    worstConditions: 'Trending markets at value-area edges — in a trend, edges break more often than they hold.',
    holdingTimeframe: 'minutes-hours',
    targetRewardRisk: 2,
    indicatorsUsed: ['POC', 'value area high/low', 'low-volume nodes'],
    entryLogic: 'Range: fade the value-area edge toward POC. Trend: enter as price enters a low-volume node in the trend direction.',
    exitLogic: 'Range: target POC. Trend: ATR stop; thin-node traversal is expected to be fast, so a time-based exit applies if it stalls.',
    positionSizingRule: 'Fixed-fractional off the value-area edge or node boundary.',
    activeRegimes: ['ranging', 'compression', 'weak-bull', 'weak-bear'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 2,
    failureModes: [
      'The profile is built from the cached candle window, not a true session/composite profile — levels shift as the window rolls.',
      'A low-volume node predicts SPEED, not direction; acting on one without structural direction is a coin flip, so the agent abstains in that case.',
    ],
    selfEvaluation: 'Track how often value-area edges held vs broke, split by regime — that ratio is what justifies the regime gate.',
    executionStatus: 'executable',
  },
  {
    agent: 'Volatility',
    bestConditions: 'Volatility expanding from a contracted base WITH structure already confirming direction.',
    worstConditions: 'Extreme expansion (a spike) — entering into one tends to get stopped before the move resolves.',
    holdingTimeframe: 'hours-days',
    targetRewardRisk: 2,
    indicatorsUsed: ['ATR (recent vs its own longer baseline)', 'market structure trend'],
    entryLogic: 'Participate in the direction of an underway expansion when structure agrees. Abstain during a squeeze (direction unknown) and during extremes.',
    exitLogic: 'ATR stop, widened to match the elevated volatility so it is not immediately noise-stopped.',
    positionSizingRule: 'Fixed-fractional off the widened ATR stop — higher volatility therefore produces a SMALLER position for the same dollar risk.',
    activeRegimes: ['strong-bull', 'weak-bull', 'strong-bear', 'weak-bear', 'compression'],
    historicalSuccessRate: null,
    minConfidence: 0.6,
    maxConcurrentPositions: 2,
    failureModes: [
      'This is NOT true volatility trading — that requires options/VIX instruments this app cannot trade (see PLANNED_STRATEGIES). It is directional positioning informed by volatility regime, and should not be mistaken for the former.',
      'Volatility clustering means expansion often continues past a reasonable stop; the widened stop mitigates but does not remove this.',
    ],
    selfEvaluation: 'Compare realized R in expanding vs normal volatility; if the widened stops erase the edge, the premise fails.',
    executionStatus: 'executable',
  },
];

// ---------------------------------------------------------------------
// Strategies the spec lists that are NOT implemented, each with the
// actual blocker. Listed rather than omitted so the gap is visible —
// same PLANNED_AGENTS honesty pattern already used in
// lib/strategyEnsemble.ts and lib/eventDetection.ts.
// ---------------------------------------------------------------------
export type PlannedStrategy = { name: string; blocker: string; wouldRequire: string[] };

export const PLANNED_STRATEGIES: PlannedStrategy[] = [
  {
    name: 'Market Making',
    blocker: 'Requires resting two-sided limit orders and inventory management. This app only sends market orders.',
    wouldRequire: ['limit order support in lib/exchangeClients', 'open-order tracking and cancel/replace', 'inventory risk model'],
  },
  {
    name: 'Basis Trading',
    blocker: 'Requires simultaneous spot and futures positions. This app is spot-only by deliberate scope (see REAL_TRADING.md).',
    wouldRequire: ['futures connector', 'margin/liquidation mechanics', 'funding accrual accounting'],
  },
  {
    name: 'Gamma Squeeze Detection',
    blocker: 'Requires options open-interest and dealer-positioning data. No options data source is wired up.',
    wouldRequire: ['options chain data provider', 'gamma exposure modeling'],
  },
  {
    name: 'Liquidation Trading',
    blocker: 'Requires a real-time forced-liquidation feed. Only an open-interest-drop PROXY exists (lib/eventDetection.ts).',
    wouldRequire: ['exchange liquidation websocket', 'liquidation heatmap data'],
  },
  {
    name: 'Macro Trading',
    blocker: 'Requires an economic calendar and macro data series. Neither is wired up (see lib/newsProviders.ts gaps).',
    wouldRequire: ['economic calendar provider', 'rates/DXY/yield data'],
  },
  {
    name: 'True Volatility Trading (options/VIX)',
    blocker: 'Taking a position on volatility itself requires options or VIX-style instruments. This app trades spot direction only. The implemented "Volatility" agent is directional positioning informed by volatility regime — a different thing, and labelled as such.',
    wouldRequire: ['options/derivatives connector', 'implied-volatility surface data', 'multi-leg order support'],
  },
  {
    name: 'Statistical Arbitrage / Pairs Trading',
    blocker: 'Needs simultaneous long/short legs in two correlated instruments. This app is spot long-only per position and cannot short, so the market-neutral spread cannot be constructed. The correlation matrix needed for pair SELECTION already exists (lib/portfolioIntelligence.ts).',
    wouldRequire: ['short selling or margin', 'simultaneous two-leg execution', 'cointegration/spread z-score modeling'],
  },
  {
    name: 'Wyckoff Method',
    blocker: 'Phase identification (accumulation/distribution/spring/upthrust) needs volume-at-price over multi-week windows; the candle cache is shorter-horizon.',
    wouldRequire: ['longer historical candle retention', 'volume-at-price series per phase'],
  },
];

// ---------------------------------------------------------------------
// Lookup + gating
// ---------------------------------------------------------------------

export function getStrategyProfile(agent: string): StrategyProfile | undefined {
  return STRATEGY_PROFILES.find((p) => p.agent === agent);
}

/**
 * Whether a strategy may cast a DIRECTIONAL vote in the current regime.
 *
 * An unsuited strategy is not silenced entirely — it abstains (HOLD),
 * which is meaningfully different: the ensemble still sees that it was
 * consulted and declined, and the reason is recorded. Silently dropping
 * it would make the vote count change without explanation.
 *
 * An unknown regime permits everything: refusing to trade because
 * classification is uninformative would be a different (and unjustified)
 * behavior change from what existed before regime gating.
 */
export function isStrategyActiveInRegime(agent: string, regime: RegimeLabel): boolean {
  if (regime === 'unknown') return true;
  const profile = getStrategyProfile(agent);
  if (!profile) return true; // no profile declared — don't silently gate off an unprofiled strategy
  return profile.activeRegimes.includes(regime);
}

export function strategiesActiveIn(regime: RegimeLabel): string[] {
  return STRATEGY_PROFILES.filter((p) => isStrategyActiveInRegime(p.agent, regime)).map((p) => p.agent);
}

/** Reports which profiles are missing required fields — the spec's "no strategy goes live without every field" check, made checkable. */
export function profileCompleteness(profiles: StrategyProfile[] = STRATEGY_PROFILES): { agent: string; missing: string[] }[] {
  const out: { agent: string; missing: string[] }[] = [];
  for (const p of profiles) {
    const missing: string[] = [];
    if (!p.bestConditions) missing.push('bestConditions');
    if (!p.worstConditions) missing.push('worstConditions');
    if (!p.entryLogic) missing.push('entryLogic');
    if (!p.exitLogic) missing.push('exitLogic');
    if (!p.positionSizingRule) missing.push('positionSizingRule');
    if (p.activeRegimes.length === 0) missing.push('activeRegimes');
    if (p.indicatorsUsed.length === 0) missing.push('indicatorsUsed');
    if (p.failureModes.length === 0) missing.push('failureModes');
    if (!p.selfEvaluation) missing.push('selfEvaluation');
    if (missing.length > 0) out.push({ agent: p.agent, missing });
  }
  return out;
}
