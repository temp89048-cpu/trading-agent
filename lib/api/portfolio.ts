// ---------------------------------------------------------------------
// Portfolio + trade-log derivations, shared by /home, /dashboard, /positions,
// /history, /exposure, /risk and /strategies/performance.
//
// All pure, all here rather than in each page, because the same number computed
// two slightly different ways on two pages is worse than not showing it: an
// operator comparing them cannot tell which is right.
//
// EQUITY IS DERIVED, AND SAID TO BE.
//
// The backend returns `{paper: {cash, positions}, real: {positions}}` and no
// equity field. Equity = cash + mark value of open positions, and the mark comes
// from the live price feed — which is frequently unavailable. So `equity()`
// returns the parts and a `complete` flag, and callers show a partial figure as
// partial rather than as the total.
// ---------------------------------------------------------------------

export type Position = {
  symbol?: string;
  qty?: number;
  avgCost?: number;
  [k: string]: unknown;
};

export type Book = { cash?: number; positions?: Position[] };
export type PortfolioResponse = { paper?: Book; real?: Book };

export type Trade = {
  id: string;
  ts: number;
  tab: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  pnl?: number | null;
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Equity, plus whether every position could be marked.
 *
 *  `complete: false` means at least one position had no live price, so `value` is
 *  a floor rather than the equity. A caller that showed it as "Equity" flat would
 *  be understating the account by an unknown amount. */
export function equity(
  book: Book | undefined,
  prices: Record<string, number>,
): { cash: number | null; marked: number; unmarked: number; value: number | null; complete: boolean } {
  const cash = isNum(book?.cash) ? (book!.cash as number) : null;
  let marked = 0;
  let unmarked = 0;

  for (const p of book?.positions ?? []) {
    const qty = isNum(p.qty) ? p.qty : null;
    const symbol = typeof p.symbol === 'string' ? p.symbol : null;
    const price = symbol ? prices[symbol] : undefined;
    if (qty !== null && isNum(price)) marked += qty * price;
    else unmarked += 1;
  }

  return {
    cash,
    marked,
    unmarked,
    value: cash === null ? null : cash + marked,
    complete: cash !== null && unmarked === 0,
  };
}

/** Unrealised P&L for one position. `null` when it cannot be marked — never 0. */
export function unrealised(p: Position, prices: Record<string, number>): number | null {
  const qty = isNum(p.qty) ? p.qty : null;
  const cost = isNum(p.avgCost) ? p.avgCost : null;
  const symbol = typeof p.symbol === 'string' ? p.symbol : null;
  const price = symbol ? prices[symbol] : undefined;
  if (qty === null || cost === null || !isNum(price)) return null;
  return (price - cost) * qty;
}

/** Realised P&L totals from the trade log.
 *
 *  Only trades that CARRY a pnl are counted, and `withoutPnl` reports how many did
 *  not. A sum that silently treated a missing pnl as 0 would report a smaller loss
 *  or gain than reality and give no hint it had done so. */
export function realised(trades: Trade[]): {
  total: number;
  wins: number;
  losses: number;
  counted: number;
  withoutPnl: number;
  winRatePct: number | null;
} {
  let total = 0;
  let wins = 0;
  let losses = 0;
  let counted = 0;
  let withoutPnl = 0;

  for (const t of trades) {
    if (!isNum(t.pnl)) {
      withoutPnl += 1;
      continue;
    }
    counted += 1;
    total += t.pnl;
    if (t.pnl > 0) wins += 1;
    else if (t.pnl < 0) losses += 1;
  }

  return {
    total,
    wins,
    losses,
    counted,
    withoutPnl,
    // `null`, not 0, when nothing is counted — a 0% win rate is a claim.
    winRatePct: counted > 0 ? (wins / counted) * 100 : null,
  };
}

/** Cumulative realised equity curve, oldest first. `[]` when nothing has a pnl. */
export function equityCurve(trades: Trade[], startingAt = 0): { t: number; v: number }[] {
  const withPnl = trades.filter((t) => isNum(t.pnl)).sort((a, b) => a.ts - b.ts);
  let running = startingAt;
  return withPnl.map((t) => {
    running += t.pnl as number;
    return { t: t.ts, v: running };
  });
}

/** Max drawdown of a curve, as a positive percentage of the running peak.
 *
 *  `null` for fewer than two points: a drawdown of 0% from one observation is not
 *  a measurement of anything. */
export function maxDrawdownPct(curve: { v: number }[]): number | null {
  if (curve.length < 2) return null;
  let peak = curve[0].v;
  let worst = 0;
  for (const p of curve) {
    if (p.v > peak) peak = p.v;
    // Guard peak === 0: the first trade starting from zero would divide by it.
    if (peak !== 0) worst = Math.max(worst, ((peak - p.v) / Math.abs(peak)) * 100);
  }
  return worst;
}

/** Per-symbol exposure from a book. */
export function exposureBySymbol(
  book: Book | undefined,
  prices: Record<string, number>,
): { symbol: string; qty: number; value: number | null; share: number | null }[] {
  const rows = (book?.positions ?? [])
    .map((p) => {
      const symbol = typeof p.symbol === 'string' ? p.symbol : '—';
      const qty = isNum(p.qty) ? p.qty : 0;
      const price = prices[symbol];
      return { symbol, qty, value: isNum(price) ? qty * price : null };
    })
    .filter((r) => r.qty !== 0);

  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  return rows.map((r) => ({
    ...r,
    // `null` when the total is unknown or this row could not be valued — a share
    // computed over a partial total would be wrong in a way that looks precise.
    share: r.value !== null && total > 0 ? (r.value / total) * 100 : null,
  }));
}

/** Group trades by a key, for the failure-analysis and per-asset breakdowns. */
export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}
