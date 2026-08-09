// ---------------------------------------------------------------------
// Execution Intelligence (engineering spec Sections 19 & 22.4).
//
// Two separate concerns live here, both pure:
//
// 1. IDEMPOTENCY — "a retried request must never produce a duplicate
//    fill." Before this existed, placeMarketOrder sent no client order
//    id at all, so a network timeout on a submitted order left the caller
//    unable to distinguish "never placed" from "placed but the response
//    was lost" — and retrying would genuinely double-fill. Both
//    exchanges support a caller-supplied unique id that they reject
//    duplicates of (Binance: newClientOrderId, Bybit: orderLinkId), so
//    the fix is to always send a DETERMINISTIC one derived from the
//    logical trade intent. Same intent -> same id -> the exchange itself
//    refuses the second copy.
//
// 2. EXECUTION QUALITY — slippage and latency, measured against what was
//    requested, so the Evaluation layer can tell a bad fill from a bad
//    signal. Industry data cited in the roadmap points at execution
//    mismatches (slippage/latency) as a more common cause of live
//    underperformance than wrong signals, which is why this is measured
//    rather than assumed.
// ---------------------------------------------------------------------

// Binance caps newClientOrderId at 36 chars and restricts the charset;
// Bybit's orderLinkId is similarly bounded. 36 alphanumeric+dash is
// safe on both.
export const MAX_CLIENT_ORDER_ID_LENGTH = 36;
const PREFIX = 'tos'; // TradingOS — makes these identifiable in exchange order history

// FNV-1a (32-bit). Chosen because it must be DETERMINISTIC and
// dependency-free — a random or time-seeded id would defeat the entire
// purpose, since a retry has to produce the identical string.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // >>> 0 keeps this in unsigned 32-bit space; Math.imul avoids the
    // precision loss a plain * would introduce at this magnitude.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '').slice(0, 18);
}

/**
 * Deterministic, exchange-safe client order id for one logical trade
 * intent. Calling this twice with the same intentId returns the same
 * string — that identity IS the idempotency guarantee.
 *
 * `intentId` must be stable across retries of the same logical order but
 * different for genuinely different orders. For an agent task leg that
 * means `${taskId}-${legNumber}`; for a one-off trade, a uid generated
 * once at decision time (NOT at submit time).
 */
export function buildClientOrderId(intentId: string): string {
  const hash = fnv1a(intentId).toString(36);
  const readable = sanitize(intentId);
  const id = `${PREFIX}-${readable}-${hash}`;
  return id.slice(0, MAX_CLIENT_ORDER_ID_LENGTH);
}

/**
 * True when an exchange error indicates the order was rejected because
 * this client order id was already used — which, with a deterministic
 * id, means our previous attempt actually went through. This is a
 * SUCCESS case for a retry, not a failure: it proves no duplicate was
 * created. Callers should reconcile against the existing order rather
 * than reporting an error to the operator.
 */
export function isDuplicateOrderError(error: string): boolean {
  const e = error.toLowerCase();
  return (
    e.includes('duplicate') || // Binance: "Duplicate order sent." (-2010)
    e.includes('-2010') ||
    e.includes('order link id exist') || // Bybit V5 phrasing
    e.includes('orderlinkid exist') ||
    e.includes('already exists')
  );
}

// ---------------------------------------------------------------------
// Execution quality
// ---------------------------------------------------------------------

export type ExecutionQuality = {
  /**
   * Signed slippage in percent, expressed as COST: positive means the
   * fill was worse than requested, negative means better. Direction is
   * side-aware — paying more than requested on a buy and receiving less
   * than requested on a sell are both costs.
   */
  slippagePct: number;
  slippageUsd: number;
  latencyMs: number | null;
  /** 0-100, higher is better. Null when there's nothing meaningful to score. */
  score: number | null;
  notes: string[];
};

// Thresholds for the 0-100 score. Deliberately simple and stated rather
// than tuned — a fabricated-looking precise score would imply more rigor
// than a slippage-and-latency measure actually carries.
const SLIPPAGE_ZERO_SCORE_PCT = 1.0; // 1% adverse slippage scores 0 on that component
const LATENCY_ZERO_SCORE_MS = 5000; // 5s scores 0 on that component

export function computeExecutionQuality(params: {
  side: 'buy' | 'sell';
  requestedPrice: number;
  fillPrice: number | null;
  filledQty: number | null;
  submittedAtMs?: number;
  confirmedAtMs?: number;
}): ExecutionQuality {
  const notes: string[] = [];
  const latencyMs =
    params.submittedAtMs !== undefined && params.confirmedAtMs !== undefined
      ? Math.max(0, params.confirmedAtMs - params.submittedAtMs)
      : null;

  if (params.fillPrice === null || !isFinite(params.fillPrice) || params.fillPrice <= 0) {
    // No fill price reported means slippage genuinely isn't computable.
    // Reporting 0 here would read as "a perfect fill", which is a lie.
    notes.push('Exchange did not report a fill price — slippage is not computable for this order.');
    return { slippagePct: 0, slippageUsd: 0, latencyMs, score: null, notes };
  }
  if (params.requestedPrice <= 0 || !isFinite(params.requestedPrice)) {
    notes.push('No valid requested price to compare against — slippage is not computable.');
    return { slippagePct: 0, slippageUsd: 0, latencyMs, score: null, notes };
  }

  // Side-aware cost convention: a buy filling above the requested price
  // is a cost; a sell filling below it is equally a cost.
  const sign = params.side === 'buy' ? 1 : -1;
  const slippagePct = (sign * (params.fillPrice - params.requestedPrice) / params.requestedPrice) * 100;
  const qty = params.filledQty ?? 0;
  const slippageUsd = sign * (params.fillPrice - params.requestedPrice) * qty;

  if (params.filledQty === null) {
    notes.push('Exchange did not report a filled quantity — slippage percent is available but its dollar cost is not.');
  }
  if (slippagePct > 0) {
    notes.push(`Filled ${slippagePct.toFixed(3)}% worse than requested (a real execution cost, not a signal problem).`);
  } else if (slippagePct < 0) {
    notes.push(`Filled ${Math.abs(slippagePct).toFixed(3)}% better than requested.`);
  } else {
    notes.push('Filled exactly at the requested price.');
  }
  if (latencyMs === null) {
    notes.push('Submission/confirmation timestamps were not both recorded — latency unavailable.');
  }

  // Only adverse slippage is penalized; a favourable fill is not scored
  // above 100, because getting a better price than asked is luck rather
  // than execution skill and shouldn't inflate the metric.
  const adverseSlippagePct = Math.max(0, slippagePct);
  const slippageComponent = Math.max(0, 1 - adverseSlippagePct / SLIPPAGE_ZERO_SCORE_PCT);
  const latencyComponent = latencyMs === null ? null : Math.max(0, 1 - latencyMs / LATENCY_ZERO_SCORE_MS);

  // Slippage is weighted more heavily than latency: latency only matters
  // insofar as it causes slippage, and slippage is the thing that
  // actually costs money.
  const score =
    latencyComponent === null
      ? Math.round(slippageComponent * 100)
      : Math.round((slippageComponent * 0.75 + latencyComponent * 0.25) * 100);

  return { slippagePct, slippageUsd, latencyMs, score, notes };
}

/** One-line summary suitable for an audit record. */
export function describeExecutionQuality(q: ExecutionQuality): string {
  const parts = [
    `slippage ${q.slippagePct >= 0 ? '+' : ''}${q.slippagePct.toFixed(3)}%`,
    q.latencyMs !== null ? `latency ${q.latencyMs}ms` : 'latency unavailable',
    q.score !== null ? `quality ${q.score}/100` : 'quality not scorable',
  ];
  return parts.join(', ');
}
