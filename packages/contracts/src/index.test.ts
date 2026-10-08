import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findNonFnnTransactionFields,
  normalizeCkbTransactionForCcc,
  normalizeCkbTransactionForRpc,
  toFnnRpcTransaction,
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

describe('FNN transaction shape', () => {
  const H = (b: string) => '0x' + b.repeat(32);
  const cccStyleSignedTx = {
    version: '0x0',
    cell_deps: [{ out_point: { tx_hash: H('11'), index: '0x0' }, dep_type: 'code' }],
    header_deps: [],
    inputs: [
      {
        previous_output: { tx_hash: H('22'), index: '0x0' },
        since: '0x0',
        // Resolved-input metadata CCC attaches after `getCell` (issue #1).
        cellOutput: { capacity: '0x6fc23ac00', lock: { code_hash: H('33'), hash_type: 'type', args: '0x' } },
        outputData: '0x',
      },
    ],
    outputs: [
      {
        capacity: '0x891737000',
        lock: { code_hash: H('44'), hash_type: 'type', args: '0x01' },
        type: { code_hash: H('55'), hash_type: 'type', args: '0x02' },
      },
      { capacity: '0x1000', lock: { code_hash: H('44'), hash_type: 'type', args: '0x03' } },
    ],
    outputs_data: ['0x00e1f505000000000000000000000000', '0x'],
    witnesses: ['0xaa', '0xbb'],
  };

  it('flags the extra input fields that FNN rejects', () => {
    assert.deepEqual(findNonFnnTransactionFields(cccStyleSignedTx), [
      '$.inputs[0].cellOutput',
      '$.inputs[0].outputData',
    ]);
  });

  it('projects any CKB tx onto the exact FNN shape without changing values', () => {
    const fnnTx = toFnnRpcTransaction(cccStyleSignedTx);
    assert.deepEqual(findNonFnnTransactionFields(fnnTx), []);
    assert.deepEqual(fnnTx.inputs, [{ previous_output: { tx_hash: H('22'), index: '0x0' }, since: '0x0' }]);
    assert.deepEqual(fnnTx.outputs, cccStyleSignedTx.outputs);
    assert.deepEqual(fnnTx.witnesses, cccStyleSignedTx.witnesses);
    assert.deepEqual(fnnTx.outputs_data, cccStyleSignedTx.outputs_data);
    assert.deepEqual(fnnTx.cell_deps, cccStyleSignedTx.cell_deps);
  });

  it('accepts camelCase input and fills a missing since', () => {
    const fnnTx = toFnnRpcTransaction({
      cellDeps: [],
      headerDeps: [],
      inputs: [{ previousOutput: { txHash: H('22'), index: '0x1' } }],
      outputs: [],
      outputsData: [],
      witnesses: [],
    });
    assert.deepEqual(fnnTx.inputs, [{ previous_output: { tx_hash: H('22'), index: '0x1' }, since: '0x0' }]);
    assert.deepEqual(findNonFnnTransactionFields(fnnTx), []);
  });
});
