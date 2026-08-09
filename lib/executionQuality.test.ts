import { describe, it, expect } from 'vitest';
import {
  buildClientOrderId,
  isDuplicateOrderError,
  computeExecutionQuality,
  describeExecutionQuality,
  MAX_CLIENT_ORDER_ID_LENGTH,
} from './executionQuality';

describe('buildClientOrderId — idempotency key', () => {
  it('is deterministic: the same intent always produces the same key', () => {
    // This is THE property that makes a retry safe. If this ever fails,
    // retries can double-fill.
    expect(buildClientOrderId('task123-open-0')).toBe(buildClientOrderId('task123-open-0'));
  });

  it('produces different keys for different intents', () => {
    expect(buildClientOrderId('task123-open-0')).not.toBe(buildClientOrderId('task123-open-1'));
    expect(buildClientOrderId('task123-open-0')).not.toBe(buildClientOrderId('task124-open-0'));
    expect(buildClientOrderId('task1-close-0-full')).not.toBe(buildClientOrderId('task1-close-0-0'));
  });

  it('never exceeds the exchange length limit', () => {
    const longIntent = 'a'.repeat(500);
    expect(buildClientOrderId(longIntent).length).toBeLessThanOrEqual(MAX_CLIENT_ORDER_ID_LENGTH);
    expect(buildClientOrderId('short').length).toBeLessThanOrEqual(MAX_CLIENT_ORDER_ID_LENGTH);
  });

  it('emits only exchange-safe characters', () => {
    // Symbols contain '/' and ':' which are not safe in a client order id.
    const key = buildClientOrderId('paper:BTC/USDT:buy:0.5:65000.25');
    expect(key).toMatch(/^[a-zA-Z0-9-]+$/);
  });

  it('still distinguishes long intents that differ only near the end', () => {
    // Truncation must not collapse distinct intents into one key — the
    // hash covers the WHOLE input even though the readable part is cut.
    const a = buildClientOrderId(`${'x'.repeat(60)}-leg-1`);
    const b = buildClientOrderId(`${'x'.repeat(60)}-leg-2`);
    expect(a).not.toBe(b);
  });

  it('is stable across differing-length inputs without collision on common cases', () => {
    const keys = new Set(
      ['t1-open-0', 't1-open-1', 't1-close-0-full', 't2-open-0', 't2-close-0-0', 't2-close-0-1'].map(buildClientOrderId),
    );
    expect(keys.size).toBe(6); // no collisions
  });
});

describe('isDuplicateOrderError', () => {
  it('recognizes Binance duplicate rejections', () => {
    expect(isDuplicateOrderError('Duplicate order sent.')).toBe(true);
    expect(isDuplicateOrderError('code -2010: Duplicate order sent.')).toBe(true);
  });

  it('recognizes Bybit duplicate rejections', () => {
    expect(isDuplicateOrderError('OrderLinkId exist')).toBe(true);
    expect(isDuplicateOrderError('order link id exist error')).toBe(true);
    expect(isDuplicateOrderError('This orderLinkId already exists')).toBe(true);
  });

  it('does NOT treat unrelated failures as duplicates', () => {
    // Misclassifying a real failure as "already submitted" would hide a
    // genuinely unplaced order — worse than a false alarm.
    expect(isDuplicateOrderError('Insufficient balance')).toBe(false);
    expect(isDuplicateOrderError('LOT_SIZE filter failure')).toBe(false);
    expect(isDuplicateOrderError('Invalid API key')).toBe(false);
    expect(isDuplicateOrderError('Network timeout')).toBe(false);
    expect(isDuplicateOrderError('')).toBe(false);
  });
});

describe('computeExecutionQuality', () => {
  it('treats a buy filling ABOVE the requested price as a cost', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 101, filledQty: 2 });
    expect(q.slippagePct).toBeCloseTo(1, 5);
    expect(q.slippageUsd).toBeCloseTo(2, 5);
    expect(q.notes.some((n) => n.includes('worse than requested'))).toBe(true);
  });

  it('treats a buy filling BELOW the requested price as favourable', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 99, filledQty: 2 });
    expect(q.slippagePct).toBeCloseTo(-1, 5);
    expect(q.notes.some((n) => n.includes('better than requested'))).toBe(true);
  });

  it('mirrors the sign convention for a sell', () => {
    // Selling BELOW the requested price is the cost case for a sell.
    const worse = computeExecutionQuality({ side: 'sell', requestedPrice: 100, fillPrice: 99, filledQty: 2 });
    expect(worse.slippagePct).toBeCloseTo(1, 5);
    expect(worse.slippageUsd).toBeCloseTo(2, 5);

    const better = computeExecutionQuality({ side: 'sell', requestedPrice: 100, fillPrice: 101, filledQty: 2 });
    expect(better.slippagePct).toBeCloseTo(-1, 5);
  });

  it('reports an exact fill as zero slippage with a full score', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 100, filledQty: 1 });
    expect(q.slippagePct).toBe(0);
    expect(q.score).toBe(100);
    expect(q.notes.some((n) => n.includes('exactly at the requested price'))).toBe(true);
  });

  it('refuses to score when no fill price was reported, instead of implying a perfect fill', () => {
    // Reporting 0% slippage here would read as flawless execution — the
    // exact kind of fabrication this codebase avoids.
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: null, filledQty: 1 });
    expect(q.score).toBeNull();
    expect(q.notes.some((n) => n.includes('not computable'))).toBe(true);
  });

  it('refuses to score against an invalid requested price', () => {
    expect(computeExecutionQuality({ side: 'buy', requestedPrice: 0, fillPrice: 100, filledQty: 1 }).score).toBeNull();
  });

  it('computes percent slippage even when filled qty is unknown, but not its dollar cost', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 101, filledQty: null });
    expect(q.slippagePct).toBeCloseTo(1, 5);
    expect(q.slippageUsd).toBe(0);
    expect(q.notes.some((n) => n.includes('dollar cost is not'))).toBe(true);
  });

  it('measures latency when both timestamps are present', () => {
    const q = computeExecutionQuality({
      side: 'buy',
      requestedPrice: 100,
      fillPrice: 100,
      filledQty: 1,
      submittedAtMs: 1000,
      confirmedAtMs: 1250,
    });
    expect(q.latencyMs).toBe(250);
  });

  it('reports latency as unavailable rather than zero when timestamps are missing', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 100, filledQty: 1 });
    expect(q.latencyMs).toBeNull();
    expect(q.notes.some((n) => n.includes('latency unavailable'))).toBe(true);
  });

  it('never reports negative latency from clock skew', () => {
    const q = computeExecutionQuality({
      side: 'buy',
      requestedPrice: 100,
      fillPrice: 100,
      filledQty: 1,
      submittedAtMs: 2000,
      confirmedAtMs: 1000,
    });
    expect(q.latencyMs).toBe(0);
  });

  it('scores worse as adverse slippage grows', () => {
    const good = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 100.05, filledQty: 1 });
    const bad = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 100.5, filledQty: 1 });
    expect(good.score!).toBeGreaterThan(bad.score!);
  });

  it('floors the score at 0 rather than going negative on extreme slippage', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 150, filledQty: 1 });
    expect(q.score).toBe(0);
  });

  it('does not inflate the score above 100 for a favourable fill', () => {
    // Getting a better price than asked is luck, not execution skill.
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 90, filledQty: 1 });
    expect(q.score).toBeLessThanOrEqual(100);
  });

  it('penalizes high latency even on a clean fill', () => {
    const fast = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 100, filledQty: 1, submittedAtMs: 0, confirmedAtMs: 50 });
    const slow = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 100, filledQty: 1, submittedAtMs: 0, confirmedAtMs: 4000 });
    expect(fast.score!).toBeGreaterThan(slow.score!);
  });
});

describe('describeExecutionQuality', () => {
  it('produces a one-line audit summary', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: 100.1, filledQty: 1, submittedAtMs: 0, confirmedAtMs: 120 });
    const text = describeExecutionQuality(q);
    expect(text).toContain('slippage');
    expect(text).toContain('120ms');
    expect(text).toContain('quality');
  });

  it('says unavailable/not scorable rather than printing misleading zeros', () => {
    const q = computeExecutionQuality({ side: 'buy', requestedPrice: 100, fillPrice: null, filledQty: null });
    const text = describeExecutionQuality(q);
    expect(text).toContain('latency unavailable');
    expect(text).toContain('not scorable');
  });
});
