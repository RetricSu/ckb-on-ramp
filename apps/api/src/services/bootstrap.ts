import { randomUUID } from 'node:crypto';
import type { BootstrapRequest, BootstrapSession } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';

const CKB_TESTNET_ADDRESS_REGEX = /^ckt1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,120}$/i;
const SECP256K1_PUBKEY_REGEX = /^(0x)?[0-9a-fA-F]{66}$/;

export function validateBootstrapRequest(input: Partial<BootstrapRequest>): BootstrapRequest {
  const nodePubkey = String(input.node_pubkey ?? '').trim();
  if (!SECP256K1_PUBKEY_REGEX.test(nodePubkey)) {
    throw new Error('node_pubkey must be a compressed secp256k1 public key (66 hex characters)');
  }
  const fundingAddress = String(input.funding_address ?? '').trim();
  if (!CKB_TESTNET_ADDRESS_REGEX.test(fundingAddress)) {
    throw new Error('funding_address must be a valid CKB testnet address (starting with ckt1)');
  }
  return { node_pubkey: nodePubkey, funding_address: fundingAddress };
}

export async function prepareInboundLiquidity(input: BootstrapRequest): Promise<BootstrapSession> {
  const validated = validateBootstrapRequest(input);
  if (config.mode === 'rpc') {
    return {
      session_id: randomUUID(),
      status: 'failed',
      message: 'Scheme B inbound-liquidity provisioning (unpaid CKB capacity gift) is not wired: operator CKB send is not wired and channel funding is not implemented.',
    };
  }
  return {
    session_id: randomUUID(),
    status: 'ready',
    peer_address: `/dns4/mock-provider.test/tcp/8228/p2p/${validated.node_pubkey.replace(/^0x/, '')}`,
    channel_id: `mock_${randomUUID()}`,
    message: 'Mock inbound route is ready (simulated Phase-1 Scheme B gifted capacity).',
  };
}

