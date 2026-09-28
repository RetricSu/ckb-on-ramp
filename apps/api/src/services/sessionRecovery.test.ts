import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BootstrapSession, CkbScript } from '@ckb-on-ramp/contracts';
import {
  FileBootstrapSessionStore,
  MemoryBootstrapSessionStore,
} from './bootstrapStore.js';
import {
  clearBootstrapSessionsForTest,
  getBootstrapSession,
  getBootstrapSessionByChannelId,
  recoverSessionFromFnn,
  setBootstrapSessionStore,
} from './bootstrap.js';
import { createApiRouter } from '../routes/api.js';
import { RpcCchGateway, type CchGateway } from './cch.js';
import type { OperatorCkbSender } from './ccc.js';

describe('Bootstrap Session Persistence and Recovery', () => {
  let tempDir: string;
  let storeFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
    storeFile = path.join(tempDir, 'bootstrap-sessions.json');
  });

  afterEach(() => {
    clearBootstrapSessionsForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('FileBootstrapSessionStore persists sessions across simulated API restarts', () => {
    // Phase 1: Pre-restart API process
    const store1 = new FileBootstrapSessionStore(storeFile);
    const session: BootstrapSession = {
      session_id: 'session-persist-1',
      channel_id: '0x1111222233334444',
      status: 'provisioning_liquidity',
      node_pubkey: '029a8d5bd239bc1d7f85d65dc319022fc5934a41871473d63306b4022ee58c1e09',
      funding_amount: '100000000',
      signed: false,
      expires_at: Date.now() + 60_000,
      message: 'Provisioning liquidity test session',
    };
    store1.set(session.session_id, session);

    assert.equal(store1.get('session-persist-1')?.status, 'provisioning_liquidity');
    assert.equal(store1.getByChannelId('0x1111222233334444')?.session_id, 'session-persist-1');

    // Phase 2: Simulated API restart (instantiate new store pointing to same file)
    const store2 = new FileBootstrapSessionStore(storeFile);
    const restored = store2.get('session-persist-1');
    assert.ok(restored, 'Session must exist after restart');
    assert.equal(restored.session_id, 'session-persist-1');
    assert.equal(restored.channel_id, '0x1111222233334444');
    assert.equal(restored.status, 'provisioning_liquidity');
    assert.equal(restored.funding_amount, '100000000');

    // Also verify retrieval by channelId after restart
    const byChannel = store2.getByChannelId('0x1111222233334444');
    assert.ok(byChannel);
    assert.equal(byChannel.session_id, 'session-persist-1');
  });

  it('recovers session from FNN list_channels on store miss', async () => {
    const memStore = new MemoryBootstrapSessionStore();
    setBootstrapSessionStore(memStore);

    const fakeGateway: CchGateway = {
      createOrder: async () => { throw new Error('unused'); },
      getOrder: async () => null,
      health: async () => true,
      getNodeInfo: async () => ({
        node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
        addresses: [],
        channel_count: 1,
        peer_count: 1,
      }),
      openChannel: async () => ({ channel_id: '0xmock' }),
      listChannels: async () => ({
        channels: [
          {
            channel_id: '0xrecoveredchannel123',
            pubkey: '029a8d5bd239bc1d7f85d65dc319022fc5934a41871473d63306b4022ee58c1e09',
            is_acceptor: true,
            state: { state_name: 'NegotiatingFunding' },
          },
        ],
      }),
    };

    // Store is empty; lookup by channelId returns undefined
    assert.equal(getBootstrapSessionByChannelId('0xrecoveredchannel123'), undefined);

    // Call recoverSessionFromFnn
    const recovered = await recoverSessionFromFnn('0xrecoveredchannel123', fakeGateway, '100000000');
    assert.ok(recovered, 'Should recover session from FNN channels');
    assert.equal(recovered.channel_id, '0xrecoveredchannel123');
    assert.equal(recovered.status, 'provisioning_liquidity');
    assert.equal(recovered.funding_amount, '100000000');
    assert.equal(recovered.signed, false);

    // Session is now stored in activeStore
    assert.ok(getBootstrapSession(recovered.session_id));
    assert.equal(getBootstrapSessionByChannelId('0xrecoveredchannel123')?.session_id, recovered.session_id);
  });

  it('POST /api/sign-funding recovers session from FNN when missing from store after API restart', async () => {
    // Empty store simulating complete cache loss / miss
    const memStore = new MemoryBootstrapSessionStore();
    setBootstrapSessionStore(memStore);

    let signedPayload: unknown = null;
    const fakeSender: OperatorCkbSender = {
      sendCapacityGift: async () => ({ txHash: '0x123' }),
      signFundingTransaction: async (unsignedTx: unknown) => {
        const base = unsignedTx && typeof unsignedTx === 'object' ? unsignedTx : {};
        signedPayload = { ...base, operatorSigned: true };
        return signedPayload;
      },
    };

    const fakeGateway: CchGateway = {
      createOrder: async () => { throw new Error('unused'); },
      getOrder: async () => null,
      health: async () => true,
      getNodeInfo: async () => ({
        node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
        addresses: [],
        channel_count: 1,
        peer_count: 1,
      }),
      openChannel: async () => ({ channel_id: '0xmock' }),
      listChannels: async () => ({
        channels: [
          {
            channel_id: '0xchannelafterrestart',
            pubkey: '029a8d5bd239bc1d7f85d65dc319022fc5934a41871473d63306b4022ee58c1e09',
            is_acceptor: true,
          },
        ],
      }),
    };

    const router = createApiRouter({
      cchGateway: fakeGateway,
      operatorCkbSender: fakeSender,
    });

    // Simulate POST /api/sign-funding request directly via express route handler or mock req/res
    const req = {
      body: {
        channel_id: '0xchannelafterrestart',
        unsigned_funding_tx: { mockTx: true },
      },
    };
    let responseStatus = 200;
    let responseBody: unknown = null;
    const res = {
      status: (code: number) => {
        responseStatus = code;
        return res;
      },
      json: (data: unknown) => {
        responseBody = data;
      },
    };

    // Find and execute the /sign-funding handler
    interface ExpressRouteLayer {
      route?: {
        path?: string;
        methods?: Record<string, boolean>;
        stack: Array<{
          handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => Promise<void> | void;
        }>;
      };
    }
    const routeLayer = (router.stack as ExpressRouteLayer[]).find(
      (layer) => layer.route?.path === '/sign-funding' && layer.route?.methods?.post,
    );
    assert.ok(routeLayer, 'Must find /sign-funding route');
    const handler = routeLayer.route?.stack[0]?.handle;
    assert.ok(handler, 'Must find /sign-funding handler');

    await handler(req, res, () => {});

    assert.equal(responseStatus, 200, `Expected 200, got ${responseStatus}: ${JSON.stringify(responseBody)}`);
    assert.deepEqual(responseBody, {
      channel_id: '0xchannelafterrestart',
      signed_funding_tx: { mockTx: true, operatorSigned: true },
    });
  });

  it('RpcCchGateway.getOrder queries get_cch_order as truth and succeeds with empty in-memory cache', async () => {
    // Intercept fetch to mock FNN get_cch_order RPC
    const originalFetch = globalThis.fetch;
    const testPaymentHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.method === 'get_cch_order') {
        assert.deepEqual(body.params, [{ payment_hash: testPaymentHash }]);
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              payment_hash: testPaymentHash,
              status: 'Success',
              incoming_invoice: { Lightning: 'lnbc100n1mockorder' },
              outgoing_pay_req: 'fibt1mockfiberinv',
              amount_sats: '1000',
              fee_sats: '10',
            },
          }),
        } as Response;
      }
      throw new Error(`Unexpected RPC call: ${body.method}`);
    }) as typeof fetch;

    try {
      const gateway = new RpcCchGateway('http://127.0.0.1:8227', 'http://127.0.0.1:8227');

      // Crucial test: in-memory orders cache is completely empty (e.g. API restarted)
      const order = await gateway.getOrder(testPaymentHash);

      assert.ok(order, 'Order should be reconstructed from get_cch_order');
      assert.equal(order.payment_hash, testPaymentHash);
      assert.equal(order.status, 'Success');
      assert.equal(order.lightning_invoice, 'lnbc100n1mockorder');
      assert.equal(order.fiber_invoice, 'fibt1mockfiberinv');
      assert.equal(order.pay_sats, 1000);
      assert.equal(order.fee_sats, 10);
      assert.equal(order.receive_raw, '990');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
