import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SwapOrder } from '@ckb-on-ramp/contracts';
import { clearAllReceipts, loadReceipts, orderToReceipt, saveReceipt, updateReceiptStatus } from './receipts';
import { isCwbtcChannel } from './useSwap';
import { CWBTC_SCRIPT } from './FiberProvider';
import type { Channel } from '@fiber-pay/sdk/browser';

describe('Receipts storage and management', () => {
  beforeEach(() => {
    // Mock localStorage in node environment if needed
    const storage = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      length: storage.size,
    };
    clearAllReceipts();
  });

  it('starts with empty receipts list', () => {
    assert.deepEqual(loadReceipts(), []);
  });

  it('saves and retrieves a receipt', () => {
    const receipt = {
      paymentHash: '0x1234567890abcdef',
      paySats: 10400,
      receiveRaw: '10000000',
      receiveCwbtc: '0.1',
      feeSats: 400,
      status: 'Pending' as const,
      createdAt: 1700000000000,
      lightningInvoice: 'lnbc1...',
    };

    const saved = saveReceipt(receipt);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.paymentHash, receipt.paymentHash);

    const loaded = loadReceipts();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.paySats, 10400);
  });

  it('updates existing receipt when saving with same payment hash', () => {
    const receipt = {
      paymentHash: '0x1111',
      paySats: 5000,
      receiveRaw: '4900',
      receiveCwbtc: '0.000049',
      feeSats: 100,
      status: 'Pending' as const,
      createdAt: 100,
      lightningInvoice: 'lnbc111...',
    };

    saveReceipt(receipt);
    saveReceipt({ ...receipt, status: 'Success' as const, settledAt: 200 });

    const loaded = loadReceipts();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.status, 'Success');
    assert.equal(loaded[0]?.settledAt, 200);
  });

  it('updates status via updateReceiptStatus helper', () => {
    const receipt = {
      paymentHash: '0x2222',
      paySats: 5000,
      receiveRaw: '4900',
      receiveCwbtc: '0.000049',
      feeSats: 100,
      status: 'Pending' as const,
      createdAt: 100,
      lightningInvoice: 'lnbc222...',
    };
    saveReceipt(receipt);

    const updated = updateReceiptStatus('0x2222', 'Success', 300);
    assert.equal(updated.length, 1);
    assert.equal(updated[0]?.status, 'Success');
    assert.equal(updated[0]?.settledAt, 300);
  });

  it('converts SwapOrder to SwapReceipt cleanly', () => {
    const order: SwapOrder = {
      order_id: 'ord_1',
      payment_hash: '0x3333',
      status: 'IncomingAccepted',
      lightning_invoice: 'lnbc333...',
      fiber_invoice: 'fib333...',
      receive_raw: '100000000',
      pay_sats: 100300100,
      fee_sats: 300100,
      created_at: new Date(1700000000000).toISOString(),
    };

    const receipt = orderToReceipt(order, 'ch_abc');
    assert.equal(receipt.paymentHash, '0x3333');
    assert.equal(receipt.receiveCwbtc, '1');
    assert.equal(receipt.paySats, 100300100);
    assert.equal(receipt.channelId, 'ch_abc');
    assert.equal(receipt.status, 'IncomingAccepted');
  });

  it('clears all receipts on clearAllReceipts()', () => {
    saveReceipt({
      paymentHash: '0x4444',
      paySats: 1000,
      receiveRaw: '900',
      receiveCwbtc: '0.000009',
      feeSats: 100,
      status: 'Pending',
      createdAt: 100,
      lightningInvoice: 'lnbc4...',
    });

    assert.equal(loadReceipts().length, 1);
    clearAllReceipts();
    assert.equal(loadReceipts().length, 0);
  });
});

describe('isCwbtcChannel UDT channel filtering', () => {
  it('returns false for null or undefined channel', () => {
    assert.equal(isCwbtcChannel(null), false);
    assert.equal(isCwbtcChannel(undefined), false);
  });

  it('returns false for native CKB channels (funding_udt_type_script is null)', () => {
    const ckbChannel = {
      channel_id: 'ch_ckb',
      funding_udt_type_script: null,
    } as unknown as Channel;
    assert.equal(isCwbtcChannel(ckbChannel), false);
  });

  it('returns false for non-matching UDT channels', () => {
    const otherUdtChannel = {
      channel_id: 'ch_other',
      funding_udt_type_script: {
        code_hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        hash_type: 'type',
        args: '0x2222',
      },
    } as unknown as Channel;
    assert.equal(isCwbtcChannel(otherUdtChannel), false);
  });

  it('returns true for cWBTC channels matching code_hash and args', () => {
    const cwbtcChannel = {
      channel_id: 'ch_cwbtc',
      funding_udt_type_script: {
        code_hash: CWBTC_SCRIPT.code_hash,
        hash_type: 'type',
        args: CWBTC_SCRIPT.args,
      },
    } as unknown as Channel;
    assert.equal(isCwbtcChannel(cwbtcChannel), true);
  });
});
