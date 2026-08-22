// ---------------------------------------------------------------------
// The watchlist. POSTGRES ONLY — it had no JSON file, only `localStorage`.
//
// Returns `null` with no database so the browser keeps its own copy, exactly as
// before. `null` is NOT an empty watchlist: emptying someone's watchlist because a
// connection dropped would be a data loss dressed as a successful read.
//
// REPLACED WHOLE, in a transaction. The browser owns the list and sends it
// complete; removing a symbol is expressed by its absence, so a merge would make
// removal impossible. Doing it in a transaction means a failed write leaves the
// previous list intact rather than a truncated one.
// ---------------------------------------------------------------------

import { rows, transaction } from './db.server';
import type { WatchItem } from './types';

type Row = { symbol: string; type: string; binance_symbol: string | null };

export async function getWatchlist(): Promise<WatchItem[] | null> {
  const found = await rows<Row>(
    'SELECT symbol, type, binance_symbol FROM watchlist ORDER BY symbol',
  );
  if (found === null) return null;
  return found.map((r) => ({
    symbol: r.symbol,
    type: r.type as WatchItem['type'],
    ...(r.binance_symbol === null ? {} : { binanceSymbol: r.binance_symbol }),
  })) as WatchItem[];
}

export async function saveWatchlist(items: WatchItem[]): Promise<boolean> {
  const result = await transaction(async (client) => {
    await client.query('DELETE FROM watchlist');
    for (const item of items) {
      if (!item?.symbol) continue;
      // `type` is CHECK-constrained to crypto/equity. Defaulting an unknown value
      // to 'crypto' would silently mislabel an equity and send it to the wrong
      // candle upstream, so the row is skipped instead.
      if (item.type !== 'crypto' && item.type !== 'equity') continue;
      await client.query(
        `INSERT INTO watchlist (symbol, type, binance_symbol) VALUES ($1, $2, $3)
         ON CONFLICT (symbol) DO UPDATE SET type = EXCLUDED.type,
                                            binance_symbol = EXCLUDED.binance_symbol`,
        [item.symbol, item.type, (item as { binanceSymbol?: string }).binanceSymbol ?? null],
      );
    }
    return true;
  });
  return result === true;
}
