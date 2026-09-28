import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CWBTC_SCRIPT } from '@ckb-on-ramp/contracts';
import {
  CLOSE_ERRORS,
  CLOSE_FEE_RATE,
  L1_SETTLEMENT_COPY,
  assertCanCloseToWallet,
  buildShutdownParams,
  cccScriptToFiberScript,
  closeChannelToWallet,
  hexArgsByteLength,
  humanizeCloseError,
  isCloseScriptArgsTooLarge,
  pickReadyCwbtcChannel,
  scriptsEqual,
  waitForCkbTxCommitted,
  type CloseChannelNode,
  type CloseableChannel,
  type FiberLockScript,
  type ShutdownChannelCall,
} from './closeToWallet.js';

const WALLET_LOCK: FiberLockScript = {
  code_hash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
  hash_type: 'type',
  args: `0x${'11'.repeat(20)}`,
};

const NODE_DEFAULT_LOCK: FiberLockScript = {
  code_hash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
  hash_type: 'type',
  args: `0x${'22'.repeat(20)}`,
};

const CHANNEL_ID = '0x60e1bb6f3c2618eadcaec013fabc1a29eadd9a17ef369bd273baedfea66817c7';
const TX_HASH = '0x' + 'ab'.repeat(32);

function readyChannel(overrides: Partial<CloseableChannel> = {}): CloseableChannel {
  return {
    channel_id: CHANNEL_ID,
    state: { state_name: 'ChannelReady' },
    local_balance: '0x5f5e100',
    offered_tlc_balance: '0x0',
    received_tlc_balance: '0x0',
    pending_tlcs: [],
    funding_udt_type_script: {
      code_hash: CWBTC_SCRIPT.code_hash,
      args: CWBTC_SCRIPT.args,
    },
    shutdown_transaction_hash: null,
    ...overrides,
  };
}

describe('closeToWallet', () => {
  describe('assertCanCloseToWallet', () => {
    it('rejects when no CCC wallet lock is connected', () => {
      assert.throws(
        () =>
          assertCanCloseToWallet({
            walletLock: null,
            nodeRunning: true,
            channels: [readyChannel()],
          }),
        { message: CLOSE_ERRORS.NO_WALLET },
      );
    });

    it('rejects when the Fiber node is not running', () => {
      assert.throws(
        () =>
          assertCanCloseToWallet({
            walletLock: WALLET_LOCK,
            nodeRunning: false,
            channels: [readyChannel()],
          }),
        { message: CLOSE_ERRORS.NO_NODE },
      );
    });

    it('rejects when there is no ready cWBTC channel', () => {
      assert.throws(
        () =>
          assertCanCloseToWallet({
            walletLock: WALLET_LOCK,
            nodeRunning: true,
            channels: [
              readyChannel({
                funding_udt_type_script: { code_hash: '0x00', args: '0x00' },
              }),
            ],
          }),
        { message: CLOSE_ERRORS.NO_CHANNEL },
      );
    });

    it('rejects a wallet lock whose args are ≥ 57 bytes', () => {
      const huge: FiberLockScript = { ...WALLET_LOCK, args: `0x${'aa'.repeat(57)}` };
      assert.equal(hexArgsByteLength(huge.args), 57);
      assert.equal(isCloseScriptArgsTooLarge(huge), true);
      assert.throws(
        () =>
          assertCanCloseToWallet({
            walletLock: huge,
            nodeRunning: true,
            channels: [readyChannel()],
          }),
        { message: CLOSE_ERRORS.LOCK_TOO_LARGE },
      );
    });
  });

  describe('buildShutdownParams', () => {
    it('uses the wallet lock as close_script, not the node default funding lock', () => {
      const params = buildShutdownParams({
        channelId: CHANNEL_ID,
        walletLock: WALLET_LOCK,
        nodeDefaultLock: NODE_DEFAULT_LOCK,
      });
      assert.equal(params.force, false);
      assert.equal(params.fee_rate, CLOSE_FEE_RATE);
      assert.equal(params.channel_id, CHANNEL_ID);
      assert.deepEqual(params.close_script, WALLET_LOCK);
      assert.equal(scriptsEqual(params.close_script, NODE_DEFAULT_LOCK), false);
      assert.equal(scriptsEqual(params.close_script, WALLET_LOCK), true);
    });

    it('never copies nodeDefaultLock even when it is the only other script in scope', () => {
      const params = buildShutdownParams({
        channelId: CHANNEL_ID,
        walletLock: WALLET_LOCK,
        nodeDefaultLock: NODE_DEFAULT_LOCK,
      });
      assert.notEqual(params.close_script.args, NODE_DEFAULT_LOCK.args);
    });
  });

  describe('cccScriptToFiberScript', () => {
    it('converts CCC camelCase script to Fiber snake_case lock', () => {
      const fiber = cccScriptToFiberScript({
        codeHash: WALLET_LOCK.code_hash,
        hashType: 'type',
        args: WALLET_LOCK.args,
      });
      assert.deepEqual(fiber, WALLET_LOCK);
    });
  });

  describe('pickReadyCwbtcChannel', () => {
    it('picks the ready cWBTC channel with the largest local balance', () => {
      const low = readyChannel({ channel_id: '0x' + '11'.repeat(32), local_balance: '0x1' });
      const high = readyChannel({ channel_id: '0x' + '33'.repeat(32), local_balance: '0xff' });
      const picked = pickReadyCwbtcChannel([low, high]);
      assert.equal(picked?.channel_id, high.channel_id);
    });
  });

  describe('closeChannelToWallet', () => {
    it('does not call shutdownChannel when no wallet is connected', async () => {
      let shutdownCalls = 0;
      const node: CloseChannelNode = {
        listChannels: async () => ({ channels: [readyChannel()] }),
        shutdownChannel: async () => {
          shutdownCalls += 1;
        },
      };
      await assert.rejects(
        () =>
          closeChannelToWallet({
            walletLock: null,
            address: 'ckt1q…',
            nodeRunning: true,
            node,
          }),
        { message: CLOSE_ERRORS.NO_WALLET },
      );
      assert.equal(shutdownCalls, 0);
    });

    it('calls shutdownChannel with the wallet lock and force=false', async () => {
      const calls: ShutdownChannelCall[] = [];
      const node: CloseChannelNode = {
        listChannels: async (params) => {
          if (params?.include_closed) {
            return {
              channels: [readyChannel({ shutdown_transaction_hash: TX_HASH, state: { state_name: 'Closed' } })],
            };
          }
          return { channels: [readyChannel()] };
        },
        shutdownChannel: async (params) => {
          calls.push(params);
        },
      };

      const result = await closeChannelToWallet({
        walletLock: WALLET_LOCK,
        address: 'ckt1qyqwalletaddress',
        nodeRunning: true,
        node,
        nodeDefaultLock: NODE_DEFAULT_LOCK,
        sleep: async () => {},
      });

      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.ok(call);
      assert.equal(call.force, false);
      assert.deepEqual(call.close_script, WALLET_LOCK);
      assert.equal(scriptsEqual(call.close_script, NODE_DEFAULT_LOCK), false);
      assert.equal(result.txHash, TX_HASH);
      assert.equal(result.address, 'ckt1qyqwalletaddress');
      assert.equal(result.channelId, CHANNEL_ID);
    });
  });

  describe('waitForCkbTxCommitted', () => {
    it('returns when RPC reports committed', async () => {
      let polls = 0;
      const fakeFetch: typeof fetch = async () => {
        polls += 1;
        return new Response(
          JSON.stringify({ result: { tx_status: { status: polls === 1 ? 'pending' : 'committed' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      await waitForCkbTxCommitted(TX_HASH, {
        fetch: fakeFetch,
        sleep: async () => {},
        timeoutMs: 10_000,
        pollIntervalMs: 1,
      });
      assert.equal(polls, 2);
    });
  });

  describe('copy', () => {
    it('describes L1 xUDT settlement, not RGB++ or Lightning', () => {
      assert.match(L1_SETTLEMENT_COPY, /CKB L1 xUDT/);
      assert.match(L1_SETTLEMENT_COPY, /not RGB\+\+/);
      assert.match(L1_SETTLEMENT_COPY, /not Lightning/);
    });
  });

  describe('humanizeCloseError', () => {
    it('maps peer disconnect to operator-offline copy', () => {
      assert.equal(humanizeCloseError(new Error('peer is not connected')), CLOSE_ERRORS.OPERATOR_OFFLINE);
    });
  });
});
