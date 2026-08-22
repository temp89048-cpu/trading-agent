import { getBook, saveBook } from '@/lib/portfolioStore.server';
import { DEFAULT_PORTFOLIO, type PortfolioState } from '@/lib/types';

// ---------------------------------------------------------------------
// The portfolio, server-backed so it is not confined to one browser.
//
// `source` travels with every response. When there is no `DATABASE_URL` this
// returns `source: 'none'` and the client keeps using `localStorage` — which is
// why the client must not treat a missing book as an empty one. Wiping a
// portfolio because a database was unreachable would be a data loss that looks
// like a successful read.
// ---------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const book = await getBook();
  if (!book) {
    return Response.json({
      portfolio: null,
      source: 'none',
      note:
        'No DATABASE_URL configured, so there is no server-side portfolio. The ' +
        'browser should keep using its localStorage copy. This is NOT an empty book.',
    });
  }
  return Response.json({ portfolio: book, source: 'postgres' });
}

export async function PUT(req: Request) {
  let body: { portfolio?: PortfolioState };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const book = body.portfolio;
  // Validated rather than trusted: this endpoint REPLACES the stored book, so a
  // malformed payload would otherwise wipe cash and every position.
  if (
    !book ||
    typeof book.paper?.cash !== 'number' ||
    !Number.isFinite(book.paper.cash) ||
    !Array.isArray(book.paper?.positions) ||
    !Array.isArray(book.real?.positions)
  ) {
    return Response.json(
      {
        error:
          'Body must be { portfolio: { paper: { cash: number, positions: [] }, ' +
          'real: { positions: [] } } }. Rejected rather than partially stored, ' +
          'because this call replaces the whole book.',
      },
      { status: 400 },
    );
  }

  const ok = await saveBook(book);
  if (!ok) {
    return Response.json(
      { saved: false, source: 'none', note: 'No DATABASE_URL configured; nothing was stored.' },
      { status: 503 },
    );
  }
  return Response.json({ saved: true, source: 'postgres' });
}

export async function DELETE() {
  // Reset to the starting book. Same single starting-cash constant the rest of
  // the app uses, so a reset cannot reintroduce a second disagreeing figure.
  const ok = await saveBook(DEFAULT_PORTFOLIO);
  return Response.json({ reset: ok, source: ok ? 'postgres' : 'none' });
}
