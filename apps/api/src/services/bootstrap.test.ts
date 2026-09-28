import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { beforeEach, describe, it } from 'node:test';
import express from 'express';
import { ClientPublicTestnet } from '@ckb-ccc/core';
import { CWBTC_SCRIPT, type BootstrapRequest } from '@ckb-on-ramp/contracts';
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
const SUFFICIENT_INVENTORY = {
  giftCapacityShannons: 300n * 100_000_000n,
  fnnCwbtcCells: [{ capacityShannons: 200n * 100_000_000n, amount: 100_000_000n }],
};

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

    it('fails closed before sending a gift when operator inventory is insufficient', async () => {
      let giftCalled = false;
      const session = await prepareInboundLiquidity(
        { node_pubkey: VALID_PUBKEY, funding_address: VALID_TESTNET_ADDRESS },
        {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorCkbSender: {
            sendCapacityGift: async () => {
              giftCalled = true;
              return { txHash: '0x' + 'aa'.repeat(32) };
            },
          },
          operatorInventory: {
            giftCapacityShannons: 100n,
            fnnCwbtcCells: [],
          },
          cchGateway: {
            createOrder: async () => { throw new Error('not used'); },
            getOrder: async () => null,
            health: async () => true,
            getNodeInfo: async () => ({ node_id: VALID_PUBKEY, addresses: [], channel_count: 0, peer_count: 0 }),
            openChannel: async () => { throw new Error('must not open'); },
          },
        },
      );

      assert.equal(session.status, 'failed');
      assert.equal(session.failure_code, 'operator_inventory_insufficient');
      assert.match(session.message, /inventory is insufficient/i);
      assert.equal(giftCalled, false);
    });

    it('fails closed before opening a channel when FNN cWBTC inventory is insufficient', async () => {
      let openCalled = false;
      const session = await prepareInboundLiquidity(
        { node_pubkey: VALID_PUBKEY, external_funding: true },
        {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorInventory: {
            giftCapacityShannons: 300n * 100_000_000n,
            fnnCwbtcCells: [{ capacityShannons: 200n * 100_000_000n, amount: 99_999_999n }],
          },
          cchGateway: {
            createOrder: async () => { throw new Error('not used'); },
            getOrder: async () => null,
            health: async () => true,
            getNodeInfo: async () => ({ node_id: VALID_PUBKEY, addresses: [], channel_count: 0, peer_count: 0 }),
            openChannel: async () => {
              openCalled = true;
              return { channel_id: 'must-not-open' };
            },
          },
        },
      );

      assert.equal(session.status, 'failed');
      assert.match(session.message, /FNN cWBTC inventory is insufficient/);
      assert.equal(openCalled, false);
      assert.equal(getBootstrapSessionTask(session.session_id), undefined);
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
          operatorInventory: SUFFICIENT_INVENTORY,
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
          operatorInventory: SUFFICIENT_INVENTORY,
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
              operatorInventory: SUFFICIENT_INVENTORY,
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
          operatorInventory: SUFFICIENT_INVENTORY,
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

      const customPrep = (req: BootstrapRequest) =>
        prepareInboundLiquidity(req, {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorInventory: SUFFICIENT_INVENTORY,
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

  describe('External funding flow (Operator as Acceptor & Signer)', () => {
    it('validateBootstrapRequest accepts external_funding=true without funding_address', () => {
      const res = validateBootstrapRequest({
        node_pubkey: VALID_PUBKEY,
        external_funding: true,
      });
      assert.equal(res.node_pubkey, VALID_PUBKEY);
      assert.equal(res.funding_address, undefined);
      assert.equal(res.external_funding, true);
    });

    it('prepareInboundLiquidity with external_funding watches and accepts pending channel', async () => {
      let acceptedChannelId: string | undefined;
      let acceptedFundingAmount: string | undefined;

      const mockGateway: CchGateway = {
        createOrder: async () => { throw new Error('not used'); },
        getOrder: async () => null,
        health: async () => true,
        getNodeInfo: async () => ({
          node_id: VALID_PUBKEY,
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 1,
          peer_count: 2,
        }),
        openChannel: async () => ({ channel_id: 'not_used' }),
        listChannels: async () => ({
          channels: [
            {
              channel_id: '0x' + 'cc'.repeat(32),
              pubkey: VALID_PUBKEY,
              is_acceptor: true,
              state: { state_name: 'NegotiatingFunding' },
            },
          ],
        }),
        acceptChannel: async (params) => {
          acceptedChannelId = params.temporary_channel_id;
          acceptedFundingAmount = params.funding_amount;
          return { channel_id: '0x' + 'dd'.repeat(32) };
        },
      };

      const session = await prepareInboundLiquidity(
        {
          node_pubkey: VALID_PUBKEY,
          external_funding: true,
        },
        {
          operatorPrivateKey: DUMMY_OPERATOR_KEY,
          operatorInventory: SUFFICIENT_INVENTORY,
          cchGateway: mockGateway,
        },
      );

      assert.equal(session.status, 'waiting_for_channel');
      assert.equal(session.gift_tx_hash, undefined);

      const task = getBootstrapSessionTask(session.session_id);
      assert.ok(task);
      await task;

      assert.equal(acceptedChannelId, '0x' + 'cc'.repeat(32));
      assert.equal(acceptedFundingAmount, '0x5f5e100'); // 1.0 cWBTC

      const updated = getBootstrapSession(session.session_id);
      assert.ok(updated);
      assert.equal(updated.status, 'provisioning_liquidity');
      assert.equal(updated.channel_id, '0x' + 'dd'.repeat(32));
    });

    it('POST /api/sign-funding enforces real session-gate binding and one-time consumption (replay prevention)', async () => {
      const DUMMY_ACCEPTED_CHANNEL_ID = '0x' + 'ab'.repeat(32);
      const mockGateway: CchGateway = {
        createOrder: async () => { throw new Error('not used'); },
        getOrder: async () => null,
        health: async () => true,
        getNodeInfo: async () => ({
          node_id: VALID_PUBKEY,
          addresses: ['/ip4/127.0.0.1/tcp/18328/ws'],
          channel_count: 1,
          peer_count: 2,
        }),
        openChannel: async () => ({ channel_id: 'not_used' }),
        listChannels: async () => ({
          channels: [
            {
              channel_id: '0x' + 'cc'.repeat(32),
              pubkey: VALID_PUBKEY,
              is_acceptor: true,
              state: { state_name: 'NegotiatingFunding' },
            },
          ],
        }),
        acceptChannel: async () => ({ channel_id: DUMMY_ACCEPTED_CHANNEL_ID }),
      };

      const mockSender: OperatorCkbSender = {
        sendCapacityGift: async () => ({ txHash: '0x' }),
        signFundingTransaction: async (tx) => ({ ...(tx as object), witnesses: ['0xsigned'] }),
      };

      // Create and accept real session
      const session = await prepareInboundLiquidity(
        { node_pubkey: VALID_PUBKEY, external_funding: true },
        { operatorPrivateKey: DUMMY_OPERATOR_KEY, operatorInventory: SUFFICIENT_INVENTORY, cchGateway: mockGateway },
      );
      await getBootstrapSessionTask(session.session_id);

      const app = express();
      app.use(express.json());
      // Real session check enabled (skipSessionCheck is false by default)
      app.use('/api', createApiRouter({ operatorCkbSender: mockSender, operatorInventory: SUFFICIENT_INVENTORY }));

      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        // 1. Missing channel_id
        const res1 = await fetch(`http://127.0.0.1:${port}/api/sign-funding`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unsigned_funding_tx: {} }),
        });
        assert.equal(res1.status, 400);

        // 2. Missing unsigned_funding_tx
        const res2 = await fetch(`http://127.0.0.1:${port}/api/sign-funding`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel_id: DUMMY_ACCEPTED_CHANNEL_ID }),
        });
        assert.equal(res2.status, 400);

        // 3. Unassociated channel_id is rejected with 400
        const unassocRes = await fetch(`http://127.0.0.1:${port}/api/sign-funding`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            channel_id: '0x' + '99'.repeat(32),
            unsigned_funding_tx: { inputs: [], outputs: [] },
          }),
        });
        assert.equal(unassocRes.status, 400);
        const unassocBody = (await unassocRes.json()) as any;
        assert.match(unassocBody.error, /not associated with an accepted bootstrap session/);

        // 4. Associated channel_id succeeds on first attempt
        const validRes = await fetch(`http://127.0.0.1:${port}/api/sign-funding`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            channel_id: DUMMY_ACCEPTED_CHANNEL_ID,
            unsigned_funding_tx: { inputs: [], outputs: [] },
          }),
        });
        assert.equal(validRes.status, 200);
        const validBody = (await validRes.json()) as any;
        assert.equal(validBody.channel_id, DUMMY_ACCEPTED_CHANNEL_ID);
        assert.deepEqual(validBody.signed_funding_tx.witnesses, ['0xsigned']);

        // 5. Replay with the same channel_id is rejected (session is one-time consumed)
        const replayRes = await fetch(`http://127.0.0.1:${port}/api/sign-funding`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            channel_id: DUMMY_ACCEPTED_CHANNEL_ID,
            unsigned_funding_tx: { inputs: [], outputs: [] },
          }),
        });
        assert.equal(replayRes.status, 400);
        const replayBody = (await replayRes.json()) as any;
        assert.match(replayBody.error, /already been signed/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('signFundingTransaction enforces 3 security gates on real dual-funded UDT shape with UDT conservation', async () => {
      const DUMMY_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const tempSender = new CccOperatorCkbSender(DUMMY_KEY);
      const giftLock = await tempSender.getFundingLockScript!();
      const fnnLock = {
        codeHash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
        hashType: 'type' as const,
        args: '0x' + '22'.repeat(20),
      };

      // Input 0: Gift lock cell providing 300 CKB capacity
      const giftCell = {
        cellOutput: {
          capacity: '0x' + (300n * 100000000n).toString(16),
          lock: { codeHash: giftLock.code_hash, hashType: giftLock.hash_type, args: giftLock.args },
        },
        outputData: '0x',
      };

      // Input 1: FNN internal wallet cell providing 200 CKB capacity + 5.0 cWBTC UDT
      // 5.0 cWBTC = 500,000,000 raw = 0x1dcd6500
      const udt5cWbtcHex = '0x0065cd1d000000000000000000000000';
      const fnnUdtCell = {
        cellOutput: {
          capacity: '0x' + (200n * 100000000n).toString(16),
          lock: fnnLock,
          type: {
            codeHash: CWBTC_SCRIPT.code_hash,
            hashType: CWBTC_SCRIPT.hash_type,
            args: CWBTC_SCRIPT.args,
          },
        },
        outputData: udt5cWbtcHex,
      };

      const attackerLock = {
        codeHash: giftLock.code_hash,
        hashType: giftLock.hash_type,
        args: '0x' + '99'.repeat(20),
      };

      const baseClient = new ClientPublicTestnet();
      const fakeClient = Object.assign(Object.create(baseClient), {
        getCell: async (outPoint: any) => {
          if (outPoint.txHash === '0x' + '99'.repeat(32)) {
            return { cellOutput: { capacity: '0x4a817c800', lock: attackerLock }, outputData: '0x' };
          }
          if (outPoint.txHash === '0x' + '88'.repeat(32)) {
            return {
              cellOutput: { capacity: '0x8ba43b7400', lock: giftCell.cellOutput.lock },
              outputData: '0x',
            };
          }
          if (outPoint.txHash === '0x' + '22'.repeat(32)) {
            return fnnUdtCell;
          }
          return giftCell;
        },
      });

      const sender = new CccOperatorCkbSender(DUMMY_KEY, fakeClient as any);
      const signOpts = {
        allowedAdditionalInputLocks: [fnnLock],
        expectedExactUdtAmount: 100_000_000n, // 1.0 cWBTC
      };

      // Gate (a) failure: unknown input cell not belonging to allowed locks
      const txWithForeignInput = {
        inputs: [{ previous_output: { tx_hash: '0x' + '99'.repeat(32), index: '0x0' }, since: '0x0' }],
        outputs: [
          {
            capacity: '0x' + (184n * 100000000n).toString(16),
            lock: { code_hash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', hash_type: 'type', args: '0x1234' },
            type: CWBTC_SCRIPT,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000'],
      };
      await assert.rejects(
        () => sender.signFundingTransaction!(txWithForeignInput, signOpts),
        /Unauthorized input cell/,
      );

      // Gate (c) failure: total input capacity exceeds 800 CKB budget
      const txWithExcessiveCapacity = {
        inputs: [{ previous_output: { tx_hash: '0x' + '88'.repeat(32), index: '0x0' }, since: '0x0' }],
        outputs: [
          {
            capacity: '0x' + (184n * 100000000n).toString(16),
            lock: { code_hash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', hash_type: 'type', args: '0x1234' },
            type: CWBTC_SCRIPT,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000'],
      };
      await assert.rejects(
        () => sender.signFundingTransaction!(txWithExcessiveCapacity, signOpts),
        /exceeds maximum allowed budget/,
      );

      // Gate (b) failure: funding output lock is NOT authorized Fiber FundingLock
      const txWithUnauthorizedFundingLock = {
        inputs: [{ previous_output: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' }, since: '0x0' }],
        outputs: [
          {
            capacity: '0x' + (184n * 100000000n).toString(16),
            lock: giftLock,
            type: CWBTC_SCRIPT,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000'],
      };
      await assert.rejects(
        () => sender.signFundingTransaction!(txWithUnauthorizedFundingLock, signOpts),
        /authorized Fiber FundingLock/,
      );

      // Gate (b) failure: change output stolen to attacker address
      const txWithStolenChange = {
        inputs: [{ previous_output: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' }, since: '0x0' }],
        outputs: [
          {
            capacity: '0x' + (184n * 100000000n).toString(16),
            lock: { code_hash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', hash_type: 'type', args: '0x1234' },
            type: CWBTC_SCRIPT,
          },
          {
            capacity: '0x' + (11599900000n).toString(16),
            lock: attackerLock,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000', '0x'],
      };
      await assert.rejects(
        () => sender.signFundingTransaction!(txWithStolenChange, signOpts),
        /Change output lock script does not return to operator funding lock/,
      );

      // Gate (b) failure: UDT not conserved (input 5.0 cWBTC, funding 1.0 cWBTC, but change only 3.5 cWBTC => 0.5 stolen)
      // 3.5 cWBTC = 350,000,000 raw = 0x14dc9380
      const udt35cWbtcHex = '0x8093dc14000000000000000000000000';
      const txWithUdtDrained = {
        inputs: [
          { previous_output: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' }, since: '0x0' },
          { previous_output: { tx_hash: '0x' + '22'.repeat(32), index: '0x0' }, since: '0x0' },
        ],
        outputs: [
          {
            capacity: '0x' + (184n * 100000000n).toString(16),
            lock: { code_hash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', hash_type: 'type', args: '0x1234' },
            type: CWBTC_SCRIPT,
          },
          {
            capacity: '0x' + (11599900000n).toString(16),
            lock: giftLock,
          },
          {
            capacity: '0x' + (19999900000n).toString(16),
            lock: fnnLock,
            type: CWBTC_SCRIPT,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000', '0x', udt35cWbtcHex],
      };
      await assert.rejects(
        () => sender.signFundingTransaction!(txWithUdtDrained, signOpts),
        /UDT balance is not conserved/,
      );

      // Gate failure: client attempts to lie with fake cellOutput capacity (on-chain check detects it)
      const txWithSpoofedInput = {
        inputs: [
          {
            previous_output: { tx_hash: '0x' + '88'.repeat(32), index: '0x0' },
            since: '0x0',
            cell_output: { capacity: '0x1000' }, // client claims 1 CKB
          },
        ],
        outputs: [
          {
            capacity: '0x1000',
            lock: {
              code_hash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c',
              hash_type: 'type',
              args: '0x1234',
            },
            type: CWBTC_SCRIPT,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000'],
      };
      await assert.rejects(
        () => sender.signFundingTransaction!(txWithSpoofedInput, signOpts),
        /exceeds maximum allowed budget/, // caught by real chain capacity 600 CKB > 500 CKB
      );

      // Gate failure: gift-side CKB not conserved (gift change omitted, gift funds siphoned)
      const txWithSiphonedGift = {
        inputs: [
          { previous_output: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' }, since: '0x0' },
          { previous_output: { tx_hash: '0x' + '22'.repeat(32), index: '0x0' }, since: '0x0' },
        ],
        outputs: [
          {
            capacity: '0x' + (184n * 100000000n).toString(16),
            lock: { code_hash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', hash_type: 'type', args: '0x1234' },
            type: CWBTC_SCRIPT,
          },
          {
            capacity: '0x' + (19999900000n).toString(16),
            lock: fnnLock,
            type: CWBTC_SCRIPT,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000', '0x0084d717000000000000000000000000'],
      };
      await assert.rejects(
        () => sender.signFundingTransaction!(txWithSiphonedGift, signOpts),
        /Gift funds not conserved/,
      );

      // Success: Authentic dual-funded UDT shape
      // Input 0: Gift lock (300 CKB)
      // Input 1: FNN wallet lock (200 CKB with 5.0 cWBTC)
      // Total inputs: 500 CKB, 5.0 cWBTC
      // Output 0 (Funding): 184 CKB with 1.0 cWBTC (0x00e1f505000000000000000000000000)
      // Output 1 (CKB change to gift lock): 115.999 CKB
      // Output 2 (UDT change to FNN lock): 199.999 CKB with 4.0 cWBTC (400,000,000 raw = 0x17d78400)
      // Total outputs: 499.998 CKB (0.002 CKB miner fee), 5.0 cWBTC (1.0 in funding + 4.0 in change)
      const udt4cWbtcHex = '0x0084d717000000000000000000000000';
      const authenticDualFundedTx = {
        inputs: [
          { previous_output: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' }, since: '0x0' },
          { previous_output: { tx_hash: '0x' + '22'.repeat(32), index: '0x0' }, since: '0x0' },
        ],
        outputs: [
          {
            capacity: '0x' + (184n * 100000000n).toString(16),
            lock: { code_hash: '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', hash_type: 'type', args: '0x1234' },
            type: CWBTC_SCRIPT,
          },
          {
            capacity: '0x' + (11599900000n).toString(16),
            lock: giftLock,
          },
          {
            capacity: '0x' + (19999900000n).toString(16),
            lock: fnnLock,
            type: CWBTC_SCRIPT,
          },
        ],
        outputs_data: ['0x00e1f505000000000000000000000000', '0x', udt4cWbtcHex],
        witnesses: ['0x', '0x'],
      };

      const signed = (await sender.signFundingTransaction!(authenticDualFundedTx, signOpts)) as any;
      assert.ok(signed);
      assert.ok(signed.witnesses);
      assert.ok(signed.witnesses.length > 0);
      assert.notEqual(signed.witnesses[0], '0x'); // gift lock witness was signed
    });
  });
});
