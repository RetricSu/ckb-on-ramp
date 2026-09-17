import { randomUUID } from 'node:crypto';
import type { BootstrapSession } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';

export async function prepareInboundLiquidity(nodePubkey: string): Promise<BootstrapSession> {
  if (!/^(0x)?[0-9a-fA-F]{66}$/.test(nodePubkey)) throw new Error('node_pubkey must be a compressed secp256k1 public key');
  if (config.mode === 'rpc') {
    return { session_id: randomUUID(), status: 'failed', message: 'Inbound-liquidity provisioning is not wired. Implement the operator/LSP adapter before enabling real deposits.' };
  }
  return {
    session_id: randomUUID(), status: 'ready',
    peer_address: `/dns4/mock-provider.test/tcp/8228/p2p/${nodePubkey.replace(/^0x/, '')}`,
    channel_id: `mock_${randomUUID()}`, message: 'Mock inbound route is ready.',
  };
}
