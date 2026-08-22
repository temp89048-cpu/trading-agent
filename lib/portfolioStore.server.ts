// ---------------------------------------------------------------------
// The portfolio — cash and open positions. POSTGRES ONLY.
//
// NO JSON FALLBACK, unlike the other stores, and that is deliberate: this data
// lived in `localStorage` and had no file to fall back to. With no `DATABASE_URL`
// the reads return `null` and the browser keeps using `localStorage` exactly as
// before, so nothing regresses on a database-less checkout.
//
// WHY IT MOVED AT ALL
//
// `localStorage` is one browser. Clearing site data, switching machine, or opening
// the app in a different profile lost the entire book. For a paper account that is
// annoying; the same pattern on the backend side is the reason a restart forgets
// every open position while the position still exists at the exchange.
//
// CASH AND POSITIONS ARE WRITTEN IN ONE TRANSACTION. They are two tables
// (`paper_account`, `positions`) describing one state: cash went down because a
// position was opened. A partial write leaves cash that does not match the
// positions it paid for, and every equity figure derived from it is then wrong in
// a way that looks precise. `saveBook` is all-or-nothing.
//
// POSITIONS ARE REPLACED, NOT MERGED. The browser holds the authoritative book and
// sends it whole; a merge would resurrect a position the user just closed, because
// "absent from the payload" is how a close is expressed.
// ---------------------------------------------------------------------

import { rows, transaction } from './db.server';
import { toNumber } from './jsonFallback.server';
import type { PortfolioState, Position, TradeTab } from './types';

type PositionRow = { tab: string; symbol: string; qty: string | number; avg_cost: string | number };

function fromRow(r: PositionRow): Position {
  return {
    symbol: r.symbol,
    qty: toNumber(r.qty) ?? 0,
    avgCost: toNumber(r.avg_cost) ?? 0,
  };
}

/**
 * The whole book, or `null` when there is no database.
 *
 * `null` and "an empty book" are different: the first means the browser should
 * keep using its own copy, the second means the user genuinely holds nothing.
 * Collapsing them would silently wipe a portfolio on a connection failure.
 */
export async function getBook(): Promise<PortfolioState | null> {
  const positionRows = await rows<PositionRow>(
    'SELECT tab, symbol, qty, avg_cost FROM positions ORDER BY symbol',
  );
  if (positionRows === null) return null;

  const cashRows = await rows<{ cash: string | number }>(
    "SELECT cash FROM paper_account WHERE id = 'default'",
  );
  if (cashRows === null) return null;

  const paper = positionRows.filter((r) => r.tab === 'paper').map(fromRow);
  const real = positionRows.filter((r) => r.tab === 'real').map(fromRow);

  return {
    // An unseeded row falls back to the ONE starting-cash constant. It used to be
    // defined in two places that disagreed (1,000,000 vs 25,000), which put every
    // drawdown check 40x out and made a capital-target mission complete instantly.
    paper: { cash: toNumber(cashRows[0]?.cash) ?? DEFAULT_CASH, positions: paper },
    real: { positions: real },
  };
}

// Imported lazily to keep this module's import graph free of the risk manager.
import { PAPER_STARTING_EQUITY as DEFAULT_CASH } from './types';

/**
 * Replace the stored book. Returns false when there is no database.
 *
 * One transaction, and positions are deleted before being re-inserted so a closed
 * position actually disappears.
 */
export async function saveBook(book: PortfolioState): Promise<boolean> {
  const result = await transaction(async (client) => {
    await client.query(
      `INSERT INTO paper_account (id, cash) VALUES ('default', $1)
       ON CONFLICT (id) DO UPDATE SET cash = EXCLUDED.cash`,
      [book.paper.cash],
    );

    await client.query('DELETE FROM positions');

    const insert = async (tab: TradeTab, positions: Position[]) => {
      for (const p of positions) {
        // Skip a position with no quantity rather than storing a zero-size row:
        // it would show on every exposure table as a holding of nothing.
        if (!Number.isFinite(p.qty) || p.qty === 0) continue;
        await client.query(
          `INSERT INTO positions (tab, symbol, qty, avg_cost) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tab, symbol) DO UPDATE SET qty = EXCLUDED.qty, avg_cost = EXCLUDED.avg_cost`,
          [tab, p.symbol, p.qty, p.avgCost],
        );
      }
    };

    await insert('paper', book.paper.positions ?? []);
    await insert('real', book.real.positions ?? []);
    return true;
  });

  return result === true;
}
