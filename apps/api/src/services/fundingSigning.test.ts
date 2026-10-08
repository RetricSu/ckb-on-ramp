import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BootstrapSession, SignFundingResponse } from '@ckb-on-ramp/contracts';
import { createApiRouter, type ApiRouterDependencies } from '../routes/api.js';
import { setBootstrapSessionStore } from './bootstrap.js';
import { FileBootstrapSessionStore, MemoryBootstrapSessionStore } from './bootstrapStore.js';
import { InflightOutpointsTracker } from './inflightOutpoints.js';

const CHANNEL_ID = '0x' + 'ab'.repeat(32);
const TX = {
  inputs: [{ previous_output: { tx_hash: '0x' + 'cd'.repeat(32), index: '0x0' } }],
  outputs: [],
  witnesses: ['0x'],
};
const SESSION: BootstrapSession = {
  session_id: 'accepted-session', channel_id: CHANNEL_ID, status: 'provisioning_liquidity',
  node_pubkey: '02' + '12'.repeat(32), funding_amount: '100000000',
  signed: false, message: 'Accepted', expires_at: Date.now() + 300_000,
};
const INVENTORY = {
  giftCapacityShannons: 30000000000n,
  fnnCwbtcCells: [{ capacityShannons: 20000000000n, amount: 100000000n }],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function signingRoute(deps: ApiRouterDependencies = {}) {
  const router = createApiRouter({
    cchGateway: {} as NonNullable<ApiRouterDependencies['cchGateway']>,
    operatorInventory: INVENTORY,
    inflightTracker: new InflightOutpointsTracker(),
    ...deps,
  });
  const layer = router.stack.find((item) => item.route?.path === '/sign-funding');
  const handler = layer?.route?.stack[0]?.handle;
  assert.ok(handler);
  const invokeHandler = handler as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>;
  return async (tx: unknown = TX, channelId = CHANNEL_ID) => {
    let status = 200;
    let body!: SignFundingResponse & { error?: string };
    const res = {
      status(code: number) { status = code; return res; },
      json(data: typeof body) { body = data; },
    };
    await invokeHandler({ body: { channel_id: channelId, unsigned_funding_tx: tx } }, res, () => {});
    return { status, body };
  };
}

describe('Funding signature authorization and recovery', () => {
  let tempDir: string;
  let store: MemoryBootstrapSessionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funding-signing-'));
    store = new MemoryBootstrapSessionStore();
    store.set(SESSION.session_id, { ...SESSION, expires_at: Date.now() + 300_000 });
    setBootstrapSessionStore(store);
  });
  afterEach(() => {
    setBootstrapSessionStore(new MemoryBootstrapSessionStore());
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('coalesces same-channel concurrent requests across the asynchronous inventory check', async () => {
    const inventory = deferred();
    let reads = 0;
    let signs = 0;
    const call = signingRoute({
      operatorInventory: undefined,
      cchGateway: { getFnnFundingLockScript: async () => ({}) } as NonNullable<ApiRouterDependencies['cchGateway']>,
      operatorCkbSender: {
        sendCapacityGift: async () => ({ txHash: 'unused' }),
        getInventory: async () => { reads++; await inventory.promise; return INVENTORY; },
        signFundingTransaction: async (tx) => { signs++; return { ...tx as object, witnesses: ['0xsigned'] }; },
      },
    });
    const first = call();
    const second = call();
    await new Promise<void>((resolve) => setImmediate(resolve));
    inventory.resolve();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.deepEqual(responses[0].body, responses[1].body);
    assert.equal(reads, 1);
    assert.equal(signs, 1);
  });

  it('rejects a different transaction while the same channel is being signed', async () => {
    const signing = deferred();
    let signs = 0;
    const call = signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; await signing.promise; return tx; },
    } });
    const first = call();
    const changedRequest = call({ ...TX, witnesses: ['0xchanged'] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    signing.resolve();
    const changed = await changedRequest;
    assert.equal((await first).status, 200);
    assert.equal(changed.status, 400);
    assert.equal(signs, 1);
  });

  it('does not sign if the authorization expires during asynchronous inventory checks', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    store.set(SESSION.session_id, { ...SESSION, expires_at: now + 1000 });
    const inventory = deferred();
    let signs = 0;
    const call = signingRoute({
      operatorInventory: undefined,
      cchGateway: { getFnnFundingLockScript: async () => ({}) } as NonNullable<ApiRouterDependencies['cchGateway']>,
      operatorCkbSender: {
        sendCapacityGift: async () => ({ txHash: 'unused' }),
        getInventory: async () => { await inventory.promise; return INVENTORY; },
        signFundingTransaction: async (tx) => { signs++; return tx; },
      },
    });
    const result = call();
    now += 2000;
    inventory.resolve();
    assert.equal((await result).status, 400);
    assert.equal(signs, 0);
    assert.equal(store.get(SESSION.session_id)?.signed, false);
  });

  it('does not authorize an old channel through a stale session index', async () => {
    store.set(SESSION.session_id, { ...SESSION, channel_id: '0x' + 'ef'.repeat(32) });
    let signs = 0;
    const result = await signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; return tx; },
    } })();
    assert.equal(result.status, 400);
    assert.equal(signs, 0);
  });

  it('retrieves a lost response after API restart without re-signing or requiring live inventory', async () => {
    const storeFile = path.join(tempDir, 'sessions.json');
    const firstStore = new FileBootstrapSessionStore(storeFile);
    firstStore.set(SESSION.session_id, { ...SESSION });
    setBootstrapSessionStore(firstStore);
    let signs = 0;
    const first = await signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; return { ...tx as object, witnesses: ['0xsigned'] }; },
    } })();
    assert.equal(first.status, 200);
    const restartedStore = new FileBootstrapSessionStore(storeFile);
    const saved = restartedStore.get(SESSION.session_id)!;
    restartedStore.set(saved.session_id, { ...saved, expires_at: Date.now() - 1 });
    setBootstrapSessionStore(restartedStore);
    const retry = await signingRoute()();
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, first.body);
    assert.equal(signs, 1);
    const changed = await signingRoute()({ ...TX, outputs: [{ capacity: '0x123' }] });
    assert.equal(changed.status, 400);
  });

  it('treats object key order and snake/camel transaction fields as the same request', async () => {
    let signs = 0;
    const call = signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; return tx; },
    } });
    const first = await call();
    const retry = await call({ witnesses: ['0x'], outputs: [], inputs: [{
      previousOutput: { index: '0x0', txHash: '0x' + 'cd'.repeat(32) },
    }] }, CHANNEL_ID.toUpperCase());
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, first.body);
    assert.equal(signs, 1);
  });

  it('does not reopen a legacy consumed session without a saved signature', async () => {
    store.set(SESSION.session_id, { ...SESSION, signed: true });
    let signs = 0;
    const result = await signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; return tx; },
    } })();
    assert.equal(result.status, 400);
    assert.equal(signs, 0);
  });

  it('refuses to re-sign an interrupted operation after restart', async () => {
    const signing = deferred();
    const firstCall = signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { await signing.promise; return tx; },
    } });
    const first = firstCall();
    await new Promise<void>((resolve) => setImmediate(resolve));
    let signs = 0;
    const retry = await signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; return tx; },
    } })();
    signing.resolve();
    await first;
    assert.equal(retry.status, 503);
    assert.equal(signs, 0);
  });

  for (const state of ['NegotiatingFunding', 'CollaboratingFundingTx', 'ChannelReady', 'Closed']) {
    it(`does not authorize ${state} channels from FNN when the durable session is missing`, async () => {
      store.clear();
      let signs = 0;
      const result = await signingRoute({
        cchGateway: { listChannels: async () => ({ channels: [{
          channel_id: CHANNEL_ID, pubkey: SESSION.node_pubkey!, is_acceptor: true,
          state: { state_name: state },
        }] }) } as NonNullable<ApiRouterDependencies['cchGateway']>,
        operatorCkbSender: {
          sendCapacityGift: async () => ({ txHash: 'unused' }),
          signFundingTransaction: async (tx) => { signs++; return tx; },
        },
      })();
      assert.equal(result.status, 400);
      assert.equal(signs, 0);
      assert.equal(store.all().length, 0);
    });
  }

  it('does not call the signer when the authorization reservation cannot be persisted', async () => {
    class FailingStore extends MemoryBootstrapSessionStore {
      override set() { throw new Error('Disk unavailable'); }
    }
    const failing = new FailingStore();
    // Seed through the base method so only the request's persistence fails.
    MemoryBootstrapSessionStore.prototype.set.call(failing, SESSION.session_id, { ...SESSION });
    setBootstrapSessionStore(failing);
    let signs = 0;
    const result = await signingRoute({ operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; return tx; },
    } })();
    assert.equal(result.status, 500);
    assert.equal(signs, 0);
    assert.equal(failing.get(SESSION.session_id)?.signed, false);
  });

  it('keeps authorization consumed if saving the signed result fails', async () => {
    const disk = new FileBootstrapSessionStore(path.join(tempDir, 'sessions.json'));
    disk.set(SESSION.session_id, { ...SESSION });
    setBootstrapSessionStore(disk);
    const originalSet = disk.set.bind(disk);
    let writes = 0;
    disk.set = (id, session) => {
      if (++writes === 2) throw new Error('Disk unavailable after signing');
      originalSet(id, session);
    };
    let signs = 0;
    const deps: ApiRouterDependencies = { operatorCkbSender: {
      sendCapacityGift: async () => ({ txHash: 'unused' }),
      signFundingTransaction: async (tx) => { signs++; return tx; },
    } };
    assert.equal((await signingRoute(deps)()).status, 500);
    setBootstrapSessionStore(new FileBootstrapSessionStore(path.join(tempDir, 'sessions.json')));
    assert.equal((await signingRoute(deps)()).status, 503);
    assert.equal(signs, 1);
  });

  it('preserves disk and memory state when atomic session replacement fails', (t) => {
    const storeFile = path.join(tempDir, 'sessions.json');
    const disk = new FileBootstrapSessionStore(storeFile);
    disk.set(SESSION.session_id, { ...SESSION });
    const before = fs.readFileSync(storeFile, 'utf-8');
    t.mock.method(fs, 'renameSync', () => { throw new Error('Rename failed'); });
    assert.throws(() => disk.set(SESSION.session_id, { ...SESSION, signed: true }), /Rename failed/);
    assert.equal(disk.get(SESSION.session_id)?.signed, false);
    assert.equal(fs.readFileSync(storeFile, 'utf-8'), before);
    assert.deepEqual(fs.readdirSync(tempDir), ['sessions.json']);
    assert.equal(new FileBootstrapSessionStore(storeFile).get(SESSION.session_id)?.signed, false);
  });

  it('fails closed on a corrupt session file instead of silently losing authorizations', () => {
    const storeFile = path.join(tempDir, 'sessions.json');
    fs.writeFileSync(storeFile, '[broken');
    assert.throws(() => new FileBootstrapSessionStore(storeFile), SyntaxError);
  });
});
