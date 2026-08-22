'use client';

import { LiquidityVolumePanel } from '@/components/LiquidityVolumePanel';
import { MTFBadges } from '@/components/MTFBadges';
import { NewsPanel } from '@/components/NewsPanel';
import { WatchlistEditor } from '@/components/WatchlistEditor';
import { OperatorSection } from './OperatorSection';

export function MarketsOperator({ onSelectSymbol }: { onSelectSymbol?: (s: string) => void }) {
  return (
    <>
      <OperatorSection
        title="Watchlist"
        note="Edits the watched-symbol list this browser drives. The backend keeps its own list; this one controls what the client subscribes to and prices."
      >
        <WatchlistEditor onSelectSymbol={onSelectSymbol} />
      </OperatorSection>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <OperatorSection title="Multi-timeframe" note="Agreement across timeframes, computed from candles already fetched.">
          <MTFBadges />
        </OperatorSection>
        <OperatorSection title="Liquidity & volume">
          <LiquidityVolumePanel />
        </OperatorSection>
      </div>

      <OperatorSection title="News" note="Headline feed. Nothing here feeds a trading decision on its own.">
        <NewsPanel />
      </OperatorSection>
    </>
  );
}
