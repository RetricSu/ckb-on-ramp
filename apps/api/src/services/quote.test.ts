import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createQuote } from './quote.js';

describe('createQuote', () => {
  it('adds the configured base and proportional fee', () => {
    const quote = createQuote('100000', 0);
    assert.equal(quote.receive_raw, '100000');
    assert.equal(quote.fee_sats, 400);
    assert.equal(quote.pay_sats, 100400);
    assert.equal(quote.expires_at, '1970-01-01T00:05:00.000Z');
  });
  it('uses the same integer-floor proportional fee as CCH', () => {
    const quote = createQuote('100', 0);
    assert.equal(quote.fee_sats, 100);
    assert.equal(quote.pay_sats, 200);
  });
  it('keeps fee math exact above the safe Number multiplication range', () => {
    const quote = createQuote('8980258477263333', 0, BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(quote.fee_sats, 26940775431889);
    assert.equal(quote.pay_sats, 9007199252695222);
  });

  it('rejects receive_raw above the operator single-channel limit', () => {
    assert.throws(
      () => createQuote('100000001', Date.now(), 100000000n),
      /exceeds operator channel funding limit/,
    );
  });
  it('rejects a principal whose fee would make the total unsafe', () => {
    assert.throws(
      () => createQuote(String(Number.MAX_SAFE_INTEGER), Date.now(), BigInt(Number.MAX_SAFE_INTEGER)),
      /plus fees/,
    );
  });
  for (const value of ['', '0', '-1', '1.2']) {
    it(`rejects invalid receive_raw ${value || '(empty)'}`, () => {
      assert.throws(() => createQuote(value));
    });
  }
});
