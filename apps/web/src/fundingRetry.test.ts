import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findNonFnnTransactionFields } from '@ckb-on-ramp/contracts';
import { abandonUnsignedChannel, fundingRetryDelayMs, signedFundingTxForSubmit } from './fundingRetry.js';

describe('funding retry helpers', () => {
  it('backs off 5s, 10s, 20s, then caps at 30s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(fundingRetryDelayMs), [0, 5_000, 10_000, 20_000, 30_000, 30_000]);
  });

  it('strips resolved-input metadata from a signed funding tx before FNN submit (issue #1)', () => {
    const legacySigned = {
      version: '0x0', cell_deps: [], header_deps: [],
      inputs: [{
        previous_output: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' }, since: '0x0',
        cellOutput: { capacity: '0x1' }, outputData: '0x',
      }],
      outputs: [], outputs_data: [], witnesses: ['0x55'],
    };
    const submitted = signedFundingTxForSubmit(legacySigned);
    assert.deepEqual(findNonFnnTransactionFields(submitted), []);
    assert.deepEqual(submitted.witnesses, ['0x55']);
  });

  it('abandons an unsigned channel best-effort', async () => {
    const calls: string[] = [];
    assert.equal(await abandonUnsignedChannel({ abandonChannel: async (p) => { calls.push(p.channel_id); } }, '0xab'), true);
    assert.equal(await abandonUnsignedChannel({ abandonChannel: async () => { throw new Error('gone'); } }, '0xcd'), false);
    assert.deepEqual(calls, ['0xab']);
  });
});
