import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { sign } from './binance.server';
import { toExchangeSymbol } from './types';

// This sandbox has no route to api.binance.com, so these are pure math
// tests of the signing function only — not a live-endpoint test. The
// expected value is computed independently with Node's own `crypto`
// (not copy-pasted from the implementation under test), so the test
// actually verifies "this is HMAC-SHA256 hex of the exact query string,
// per Binance's documented signing scheme" rather than just asserting
// the implementation agrees with itself.
describe('binance sign()', () => {
  it('produces the HMAC-SHA256 hex digest of the query string, using the secret as the HMAC key', () => {
    const secret = 'test-secret-key';
    const query = 'symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.01&timestamp=1499827319559';
    const expected = createHmac('sha256', secret).update(query).digest('hex');
    expect(sign(secret, query)).toBe(expected);
  });

  it('is deterministic for the same inputs', () => {
    expect(sign('abc', 'x=1')).toBe(sign('abc', 'x=1'));
  });

  it('changes if the secret changes', () => {
    expect(sign('secret-a', 'x=1')).not.toBe(sign('secret-b', 'x=1'));
  });

  it('changes if the query string changes', () => {
    expect(sign('abc', 'x=1')).not.toBe(sign('abc', 'x=2'));
  });

  it('produces a 64-character lowercase hex string (SHA-256 output)', () => {
    const digest = sign('abc', 'x=1');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('toExchangeSymbol', () => {
  it('strips the slash and upper-cases the app-internal symbol form', () => {
    expect(toExchangeSymbol('BTC/USDT')).toBe('BTCUSDT');
    expect(toExchangeSymbol('eth/usdt')).toBe('ETHUSDT');
  });
});
