import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import { createApiRouter } from '../routes/api.js';
import { setBootstrapSessionStore } from './bootstrap.js';
import { MemoryBootstrapSessionStore } from './bootstrapStore.js';
import type { CchGateway, FnnChannelItem } from './cch.js';

const channelId = `0x${'ab'.repeat(32)}`;
const pubkey = `02${'cd'.repeat(32)}`;
const txHash = `0x${'ef'.repeat(32)}`;
afterEach(() => setBootstrapSessionStore(new MemoryBootstrapSessionStore()));
async function query(channel: Partial<FnnChannelItem>, known = true) {
  const store = new MemoryBootstrapSessionStore();
  if (known) store.set('session', { session_id: 'session', status: 'ready', message: '', channel_id: channelId, node_pubkey: pubkey });
  setBootstrapSessionStore(store);
  let listed = false;
  const gateway = { listChannels: async (params: unknown) => {
    listed = true;
    assert.deepEqual(params, { include_closed: true, pubkey });
    return { channels: [{ channel_id: channelId, pubkey, is_acceptor: true, state: { state_name: 'Closed', state_flags: 'COOPERATIVE' }, shutdown_transaction_hash: txHash, ...channel }] };
  } } as CchGateway;
  const app = express(); app.use(createApiRouter({ cchGateway: gateway }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/channels/${channelId}/close`);
    return { status: response.status, body: await response.json(), listed, store };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
describe('read-only cooperative close lookup', () => {
  it('returns the known channel hash without changing its session', async () => {
    const got = await query({ pubkey: `0x${pubkey}` });
    assert.equal(got.status, 200);
    assert.equal(got.body.shutdown_transaction_hash, txHash);
    assert.equal(got.store.get('session')?.signed, undefined);
  });
  it('does not query FNN or reconstruct a missing session', async () => {
    const got = await query({}, false);
    assert.equal(got.status, 404); assert.equal(got.listed, false); assert.deepEqual(got.store.all(), []);
  });
  for (const [name, channel] of [
    ['different peer', { pubkey: `03${'11'.repeat(32)}` }],
    ['different channel', { channel_id: `0x${'11'.repeat(32)}` }],
    ['pending close', { state: { state_name: 'ShuttingDown', state_flags: 'COOPERATIVE' } }],
    ['force close', { state: { state_name: 'Closed', state_flags: 'UNCOOPERATIVE' } }],
    ['malformed hash', { shutdown_transaction_hash: '0x123' }],
  ] as Array<[string, Partial<FnnChannelItem>]>) {
    it(`ignores ${name}`, async () => assert.equal((await query(channel)).body.shutdown_transaction_hash, null));
  }
});
