import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { beforeEach, describe, it } from 'node:test';
import express from 'express';
import { ClientPublicTestnet } from '@ckb-ccc/core';
import { CWBTC_SCRIPT } from '@ckb-on-ramp/contracts';
import apiRouter, { createApiRouter } from '../routes/api.js';
import {
  clearBootstrapSessionsForTest,
  getBootstrapSession,
  getBootstrapSessionTask,
  prepareInboundLiquidity,
  validateBootstrapRequest,
} from './bootstrap.js';
import { CccOperatorCkbSender, type OperatorCkbSender } from './ccc.js';
import type { CchGateway, OpenChannelParams, OpenChannelResult } from './cch.js';

const VALID_PUBKEY = '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957';
const VALID_PUBKEY_WITH_0X = '0x03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957';
const VALID_TESTNET_ADDRESS = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq05hurcuuzeudh8ldfcxp48jfj2efakgkqz78dss';
const MAINNET_ADDRESS = 'ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq05hurcuuzeudh8ldfcxp48jfj2efakgkqz78dss';
const DUMMY_OPERATOR_KEY = '0x' + '1234567890abcdef'.repeat(4);

describe('Bootstrap Service and Route (Scheme B Phase-1)', () => {
  beforeEach(() => {
    clearBootstrapSessionsForTest();
  });

  describe('validateBootstrapRequest', () => {
    it('accepts valid compressed pubkey and ckt1 testnet address', () => {
      const result = validateBootstrapRequest({
        node_pubkey: VALID_PUBKEY,
        funding_address: VALID_TESTNET_ADDRESS,
      });
      assert.equal(result.node_pubkey, VALID_PUBKEY);
      assert.equal(result.funding_address, VALID_TESTNET_ADDRESS);
    });

    it('accepts pubkey with 0x prefix', () => {
      const result = validateBootstrapRequest({
        node_pubkey: VALID_PUBKEY_WITH_0X,
        funding_address: VALID_TESTNET_ADDRESS,
      });
      assert.equal(result.node_pubkey, VALID_PUBKEY_WITH_0X);
    });

    it('rejects missing or empty node_pubkey', () => {
      assert.throws(
        () => validateBootstrapRequest({ funding_address: VALID_TESTNET_ADDRESS }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: '', funding_address: VALID_TESTNET_ADDRESS }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
    });

    it('rejects malformed or uncompressed node_pubkey', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: '03deadbeef', funding_address: VALID_TESTNET_ADDRESS }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
      assert.throws(
        () => validateBootstrapRequest({
          node_pubkey: '04' + 'a'.repeat(128),
          funding_address: VALID_TESTNET_ADDRESS,
        }),
        /node_pubkey must be a compressed secp256k1 public key/,
      );
    });

    it('rejects missing or empty funding_address', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY }),
        /funding_address must be a valid CKB testnet address/,
      );
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: '' }),
        /funding_address must be a valid CKB testnet address/,
      );
    });

    it('rejects CKB mainnet address', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: MAINNET_ADDRESS }),
        /funding_address must be a valid CKB testnet address/,
      );
    });

    it('rejects arbitrary non-CKB strings as funding_address', () => {
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: '0x1234567890abcdef' }),
        /funding_address must be a valid CKB testnet address/,
      );
      assert.throws(
        () => validateBootstrapRequest({ node_pubkey: VALID_PUBKEY, funding_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }),
        /funding_address must be a valid CKB testnet address/,
      );
    });
  });

  describe('prepareInboundLiquidity', () => {
    it('returns status failed when OPERATOR_CKB_PRIVATE_KEY is not configured', async () => {
      const session = await prepareInboundLiquidity(
        {
          node_pubkey: VALID_PUBKEY,
          funding_address: VALID_TESTNET_ADDRESS,
        },
        {
          operatorPrivateKey: undefined,
        },
      );

      assert.equal(session.status, 'failed');
      assert.ok(session.session_id);
      assert.match(session.message, /Scheme B/i);
      assert.match(session.message, /not wired/i);
    });

    it('submits ≥200 CKB capacity gift without waiting for tx, returning provisioning_liquidity immediately', async () => {
      const giftCalls: { address: string; amount?: number | bigint }[] = [];
      const openChannelCalls: OpenChannelParams[] = [];

      const mockSender: OperatorCkbSender = {
        sendCapacityGift: async (address, amount) => {
          giftCalls.push({ address, amount });
          return { txHash: '0x' + 'a'.repeat(64) };
        },
      };

      const mockGateway: CchGateway = {
        createOrder: async () => { throw new Error('not implemented'); },
        getOrder: async () => null,
        health: async () => true,
        getNodeInfo: async () => ({
          node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 1,
          peer_count: 2,
        }),
        openChannel: async (params: OpenChannelParams): Promise<OpenChannelResult> => {
          openChannelCalls.push(params);
          return { channel_id: '0x' + 'b'.repeat(64) };
        },
      };

      const session = await prepareInboundLiquidity(
        {
          node_pubkey: VALID_PUBKEY_WITH_0X,
          funding_address: VALID_TESTNET_ADDRESS,
        },
        {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorCkbSender: mockSender,
          cchGateway: mockGateway,
          channelFundingAmount: '100000000',
        },
      );

      // Verify returned session has gift_tx_hash and provisioning_liquidity status immediately
      assert.equal(session.status, 'provisioning_liquidity');
      assert.ok(session.session_id);
      assert.equal(session.gift_tx_hash, '0x' + 'a'.repeat(64));
      assert.equal(session.peer_address, '/ip4/127.0.0.1/tcp/18328/ws');
      assert.match(session.message, /capacity gift submitted/i);

      // Verify CCC capacity gift was called with ≥ 200 CKB
      assert.equal(giftCalls.length, 1);
      const firstGift = giftCalls[0];
      assert.ok(firstGift);
      assert.equal(firstGift.address, VALID_TESTNET_ADDRESS);
      assert.ok(Number(firstGift.amount) >= 200);

      // Await background task to verify open_channel executes
      const task = getBootstrapSessionTask(session.session_id);
      assert.ok(task);
      await task;

      assert.equal(openChannelCalls.length, 1);
      const firstOpen = openChannelCalls[0];
      assert.ok(firstOpen);
      assert.equal(firstOpen.pubkey, VALID_PUBKEY); // 0x stripped
      assert.equal(firstOpen.funding_amount, '0x5f5e100'); // 100000000 in hex
      assert.deepEqual(firstOpen.funding_udt_type_script, CWBTC_SCRIPT);

      // Session in memory is updated with channel_id
      const updated = getBootstrapSession(session.session_id);
      assert.ok(updated);
      assert.equal(updated.channel_id, '0x' + 'b'.repeat(64));
      assert.match(updated.message, /channel opening initiated/i);
    });

    it('async gift: POST/call returns before waitTransaction resolves; GET shows channel only after waitTransaction resolves', async () => {
      let resolveWait!: () => void;
      const waitPromise = new Promise<void>((resolve) => {
        resolveWait = resolve;
      });

      let waitCalled = false;
      let openChannelCalled = false;

      const mockSender: OperatorCkbSender = {
        sendCapacityGift: async () => {
          return { txHash: '0x' + '11'.repeat(32) };
        },
        waitForTransaction: async () => {
          waitCalled = true;
          await waitPromise;
        },
      };

      const mockGateway: CchGateway = {
        createOrder: async () => { throw new Error('not implemented'); },
        getOrder: async () => null,
        health: async () => true,
        getNodeInfo: async () => ({
          node_id: VALID_PUBKEY,
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 0,
          peer_count: 0,
        }),
        openChannel: async () => {
          openChannelCalled = true;
          return { channel_id: '0x' + '22'.repeat(32) };
        },
      };

      // 1. Initiate bootstrap
      const session = await prepareInboundLiquidity(
        { node_pubkey: VALID_PUBKEY, funding_address: VALID_TESTNET_ADDRESS },
        {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorCkbSender: mockSender,
          cchGateway: mockGateway,
        },
      );

      // Returns immediately:
      assert.equal(session.status, 'provisioning_liquidity');
      assert.equal(session.gift_tx_hash, '0x' + '11'.repeat(32));
      assert.equal(session.channel_id, undefined);

      // 2. Query in-memory session before waitTransaction resolves
      const beforeWait = getBootstrapSession(session.session_id);
      assert.ok(beforeWait);
      assert.equal(beforeWait.status, 'provisioning_liquidity');
      assert.equal(beforeWait.channel_id, undefined, 'channel_id must NOT be set before waitTransaction completes');
      assert.equal(openChannelCalled, false, 'openChannel must not be called before waitTransaction completes');

      // 3. Resolve waitTransaction
      resolveWait();
      const task = getBootstrapSessionTask(session.session_id);
      assert.ok(task);
      await task;

      // 4. Query in-memory session after waitTransaction resolves
      const afterWait = getBootstrapSession(session.session_id);
      assert.ok(afterWait);
      assert.equal(afterWait.channel_id, '0x' + '22'.repeat(32), 'channel_id must be populated after wait completes');
      assert.equal(openChannelCalled, true);
    });

    it('redacts private key and never leaks it if an error occurs during provisioning', async () => {
      const mockFailingSender: OperatorCkbSender = {
        sendCapacityGift: async () => {
          throw new Error(`RPC node failed with key ${DUMMY_OPERATOR_KEY}`);
        },
      };

      await assert.rejects(
        () =>
          prepareInboundLiquidity(
            {
              node_pubkey: VALID_PUBKEY,
              funding_address: VALID_TESTNET_ADDRESS,
            },
            {
              operatorPrivateKey: DUMMY_OPERATOR_KEY,
              operatorCkbSender: mockFailingSender,
            },
          ),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.ok(!msg.includes(DUMMY_OPERATOR_KEY), 'Private key must NOT appear in error message');
          assert.ok(!msg.includes(DUMMY_OPERATOR_KEY.slice(2)), 'Raw private key must NOT appear in error message');
          assert.match(msg, /\[REDACTED\]/);
          return true;
        },
      );
    });

    it('background task updates session status to failed and redacts private key if channel opening fails', async () => {
      const mockSender: OperatorCkbSender = {
        sendCapacityGift: async () => ({ txHash: '0x' + 'a'.repeat(64) }),
      };
      const mockFailingGateway: CchGateway = {
        createOrder: async () => { throw new Error('not implemented'); },
        getOrder: async () => null,
        health: async () => true,
        getNodeInfo: async () => ({ node_id: VALID_PUBKEY, addresses: [], channel_count: 0, peer_count: 0 }),
        openChannel: async () => { throw new Error(`FNN failed with key ${DUMMY_OPERATOR_KEY}`); },
      };

      const session = await prepareInboundLiquidity(
        { node_pubkey: VALID_PUBKEY, funding_address: VALID_TESTNET_ADDRESS },
        {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorCkbSender: mockSender,
          cchGateway: mockFailingGateway,
        },
      );

      const task = getBootstrapSessionTask(session.session_id);
      assert.ok(task);
      await task;

      const failedSession = getBootstrapSession(session.session_id);
      assert.ok(failedSession);
      assert.equal(failedSession.status, 'failed');
      assert.ok(!failedSession.message.includes(DUMMY_OPERATOR_KEY));
      assert.match(failedSession.message, /\[REDACTED\]/);
    });
  });

  describe('CccOperatorCkbSender key validation and redaction', () => {
    it('rejects invalid or malformed private keys', () => {
      assert.throws(
        () => new CccOperatorCkbSender('not_a_valid_hex_key'),
        /OPERATOR_CKB_PRIVATE_KEY must be a valid 32-byte hex private key/,
      );
      assert.throws(
        () => new CccOperatorCkbSender('0x1234'),
        /OPERATOR_CKB_PRIVATE_KEY must be a valid 32-byte hex private key/,
      );
    });

    it('accepts valid 64-hex private key with or without 0x prefix', () => {
      const validKeyNoPrefix = '1'.repeat(64);
      const validKeyWithPrefix = '0x' + '1'.repeat(64);

      assert.doesNotThrow(() => new CccOperatorCkbSender(validKeyNoPrefix));
      assert.doesNotThrow(() => new CccOperatorCkbSender(validKeyWithPrefix));
    });

    it('thrown Error from sendCapacityGift redacts the full private key even if inner CCC/client error contained it', async () => {
      const mockClient = new ClientPublicTestnet();
      const rawKeyNoPrefix = DUMMY_OPERATOR_KEY.slice(2);

      // Simulate a CCC internal failure whose message includes both prefixed and raw full 64-hex keys
      mockClient.findCells = async function* () {
        throw new Error(`CCC internal cell collector failed with private key ${DUMMY_OPERATOR_KEY} and raw key ${rawKeyNoPrefix}`);
      };

      const sender = new CccOperatorCkbSender(DUMMY_OPERATOR_KEY, mockClient);

      await assert.rejects(
        () => sender.sendCapacityGift(VALID_TESTNET_ADDRESS, 200),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          const msg = err.message;
          assert.equal(msg.includes(DUMMY_OPERATOR_KEY), false, 'Error message must not contain prefixed full key');
          assert.equal(msg.includes(rawKeyNoPrefix), false, 'Error message must not contain raw full key');
          assert.ok(msg.includes('[REDACTED_KEY]'), 'Error message must contain [REDACTED_KEY]');
          assert.match(msg, /Operator CKB gift transfer failed/);
          return true;
        },
      );
    });
  });

  describe('HTTP routes: POST /api/bootstrap and GET /api/bootstrap/:sessionId', () => {
    it('returns HTTP 400 when funding_address is missing', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ node_pubkey: VALID_PUBKEY }),
        });

        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /funding_address/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns HTTP 400 when node_pubkey is invalid', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            node_pubkey: 'invalid_pubkey',
            funding_address: VALID_TESTNET_ADDRESS,
          }),
        });

        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /node_pubkey/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns HTTP 400 when funding_address is a mainnet address', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            node_pubkey: VALID_PUBKEY,
            funding_address: MAINNET_ADDRESS,
          }),
        });

        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /funding_address.*testnet/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('returns HTTP 501 when OPERATOR_CKB_PRIVATE_KEY is not configured', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            node_pubkey: VALID_PUBKEY,
            funding_address: VALID_TESTNET_ADDRESS,
          }),
        });

        assert.equal(res.status, 501);
        const body = (await res.json()) as { status: string; message: string };
        assert.equal(body.status, 'failed');
        assert.match(body.message, /Scheme B/i);
        assert.match(body.message, /not wired/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('GET /api/bootstrap/:sessionId returns HTTP 404 for unknown session', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api', apiRouter);

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap/nonexistent-session`);
        assert.equal(res.status, 404);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /not found/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('end-to-end async HTTP flow: POST /api/bootstrap returns 201 before wait; GET shows channel after wait', async () => {
      let resolveWait!: () => void;
      const waitPromise = new Promise<void>((resolve) => {
        resolveWait = resolve;
      });

      const mockSender: OperatorCkbSender = {
        sendCapacityGift: async () => ({ txHash: '0x' + 'aa'.repeat(32) }),
        waitForTransaction: async () => {
          await waitPromise;
        },
      };

      const mockGateway: CchGateway = {
        createOrder: async () => { throw new Error('not implemented'); },
        getOrder: async () => null,
        health: async () => true,
        getNodeInfo: async () => ({
          node_id: VALID_PUBKEY,
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 1,
          peer_count: 2,
        }),
        openChannel: async () => ({ channel_id: '0x' + 'bb'.repeat(32) }),
      };

      const customPrep = (req: { node_pubkey: string; funding_address: string }) =>
        prepareInboundLiquidity(req, {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorCkbSender: mockSender,
          cchGateway: mockGateway,
        });

      const app = express();
      app.use(express.json());
      app.use('/api', createApiRouter({ prepareInboundLiquidity: customPrep }));

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        // 1. POST /api/bootstrap returns immediately with 201 provisioning_liquidity
        const postRes = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            node_pubkey: VALID_PUBKEY,
            funding_address: VALID_TESTNET_ADDRESS,
          }),
        });

        assert.equal(postRes.status, 201);
        const postBody = (await postRes.json()) as {
          session_id: string;
          status: string;
          gift_tx_hash: string;
          channel_id?: string;
        };
        assert.equal(postBody.status, 'provisioning_liquidity');
        assert.equal(postBody.gift_tx_hash, '0x' + 'aa'.repeat(32));
        assert.equal(postBody.channel_id, undefined);

        // 2. GET /api/bootstrap/:sessionId before wait completes shows provisioning without channel_id
        const getRes1 = await fetch(`http://127.0.0.1:${port}/api/bootstrap/${postBody.session_id}`);
        assert.equal(getRes1.status, 200);
        const getBody1 = (await getRes1.json()) as {
          status: string;
          gift_tx_hash: string;
          channel_id?: string;
        };
        assert.equal(getBody1.status, 'provisioning_liquidity');
        assert.equal(getBody1.channel_id, undefined);

        // 3. Resolve waitTransaction and await background task
        resolveWait();
        const task = getBootstrapSessionTask(postBody.session_id);
        assert.ok(task);
        await task;

        // 4. GET /api/bootstrap/:sessionId after wait completes shows channel_id
        const getRes2 = await fetch(`http://127.0.0.1:${port}/api/bootstrap/${postBody.session_id}`);
        assert.equal(getRes2.status, 200);
        const getBody2 = (await getRes2.json()) as {
          status: string;
          gift_tx_hash: string;
          channel_id: string;
        };
        assert.equal(getBody2.status, 'provisioning_liquidity');
        assert.equal(getBody2.channel_id, '0x' + 'bb'.repeat(32));
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
