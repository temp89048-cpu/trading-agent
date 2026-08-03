import type { WatchItem } from './types';
import { checkCapability } from './providerCapabilities';
import { X_TWITTER_STATUS, REDDIT_STATUS } from './newsProviders';
import type { SymbolMtfSnapshot } from './multiTimeframe';

export type NewsItem = { title: string; link: string; source: string; pubDate: string | null };
export type FearGreedPoint = { value: number; classification: string; timestamp: number };
export type DerivativesSnapshot = {
  fundingRate: number | null;
  markPrice: number | null;
  openInterest: number | null;
  topTraderLongShortRatio: number | null;
  topTraderLongAccountPct: number | null;
  takerBuySellRatio: number | null;
};

export type SentimentResult = {
  sentiment: 'Bullish' | 'Bearish' | 'Neutral';
  confidence: number; // 0-100, capped well below 100 — this is a heuristic read, never treated as certain
  reasons: string[];
  riskNote: string | null;
};

// A crude keyword scan, not real NLP sentiment analysis — documented as
// exactly that. This app has no dedicated NLP resource; pretending a
// keyword match is a proper sentiment classifier would overstate its
// own reliability. It's one input among several below, not the main one.
const BULLISH_KEYWORDS = ['surge', 'rally', 'soar', 'adopt', 'approval', 'approved', 'inflow', 'partnership', 'upgrade', 'breakout', 'record high', 'all-time high'];
const BEARISH_KEYWORDS = ['hack', 'exploit', 'crash', 'plunge', 'ban', 'lawsuit', 'outflow', 'charges', 'delist', 'halt', 'bankrupt', 'investigation', 'hacked'];

// Symbols like "BTC/USDT" need a couple of aliases to actually match
// headline text ("Bitcoin", not "BTC/USDT").
const SYMBOL_ALIASES: Record<string, string[]> = {
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ethereum'],
  SOL: ['sol', 'solana'],
  DOGE: ['doge', 'dogecoin'],
  XRP: ['xrp', 'ripple'],
};

function baseSymbol(symbol: string): string {
  return symbol.split('/')[0].toUpperCase();
}

export function relevantHeadlines(symbol: string, headlines: NewsItem[]): NewsItem[] {
  const base = baseSymbol(symbol);
  const aliases = SYMBOL_ALIASES[base] ?? [base.toLowerCase()];
  return headlines.filter((h) => aliases.some((a) => h.title.toLowerCase().includes(a)));
}

const FUNDING_NEUTRAL_THRESHOLD = 0.0001; // 0.01% — below this reads as neutral, not a real lean
const FUNDING_ELEVATED_THRESHOLD = 0.0005; // 0.05% — above this is genuinely crowded, not just "positive"

export function computeSentiment(symbol: string, headlines: NewsItem[], derivatives: DerivativesSnapshot | null, fearGreedCurrent: FearGreedPoint | null): SentimentResult {
  let bullishScore = 0;
  let bearishScore = 0;
  const reasons: string[] = [];
  const riskNotes: string[] = [];

  if (derivatives?.fundingRate != null) {
    const f = derivatives.fundingRate;
    if (f > FUNDING_NEUTRAL_THRESHOLD) {
      bullishScore += 10;
      reasons.push(`Funding rate +${(f * 100).toFixed(4)}% — longs paying shorts, suggests long positioning`);
      if (f > FUNDING_ELEVATED_THRESHOLD) riskNotes.push('Funding elevated — crowded long positioning, squeeze risk if sentiment reverses');
    } else if (f < -FUNDING_NEUTRAL_THRESHOLD) {
      bearishScore += 10;
      reasons.push(`Funding rate ${(f * 100).toFixed(4)}% — shorts paying longs, suggests short positioning`);
      if (f < -FUNDING_ELEVATED_THRESHOLD) riskNotes.push('Funding deeply negative — crowded short positioning, squeeze risk if sentiment reverses');
    } else {
      reasons.push(`Funding rate ${(f * 100).toFixed(4)}% — near neutral`);
    }
  }

  if (derivatives?.topTraderLongShortRatio != null) {
    const r = derivatives.topTraderLongShortRatio;
    if (r > 1.2) {
      bullishScore += 10;
      reasons.push(`Top traders ${derivatives.topTraderLongAccountPct?.toFixed(0) ?? '?'}% long (ratio ${r.toFixed(2)})`);
    } else if (r < 1 / 1.2) {
      bearishScore += 10;
      reasons.push(`Top traders net short (ratio ${r.toFixed(2)})`);
    }
  }

  if (derivatives?.takerBuySellRatio != null) {
    const r = derivatives.takerBuySellRatio;
    if (r > 1.1) {
      bullishScore += 8;
      reasons.push(`Aggressive taker buy volume outweighing sell volume (ratio ${r.toFixed(2)})`);
    } else if (r < 1 / 1.1) {
      bearishScore += 8;
      reasons.push(`Aggressive taker sell volume outweighing buy volume (ratio ${r.toFixed(2)})`);
    }
  }

  if (fearGreedCurrent) {
    const { value, classification } = fearGreedCurrent;
    reasons.push(`Fear & Greed = ${value} (${classification})`);
    if (classification.includes('Greed')) {
      bullishScore += 10;
      if (classification === 'Extreme Greed') riskNotes.push('Extreme Greed — high bullish sentiment, but pullback risk is increasing');
    } else if (classification.includes('Fear')) {
      bearishScore += 10;
      if (classification === 'Extreme Fear') riskNotes.push('Extreme Fear — potential capitulation, but bounce risk if positioned short');
    }
  }

  const relevant = relevantHeadlines(symbol, headlines);
  let bullishHits = 0;
  let bearishHits = 0;
  for (const h of relevant) {
    const title = h.title.toLowerCase();
    bullishHits += BULLISH_KEYWORDS.filter((k) => title.includes(k)).length;
    bearishHits += BEARISH_KEYWORDS.filter((k) => title.includes(k)).length;
  }
  if (bullishHits > 0 || bearishHits > 0) {
    bullishScore += Math.min(bullishHits * 5, 15);
    bearishScore += Math.min(bearishHits * 5, 15);
    reasons.push(`Headline keyword scan (heuristic, not full NLP): ${bullishHits} bullish / ${bearishHits} bearish keyword hits across ${relevant.length} relevant headlines`);
  }

  const total = bullishScore + bearishScore;
  if (total === 0) {
    return { sentiment: 'Neutral', confidence: 50, reasons: ['No funding/positioning/sentiment/news signal available yet'], riskNote: null };
  }

  const netScore = bullishScore - bearishScore;
  const sentiment: SentimentResult['sentiment'] = netScore > 10 ? 'Bullish' : netScore < -10 ? 'Bearish' : 'Neutral';
  const confidence = Math.min(95, 50 + Math.abs(netScore)); // never claims near-certainty off a heuristic score

  return { sentiment, confidence, reasons, riskNote: riskNotes.length > 0 ? riskNotes.join('; ') : null };
}

// ---------------------------------------------------------------------
// Market Health Score — a single normalized 0-100 read the Risk Manager
// (or the model) can consume instead of re-deriving a view from five
// separate indicators each time. Every star rating here traces back to
// one real, already-computed number — no category is invented.
// ---------------------------------------------------------------------
export type MarketHealthScore = {
  trendStars: number;
  momentumStars: number;
  fundingStars: number;
  sentimentStars: number;
  fearGreedStars: number;
  overall: number; // 0-100
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  risk: 'Low' | 'Medium' | 'High';
};

function clampStars(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}

// ---------------------------------------------------------------------
// Chat context injection.
// ---------------------------------------------------------------------
export function buildMarketIntelContext(
  watchlist: WatchItem[],
  news: NewsItem[],
  fearGreed: FearGreedPoint | undefined,
  getDerivatives: (symbol: string) => DerivativesSnapshot | undefined,
  getMtf: (item: WatchItem) => SymbolMtfSnapshot | null,
  aggregatorNote: string | null,
): string {
  const blocks: string[] = [];
  for (const item of watchlist) {
    const cap = checkCapability(item, 'fundingRate');
    const derivatives = cap.supported ? (getDerivatives(item.symbol) ?? null) : null;
    // alternative.me's Fear & Greed Index specifically measures CRYPTO
    // market sentiment, not general equities — applying it to a stock's
    // sentiment read would be misapplying data across asset classes, the
    // same mistake the Provider Manager pattern exists to prevent.
    const fgForThisAsset = item.type === 'crypto' ? (fearGreed ?? null) : null;
    const sentiment = computeSentiment(item.symbol, news, derivatives, fgForThisAsset);
    const mtf = getMtf(item);
    const momentumRatio = mtf && mtf.perTimeframe.length > 0
      ? mtf.perTimeframe.filter((t) => /Momentum (Extending|Returning)|Breakdown Resuming/.test(t.detail)).length / mtf.perTimeframe.length
      : 0;
    const health = computeMarketHealthScore(
      mtf?.overall?.trend,
      mtf?.overall ? (mtf.overall.agreement.match(/(\d+)\/(\d+)/) ? Number(mtf.overall.agreement.match(/(\d+)\/(\d+)/)![1]) / Number(mtf.overall.agreement.match(/(\d+)\/(\d+)/)![2]) : 0.5) : 0.5,
      momentumRatio,
      derivatives?.fundingRate ?? null,
      item.type === 'crypto' ? (fearGreed?.classification ?? null) : null,
      sentiment,
    );

    const derivLine = cap.supported
      ? derivatives
        ? `funding ${(derivatives.fundingRate! * 100).toFixed(4)}%, OI ${derivatives.openInterest?.toLocaleString() ?? 'n/a'}, top-trader long/short ${derivatives.topTraderLongShortRatio?.toFixed(2) ?? 'n/a'}`
        : 'derivatives data not loaded yet'
      : `Status: Unsupported. Reason: ${cap.reason}`;

    blocks.push(
      `${item.symbol}:\n` +
        `  Sentiment: ${sentiment.sentiment} (confidence ${sentiment.confidence}%)\n` +
        `  Reasons: ${sentiment.reasons.join('; ')}\n` +
        `  ${sentiment.riskNote ? `Risk note: ${sentiment.riskNote}\n` : ''}` +
        `  Derivatives: ${derivLine}\n` +
        `  Market Health: ${health.overall.toFixed(0)}/100 (Trend ${'★'.repeat(health.trendStars)}${'☆'.repeat(5 - health.trendStars)}, Momentum ${'★'.repeat(health.momentumStars)}${'☆'.repeat(5 - health.momentumStars)}, Funding ${'★'.repeat(health.fundingStars)}${'☆'.repeat(5 - health.fundingStars)}, Sentiment ${'★'.repeat(health.sentimentStars)}${'☆'.repeat(5 - health.sentimentStars)}, Fear&Greed ${'★'.repeat(health.fearGreedStars)}${'☆'.repeat(5 - health.fearGreedStars)}) — Bias: ${health.bias}, Risk: ${health.risk}`,
    );
  }

  const fgLine = fearGreed ? `Fear & Greed Index (crypto market-wide, not applied to equities): ${fearGreed.value} (${fearGreed.classification})` : 'Fear & Greed Index: not loaded yet';
  const plannedLines = [X_TWITTER_STATUS, REDDIT_STATUS]
    .map((p) => `  ${p.name} — Status: Planned. Reason: ${p.reason} Required: ${p.requiredComponents.join('; ')}.`)
    .join('\n');

  return `MARKET INTELLIGENCE (news sentiment is a keyword-based heuristic, not full NLP — treat as one input, not a verdict; derivatives are real Binance Futures data; Fear & Greed is real, from alternative.me):\n${fgLine}${aggregatorNote ? `\nNews source: ${aggregatorNote}` : ''}\n\n${blocks.join(
    '\n\n',
  )}\n\nNOT YET AVAILABLE (roadmap, not a silent gap):\n${plannedLines}`;
}

export function computeMarketHealthScore(
  mtfTrend: 'bullish' | 'bearish' | 'neutral' | undefined,
  mtfAgreementRatio: number, // dominant/total from the MTF snapshot, 0-1
  momentumTimeframeRatio: number, // fraction of timeframes showing active "Momentum Extending/Returning", 0-1
  fundingRate: number | null,
  fearGreedClassification: string | null,
  sentiment: SentimentResult,
): MarketHealthScore {
  const trendStars = clampStars(mtfAgreementRatio * 5);
  const momentumStars = clampStars(momentumTimeframeRatio * 5);

  let fundingStars = 3; // unknown/neutral default when funding data isn't available
  if (fundingRate !== null) {
    const abs = Math.abs(fundingRate) * 100; // as %
    fundingStars = abs < 0.01 ? 5 : abs < 0.03 ? 4 : abs < 0.05 ? 3 : abs < 0.1 ? 2 : 1;
  }

  const sentimentStars = clampStars(sentiment.confidence / 20); // 100% -> 5 stars, 50% -> ~2.5 -> 3

  let fearGreedStars = 3;
  if (fearGreedClassification) {
    fearGreedStars = fearGreedClassification === 'Neutral' ? 5 : fearGreedClassification.includes('Extreme') ? 2 : 4;
  }

  const overall = ((trendStars + momentumStars + fundingStars + sentimentStars + fearGreedStars) / 25) * 100;

  const bias: MarketHealthScore['bias'] =
    mtfTrend === 'bullish' && sentiment.sentiment === 'Bullish'
      ? 'Bullish'
      : mtfTrend === 'bearish' && sentiment.sentiment === 'Bearish'
        ? 'Bearish'
        : sentiment.sentiment;

  const lowStarCount = [trendStars, momentumStars, fundingStars, sentimentStars, fearGreedStars].filter((s) => s <= 2).length;
  const risk: MarketHealthScore['risk'] = lowStarCount >= 2 ? 'High' : lowStarCount === 1 ? 'Medium' : 'Low';

  return { trendStars, momentumStars, fundingStars, sentimentStars, fearGreedStars, overall, bias, risk };
}
