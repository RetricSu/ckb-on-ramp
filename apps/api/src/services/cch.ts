import { createHash, randomUUID } from 'node:crypto';
import type { CreateOrderRequest, Quote, SwapOrder } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';

interface RpcEnvelope<T> { result?: T; error?: { code: number; message: string }; }
interface ReceiveBtcResult {
  payment_hash: string;
  incoming_invoice: string | { Lightning?: string; Fiber?: string };
  outgoing_pay_req?: string;
  amount_sats?: string;
  fee_sats?: string;
  status?: SwapOrder['status'];
}
export interface CchGateway {
  createOrder(input: CreateOrderRequest, quote: Quote): Promise<SwapOrder>;
  getOrder(paymentHash: string): Promise<SwapOrder | null>;
  health(): Promise<boolean>;
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
}
export class RpcCchGateway implements CchGateway {
  private readonly orders = new Map<string, SwapOrder>();
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(config.fnnRpcUrl, {
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
    const result = await this.call<ReceiveBtcResult>('receive_btc', [{ fiber_pay_req: input.fiber_invoice }]);
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
    const result = await this.call<ReceiveBtcResult>('get_cch_order', [{ payment_hash: paymentHash }]);
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
    try { await this.call('node_info', []); return true; } catch { return false; }
  }
}
export const cchGateway: CchGateway = config.mode === 'rpc' ? new RpcCchGateway() : new MockCchGateway();
