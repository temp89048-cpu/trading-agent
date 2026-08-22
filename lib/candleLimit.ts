// ---------------------------------------------------------------------
// `limit` parsing for /api/candles.
//
// TWO BUGS THIS REPLACES
//
// 1. `parseInt('abc', 10)` is NaN, and `Math.min(500, Math.max(20, NaN))` is NaN.
//    That NaN went straight into the Binance URL as `limit=NaN`, so a caller's typo
//    came back as `502 Could not fetch candles: Binance klines 400: {"code":-1100,
//    "msg":"Illegal characters..."}` — an upstream error blaming Binance for a
//    parameter this route never validated.
//
// 2. The clamp was SILENT. `limit=3` returned 20 candles with nothing saying so.
//    The floor is deliberate and worth keeping — `lib/indicators.ts` needs lookback,
//    and a 3-bar RSI is not an RSI — but a caller that asks for 3 and is handed 20
//    has been silently overruled, and on a page that charts what it receives that is
//    a quiet disagreement about what the data is.
//
// So: reject what cannot be parsed, clamp what is out of range, and REPORT the
// clamp rather than performing it invisibly.
//
// Pure, so it is tested without a server.
// ---------------------------------------------------------------------

/** Fewest bars any indicator in `lib/indicators.ts` can be computed over. */
export const MIN_LIMIT = 20;
/** Live charts and indicators never need more; `/api/backtest` pages for depth. */
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 200;

export type LimitResult =
  | {
      ok: true;
      limit: number;
      /** What the caller asked for, when that differs from `limit`. */
      requested: number | null;
      /** Set when the value was clamped, so the response can say so. */
      note: string | null;
    }
  | { ok: false; error: string };

/**
 * Resolve the `limit` query parameter.
 *
 * `null` or an empty string means "not supplied" and takes the default — that is a
 * caller declining to choose, not an error. Anything present but unparseable IS an
 * error, because silently defaulting a typo hands back data the caller did not ask
 * for and gives them no way to notice.
 */
export function resolveLimit(raw: string | null): LimitResult {
  if (raw === null || raw.trim() === '') {
    return { ok: true, limit: DEFAULT_LIMIT, requested: null, note: null };
  }

  const trimmed = raw.trim();
  // `parseInt` accepts trailing junk ('20abc' -> 20) and leading '+'/'-'. Require
  // the whole string to be digits so '20abc' is a rejected typo rather than a
  // silent 20 — the caller meant something, and we do not know what.
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error:
        `limit must be a whole number between ${MIN_LIMIT} and ${MAX_LIMIT}; got "${raw}". ` +
        'Omit it for the default of ' + DEFAULT_LIMIT + '.',
    };
  }

  const requested = Number(trimmed);
  if (!Number.isSafeInteger(requested)) {
    return { ok: false, error: `limit is too large to be a bar count: "${raw}".` };
  }

  if (requested < MIN_LIMIT) {
    return {
      ok: true,
      limit: MIN_LIMIT,
      requested,
      note:
        `limit was raised from ${requested} to the ${MIN_LIMIT}-bar minimum: the ` +
        'indicators computed from this data need that much lookback, and a shorter ' +
        'series would produce values that look real but are not.',
    };
  }

  if (requested > MAX_LIMIT) {
    return {
      ok: true,
      limit: MAX_LIMIT,
      requested,
      note:
        `limit was reduced from ${requested} to the ${MAX_LIMIT}-bar maximum for this ` +
        'route. For deeper history use /api/backtest, which pages through Binance ' +
        'rather than making one oversized request.',
    };
  }

  return { ok: true, limit: requested, requested, note: null };
}
