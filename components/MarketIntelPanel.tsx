'use client';

import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useMarketIntel } from './MarketIntel';
import { computeMtfSnapshot } from '@/lib/multiTimeframe';
import { checkCapability } from '@/lib/providerCapabilities';
import { computeSentiment, computeMarketHealthScore } from '@/lib/sentimentAgent';
import { X_TWITTER_STATUS, REDDIT_STATUS } from '@/lib/newsProviders';

function Stars({ n }: { n: number }) {
  return (
    <span className="text-amber">
      {'★'.repeat(n)}
      <span className="text-txt2">{'☆'.repeat(5 - n)}</span>
    </span>
  );
}

export function MarketIntelPanel() {
  const { watchlist } = useMarketData();
  const { getCandles } = useCandles();
  const { getNews, getFearGreed, getDerivatives, aggregatorNote } = useMarketIntel();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  const news = getNews();
  const fearGreed = getFearGreed();

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[10px] font-mono text-txt2">
        {fearGreed ? `Fear & Greed (crypto): ${fearGreed.value} (${fearGreed.classification})` : 'Fear & Greed: loading…'}
      </p>
      {aggregatorNote && <p className="text-[9.5px] font-mono text-txt2">{aggregatorNote}</p>}
      <div className="flex flex-col gap-2">
        {watchlist.map((item) => {
          const cap = checkCapability(item, 'fundingRate');
          const derivatives = cap.supported ? getDerivatives(item.symbol) : undefined;
          const fgForAsset = item.type === 'crypto' ? fearGreed : undefined;
          const sentiment = computeSentiment(item.symbol, news, derivatives ?? null, fgForAsset ?? null);
          const mtf = computeMtfSnapshot(item, getCandles);
          const momentumRatio = mtf.perTimeframe.length > 0
            ? mtf.perTimeframe.filter((t) => /Momentum (Extending|Returning)|Breakdown Resuming/.test(t.detail)).length / mtf.perTimeframe.length
            : 0;
          const agreementMatch = mtf.overall?.agreement.match(/(\d+)\/(\d+)/);
          const agreementRatio = agreementMatch ? Number(agreementMatch[1]) / Number(agreementMatch[2]) : 0.5;
          const health = computeMarketHealthScore(
            mtf.overall?.trend,
            agreementRatio,
            momentumRatio,
            derivatives?.fundingRate ?? null,
            item.type === 'crypto' ? (fearGreed?.classification ?? null) : null,
            sentiment,
          );
          const sentColor = sentiment.sentiment === 'Bullish' ? 'text-green' : sentiment.sentiment === 'Bearish' ? 'text-red' : 'text-txt2';

          return (
            <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
              <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
              <p className={`text-[10px] font-mono font-bold ${sentColor}`}>
                {sentiment.sentiment} <span className="text-txt2 font-normal">· {sentiment.confidence}%</span>
              </p>
              {!cap.supported && <p className="text-[9.5px] font-mono text-txt2">Derivatives: Unsupported (equity)</p>}
              {cap.supported && derivatives && (
                <p className="text-[9.5px] font-mono text-txt2">
                  Funding {(derivatives.fundingRate! * 100).toFixed(4)}% · OI {derivatives.openInterest ? (derivatives.openInterest / 1e9).toFixed(2) + 'B' : 'n/a'}
                </p>
              )}
              <p className="text-[9.5px] font-mono">
                Health {health.overall.toFixed(0)}/100 — <Stars n={health.trendStars} /> Trend, <Stars n={health.fearGreedStars} /> F&amp;G — {health.bias}, {health.risk} risk
              </p>
              {sentiment.riskNote && <p className="text-[9.5px] font-mono text-amber">{sentiment.riskNote}</p>}
            </div>
          );
        })}
      </div>
      <div className="border-t border-line pt-2 flex flex-col gap-1">
        <p className="text-[9.5px] font-mono text-txt1">Not yet available:</p>
        {[X_TWITTER_STATUS, REDDIT_STATUS].map((p) => (
          <p key={p.name} className="text-[9.5px] font-mono text-txt2" title={p.reason}>
            <span className="text-amber">{p.name}</span> — Planned
          </p>
        ))}
      </div>
      <p className="text-[9.5px] text-txt2">
        Sentiment is a keyword-heuristic + real funding/positioning/Fear&amp;Greed blend — not full NLP. One input
        among many, not a verdict.
      </p>
    </div>
  );
}
