import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeCkbTransactionForCcc,
  normalizeCkbTransactionForRpc,
} from './index.js';

describe('CKB transaction normalizer', () => {
  it('converts snake_case RPC transaction to camelCase CCC transaction and back (round-trip)', () => {
    const rpcTx = {
      version: '0x0',
      cell_deps: [
        {
          out_point: {
            tx_hash: '0x' + '11'.repeat(32),
            index: '0x0',
          },
          dep_type: 'dep_group',
        },
      ],
      header_deps: ['0x' + '22'.repeat(32)],
      inputs: [
        {
          previous_output: {
            tx_hash: '0x' + '33'.repeat(32),
            index: '0x1',
          },
          since: '0x0',
        },
      ],
      outputs: [
        {
          capacity: '0x1000',
          lock: {
            code_hash: '0x' + '44'.repeat(32),
            hash_type: 'type',
            args: '0x55',
          },
          type: {
            code_hash: '0x' + '66'.repeat(32),
            hash_type: 'data',
            args: '0x77',
          },
        },
      ],
      outputs_data: ['0x88'],
      witnesses: ['0x99'],
    };

    const cccTx = normalizeCkbTransactionForCcc(rpcTx) as any;

    assert.equal(cccTx.version, '0x0');
    assert.equal(cccTx.cellDeps[0].depType, 'depGroup');
    assert.equal(cccTx.cellDeps[0].outPoint.txHash, '0x' + '11'.repeat(32));
    assert.equal(cccTx.inputs[0].previousOutput.txHash, '0x' + '33'.repeat(32));
    assert.equal(cccTx.inputs[0].previousOutput.index, '0x1');
    assert.equal(cccTx.outputs[0].lock.codeHash, '0x' + '44'.repeat(32));
    assert.equal(cccTx.outputs[0].lock.hashType, 'type');
    assert.equal(cccTx.outputs[0].type.codeHash, '0x' + '66'.repeat(32));
    assert.equal(cccTx.outputsData[0], '0x88');
    assert.equal(cccTx.witnesses[0], '0x99');

    const backToRpc = normalizeCkbTransactionForRpc(cccTx);
    assert.deepEqual(backToRpc, rpcTx);
  });
});
