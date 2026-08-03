import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { sign } from './bybit.server';

// Same caveat as binance.test.ts: no live-endpoint access from this
// sandbox, so this verifies the signing MATH against Bybit's documented
// V5 scheme (HMAC-SHA256 of timestamp + apiKey + recvWindow + payload),
// computed independently rather than copy-pasted from the implementation.
describe('bybit sign()', () => {
  it('produces the HMAC-SHA256 hex digest of timestamp + apiKey + recvWindow + payload, in that exact order', () => {
    const secret = 'test-secret-key';
    const timestamp = '1690000000000';
    const apiKey = 'test-api-key';
    const recvWindow = '5000';
    const payload = 'category=spot&symbol=BTCUSDT';
    const expected = createHmac('sha256', secret).update(timestamp + apiKey + recvWindow + payload).digest('hex');
    expect(sign(secret, timestamp, apiKey, recvWindow, payload)).toBe(expected);
  });

  it('is sensitive to field order — swapping timestamp and apiKey changes the signature', () => {
    const secret = 'test-secret-key';
    const a = sign(secret, '111', '222', '5000', 'payload');
    const b = sign(secret, '222', '111', '5000', 'payload');
    expect(a).not.toBe(b);
  });

  it('changes if the JSON body payload changes by even one character', () => {
    const secret = 'test-secret-key';
    const a = sign(secret, '111', 'key', '5000', '{"qty":"0.01"}');
    const b = sign(secret, '111', 'key', '5000', '{"qty":"0.02"}');
    expect(a).not.toBe(b);
  });

  it('produces a 64-character lowercase hex string (SHA-256 output)', () => {
    const digest = sign('secret', '1', 'k', '5000', 'p');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
