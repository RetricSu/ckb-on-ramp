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

// ---------------------------------------------------------------------------
// FNN (ckb_jsonrpc_types) transaction shape
//
// FNN's `submit_signed_funding_tx` (RPC and fiber-js WASM alike) deserializes the
// transaction with `deny_unknown_fields`. Any key outside this whitelist, e.g. the
// resolved-input metadata `cellOutput` / `outputData` that CCC attaches to inputs,
// makes the whole submission fail with "unknown field ...".
// ---------------------------------------------------------------------------
const FNN_TX_FIELDS = {
  transaction: ['version', 'cell_deps', 'header_deps', 'inputs', 'outputs', 'outputs_data', 'witnesses'],
  cell_dep: ['out_point', 'dep_type'],
  out_point: ['tx_hash', 'index'],
  input: ['previous_output', 'since'],
  output: ['capacity', 'lock', 'type'],
  script: ['code_hash', 'hash_type', 'args'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Returns the JSON paths of every key in `tx` that FNN's transaction deserializer
 * would reject as unknown. An empty array means the shape is acceptable.
 */
export function findNonFnnTransactionFields(tx: unknown): string[] {
  const problems: string[] = [];
  const check = (value: unknown, kind: keyof typeof FNN_TX_FIELDS, at: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (!(FNN_TX_FIELDS[kind] as readonly string[]).includes(key)) problems.push(`${at}.${key}`);
    }
  };
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

  const root = record(tx);
  check(tx, 'transaction', '$');
  asArray(root.cell_deps).forEach((dep, i) => {
    check(dep, 'cell_dep', `$.cell_deps[${i}]`);
    check(record(dep).out_point, 'out_point', `$.cell_deps[${i}].out_point`);
  });
  asArray(root.inputs).forEach((input, i) => {
    check(input, 'input', `$.inputs[${i}]`);
    check(record(input).previous_output, 'out_point', `$.inputs[${i}].previous_output`);
  });
  asArray(root.outputs).forEach((output, i) => {
    check(output, 'output', `$.outputs[${i}]`);
    check(record(output).lock, 'script', `$.outputs[${i}].lock`);
    if (record(output).type != null) check(record(output).type, 'script', `$.outputs[${i}].type`);
  });
  return problems;
}

/**
 * Projects a CKB transaction (snake_case RPC or camelCase CCC keys, possibly carrying
 * extra metadata) onto exactly the JSON shape FNN accepts. Unknown keys are dropped;
 * values are passed through unchanged, so the transaction hash and witnesses are
 * preserved. Inputs without `since` get the canonical "0x0".
 */
export function toFnnRpcTransaction(tx: unknown): Record<string, unknown> {
  const snake = normalizeCkbTransactionForRpc(tx) as Record<string, unknown>;
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const outPoint = (value: unknown) => ({ tx_hash: record(value).tx_hash, index: record(value).index });
  const script = (value: unknown) => ({
    code_hash: record(value).code_hash,
    hash_type: record(value).hash_type,
    args: record(value).args,
  });

  const result: Record<string, unknown> = {
    version: snake.version ?? '0x0',
    cell_deps: asArray(snake.cell_deps).map((dep) => ({
      out_point: outPoint(record(dep).out_point),
      dep_type: record(dep).dep_type,
    })),
    header_deps: asArray(snake.header_deps),
    inputs: asArray(snake.inputs).map((input) => ({
      previous_output: outPoint(record(input).previous_output),
      since: record(input).since ?? '0x0',
    })),
    outputs: asArray(snake.outputs).map((output) => {
      const out: Record<string, unknown> = { capacity: record(output).capacity, lock: script(record(output).lock) };
      if (record(output).type != null) out.type = script(record(output).type);
      return out;
    }),
    outputs_data: asArray(snake.outputs_data),
    witnesses: asArray(snake.witnesses),
  };
  return result;
}
