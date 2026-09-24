import { createHash, randomUUID } from 'node:crypto';
import type { CkbScript, CreateOrderRequest, NodeInfo, Quote, SwapOrder } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';
import { getOperatorFundingLockScript } from './operatorSigner.js';

interface RpcEnvelope<T> { result?: T; error?: { code: number; message: string }; }
interface ReceiveBtcResult {
  payment_hash: string;
  incoming_invoice: string | { Lightning?: string; Fiber?: string };
  outgoing_pay_req?: string;
  amount_sats?: string;
  fee_sats?: string;
  status?: SwapOrder['status'];
}
interface FnnNodeInfoResult {
  version?: string;
  commit_hash?: string;
  pubkey?: string;
  node_id?: string;
  addresses?: string[];
  channel_count?: string | number;
  pending_channel_count?: string | number;
  peer_count?: string | number;
  peers_count?: string | number;
  default_funding_lock_script?: {
    code_hash: string;
    hash_type: 'type' | 'data' | 'data1' | 'data2';
    args: string;
  };
}
export interface OpenChannelParams {
  pubkey: string;
  funding_amount: string;
  funding_udt_type_script?: {
    code_hash: string;
    hash_type: string;
    args: string;
  };
  one_way?: boolean;
  public?: boolean;
}
export interface OpenChannelResult {
  channel_id: string;
}
export interface AcceptChannelParams {
  temporary_channel_id: string;
  funding_amount: string;
  shutdown_script?: {
    code_hash: string;
    hash_type: string;
    args: string;
  };
}
export interface AcceptChannelResult {
  channel_id: string;
}
export interface FnnChannelItem {
  channel_id: string;
  pubkey: string;
  is_acceptor: boolean;
  state?: {
    state_name?: string;
  };
}
export interface CchGateway {
  createOrder(input: CreateOrderRequest, quote: Quote): Promise<SwapOrder>;
  getOrder(paymentHash: string): Promise<SwapOrder | null>;
  health(): Promise<boolean>;
  getNodeInfo(): Promise<NodeInfo>;
  openChannel(params: OpenChannelParams): Promise<OpenChannelResult>;
  acceptChannel?(params: AcceptChannelParams): Promise<AcceptChannelResult>;
  listChannels?(params?: { only_pending?: boolean; pubkey?: string }): Promise<{ channels: FnnChannelItem[] }>;
  getFnnFundingLockScript?(): Promise<CkbScript | undefined>;
}
const extractLightningInvoice = (value: ReceiveBtcResult['incoming_invoice']): string => {
  if (typeof value === 'string') return value;
  if (!value.Lightning) throw new Error('CCH did not return a Lightning invoice');
  return value.Lightning;
};
const parseRpcAmount = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const amount = Number(BigInt(value));
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('CCH returned an unsafe amount');
  return amount;
};
const parseRpcCount = (value: unknown): number => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('FNN returned an unsafe count');
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = Number(BigInt(trimmed));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('FNN returned an unsafe count');
    return parsed;
  }
  return 0;
};
export class CchRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(`FNN RPC [${code}]: ${message}`);
    this.name = 'CchRpcError';
  }
}
export class MockCchGateway implements CchGateway {
  private readonly orders = new Map<string, { order: SwapOrder; reads: number }>();
  async createOrder(input: CreateOrderRequest, quote: Quote): Promise<SwapOrder> {
    const paymentHash = createHash('sha256').update(`${input.fiber_invoice}:${input.quote_id}`).digest('hex');
    const order: SwapOrder = {
      order_id: randomUUID(), payment_hash: paymentHash, status: 'Pending',
      lightning_invoice: `lntb${quote.pay_sats}n1mock${paymentHash.slice(0, 48)}`,
      fiber_invoice: input.fiber_invoice, receive_raw: quote.receive_raw,
      pay_sats: quote.pay_sats, fee_sats: quote.fee_sats, created_at: new Date().toISOString(),
    };
    if (this.orders.size >= 1_000) {
      const oldest = this.orders.keys().next().value;
      if (oldest) this.orders.delete(oldest);
    }
    this.orders.set(paymentHash, { order, reads: 0 });
    return order;
  }
  async getOrder(paymentHash: string): Promise<SwapOrder | null> {
    const record = this.orders.get(paymentHash);
    if (!record) return null;
    record.reads += 1;
    const status = record.reads >= 4 ? 'Success' : record.reads >= 2 ? 'IncomingAccepted' : 'Pending';
    record.order = { ...record.order, status };
    return record.order;
  }
  async health(): Promise<boolean> { return true; }
  async getNodeInfo(): Promise<NodeInfo> {
    return {
      node_id: '03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
      addresses: ['/dns4/mock-provider.test/tcp/8443/wss'],
      channel_count: 0,
      peer_count: 0,
      operator_channel_funding_amount: '100000000',
    };
  }
  async openChannel(_params: OpenChannelParams): Promise<OpenChannelResult> {
    return { channel_id: `mock_${randomUUID()}` };
  }
  async acceptChannel(_params: AcceptChannelParams): Promise<AcceptChannelResult> {
    return { channel_id: `mock_accept_${randomUUID()}` };
  }
  async listChannels(_params?: { only_pending?: boolean; pubkey?: string }): Promise<{ channels: FnnChannelItem[] }> {
    return { channels: [] };
  }
}
export class RpcCchGateway implements CchGateway {
  private readonly orders = new Map<string, SwapOrder>();
  constructor(
    private readonly fiberRpcUrl: string = config.fnnRpcUrl,
    private readonly cchRpcUrl: string = config.cchRpcUrl,
    private readonly fundingLockScriptProvider?: () => Promise<CkbScript | undefined>,
  ) {}
  private async call<T>(method: string, params: unknown[], rpcUrl = this.cchRpcUrl, timeoutMs = 10_000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`FNN RPC returned HTTP ${response.status}`);
      const payload = (await response.json()) as RpcEnvelope<T>;
      if (payload.error) throw new CchRpcError(payload.error.code, payload.error.message);
      if (payload.result === undefined) throw new Error('FNN RPC returned no result');
      return payload.result;
    } finally { clearTimeout(timeout); }
  }
  async createOrder(input: CreateOrderRequest, quote: Quote): Promise<SwapOrder> {
    const result = await this.call<ReceiveBtcResult>('receive_btc', [{ fiber_pay_req: input.fiber_invoice }], this.cchRpcUrl, 60_000);
    const paySats = parseRpcAmount(result.amount_sats, quote.pay_sats);
    const feeSats = parseRpcAmount(result.fee_sats, quote.fee_sats);
    const order: SwapOrder = {
      order_id: result.payment_hash, payment_hash: result.payment_hash, status: result.status ?? 'Pending',
      lightning_invoice: extractLightningInvoice(result.incoming_invoice),
      fiber_invoice: result.outgoing_pay_req ?? input.fiber_invoice,
      receive_raw: String(Math.max(0, paySats - feeSats)), pay_sats: paySats, fee_sats: feeSats,
      created_at: new Date().toISOString(),
    };
    this.orders.set(order.payment_hash, order);
    return order;
  }
  async getOrder(paymentHash: string): Promise<SwapOrder | null> {
    const local = this.orders.get(paymentHash);
    const result = await this.call<ReceiveBtcResult>('get_cch_order', [{ payment_hash: paymentHash }], this.cchRpcUrl, 30_000);
    const paySats = parseRpcAmount(result.amount_sats, local?.pay_sats ?? 0);
    const feeSats = parseRpcAmount(result.fee_sats, local?.fee_sats ?? 0);
    const order: SwapOrder = {
      order_id: result.payment_hash,
      payment_hash: result.payment_hash,
      status: result.status ?? local?.status ?? 'Pending',
      lightning_invoice: extractLightningInvoice(result.incoming_invoice),
      fiber_invoice: result.outgoing_pay_req ?? local?.fiber_invoice ?? '',
      receive_raw: String(Math.max(0, paySats - feeSats)),
      pay_sats: paySats,
      fee_sats: feeSats,
      created_at: local?.created_at ?? new Date().toISOString(),
    };
    this.orders.set(paymentHash, order);
    return order;
  }
  async health(): Promise<boolean> {
    try { await this.call('node_info', [], this.fiberRpcUrl); return true; } catch { return false; }
  }
  async getNodeInfo(): Promise<NodeInfo> {
    const raw = await this.call<FnnNodeInfoResult>('node_info', [], this.fiberRpcUrl);
    const nodeId = raw.node_id ?? raw.pubkey;
    if (!nodeId || typeof nodeId !== 'string') {
      throw new Error('FNN node_info did not return a valid node_id or pubkey');
    }
    const addresses = Array.isArray(raw.addresses)
      ? raw.addresses.filter((addr): addr is string => typeof addr === 'string')
      : [];
    const channelCount = parseRpcCount(raw.channel_count);
    const peerCount = parseRpcCount(raw.peer_count ?? raw.peers_count);
    let fundingLockScript: CkbScript | undefined;
    if (this.fundingLockScriptProvider) {
      try {
        fundingLockScript = await this.fundingLockScriptProvider();
      } catch {
        // best-effort
      }
    }
    return {
      node_id: nodeId,
      addresses,
      channel_count: channelCount,
      peer_count: peerCount,
      funding_lock_script: fundingLockScript,
      operator_channel_funding_amount: config.operatorChannelFundingAmount,
    };
  }
  async getFnnFundingLockScript(): Promise<CkbScript | undefined> {
    try {
      const raw = await this.call<FnnNodeInfoResult>('node_info', [], this.fiberRpcUrl);
      if (raw.default_funding_lock_script) {
        return raw.default_funding_lock_script;
      }
    } catch {
      // best-effort
    }
    return undefined;
  }
  async openChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
    const raw = await this.call<{ channel_id?: string; temporary_channel_id?: string }>('open_channel', [params], this.fiberRpcUrl, 30_000);
    const channelId = raw.channel_id ?? raw.temporary_channel_id;
    if (!channelId || typeof channelId !== 'string') {
      throw new Error('FNN open_channel did not return a valid channel_id');
    }
    return {
      channel_id: channelId,
    };
  }
  async acceptChannel(params: AcceptChannelParams): Promise<AcceptChannelResult> {
    const raw = await this.call<{ channel_id?: string; temporary_channel_id?: string }>('accept_channel', [params], this.fiberRpcUrl, 30_000);
    const channelId = raw.channel_id ?? raw.temporary_channel_id;
    if (!channelId || typeof channelId !== 'string') {
      throw new Error('FNN accept_channel did not return a valid channel_id');
    }
    return {
      channel_id: channelId,
    };
  }
  async listChannels(params?: { only_pending?: boolean; pubkey?: string }): Promise<{ channels: FnnChannelItem[] }> {
    const raw = await this.call<{ channels?: FnnChannelItem[] }>('list_channels', [params ?? {}], this.fiberRpcUrl, 15_000);
    return {
      channels: Array.isArray(raw.channels) ? raw.channels : [],
    };
  }
}
export const cchGateway: CchGateway = new RpcCchGateway(
  config.fnnRpcUrl,
  config.cchRpcUrl,
  getOperatorFundingLockScript,
);
