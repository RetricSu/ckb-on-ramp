export type Environment = 'mock' | 'testnet';
export type BootstrapStatus = 'waiting_for_node' | 'connecting_peer' | 'waiting_for_channel' | 'provisioning_liquidity' | 'ready' | 'failed';
export interface BootstrapRequest {
  node_pubkey: string;
  funding_address?: string;
  external_funding?: boolean;
}
export interface BootstrapSession {
  session_id: string;
  status: BootstrapStatus;
  peer_address?: string;
  channel_id?: string;
  gift_tx_hash?: string;
  message: string;
  node_pubkey?: string;
  funding_amount?: string;
  expires_at?: number;
  signed?: boolean;
  failure_code?: 'not_configured' | 'operator_inventory_insufficient';
}
export interface QuoteRequest { receive_raw: string; }
export interface Quote {
  quote_id: string;
  receive_raw: string;
  pay_sats: number;
  fee_sats: number;
  expires_at: string;
}
export type OrderStatus = 'Pending' | 'IncomingAccepted' | 'OutgoingInFlight' | 'OutgoingSuccess' | 'Success' | 'Failed' | 'Expired';
export interface CreateOrderRequest { fiber_invoice: string; quote_id: string; }
export interface SwapOrder {
  order_id: string;
  payment_hash: string;
  status: OrderStatus;
  lightning_invoice: string;
  fiber_invoice: string;
  receive_raw: string;
  pay_sats: number;
  fee_sats: number;
  created_at: string;
  failure_reason?: string;
}
export interface HealthResponse {
  ok: boolean;
  mode: Environment;
  fnn_reachable: boolean;
  can_receive: boolean;
  unavailable_reason?: string;
}
export interface CkbScript {
  code_hash: string;
  hash_type: 'type' | 'data' | 'data1' | 'data2';
  args: string;
}
export interface NodeInfo {
  node_id: string;
  addresses: string[];
  channel_count: number;
  peer_count: number;
  funding_lock_script?: CkbScript;
  operator_channel_funding_amount?: string;
  can_receive?: boolean;
  unavailable_reason?: string;
}
export interface SignFundingRequest {
  channel_id: string;
  unsigned_funding_tx: unknown;
}
export interface SignFundingResponse {
  channel_id: string;
  signed_funding_tx: unknown;
}
export const CWBTC_SCRIPT = {
  code_hash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb' as `0x${string}`,
  hash_type: 'type' as const,
  args: '0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000' as `0x${string}`,
};

/**
 * Normalizes a channel state name to uppercase alphanumeric characters
 * to reliably match regardless of casing (e.g. "NegotiatingFunding" vs "NEGOTIATING_FUNDING").
 */
export function normalizeChannelStateName(stateName?: string): string {
  return (stateName ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

// CKB Transaction key normalization helpers
// Derived from @fiber-pay/sdk src/browser/ckb-transaction-normalizer.ts
// for shared isomorphism between browser client and Node.js server.
export const CKB_TX_KEY_TO_CAMEL: Record<string, string> = {
  cell_deps: 'cellDeps',
  header_deps: 'headerDeps',
  outputs_data: 'outputsData',
  out_point: 'outPoint',
  dep_type: 'depType',
  previous_output: 'previousOutput',
  tx_hash: 'txHash',
  code_hash: 'codeHash',
  hash_type: 'hashType',
};
export const CKB_TX_KEY_TO_SNAKE: Record<string, string> = Object.fromEntries(
  Object.entries(CKB_TX_KEY_TO_CAMEL).map(([snake, camel]) => [camel, snake]),
);
export function normalizeDepType(value: unknown, direction: 'to-camel' | 'to-snake'): unknown {
  if (direction === 'to-camel' && value === 'dep_group') return 'depGroup';
  if (direction === 'to-snake' && value === 'depGroup') return 'dep_group';
  return value;
}
export function normalizeCkbTransactionByDirection(value: unknown, direction: 'to-camel' | 'to-snake'): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCkbTransactionByDirection(item, direction));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const map = direction === 'to-camel' ? CKB_TX_KEY_TO_CAMEL : CKB_TX_KEY_TO_SNAKE;
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    const mappedKey = map[key] ?? key;
    let mappedValue = normalizeCkbTransactionByDirection(item, direction);
    if (mappedKey === 'dep_type' || mappedKey === 'depType') {
      mappedValue = normalizeDepType(mappedValue, direction);
    }
    next[mappedKey] = mappedValue;
  }
  return next;
}
export function normalizeCkbTransactionForCcc(value: unknown): unknown {
  return normalizeCkbTransactionByDirection(value, 'to-camel');
}
export function normalizeCkbTransactionForRpc(value: unknown): unknown {
  return normalizeCkbTransactionByDirection(value, 'to-snake');
}
