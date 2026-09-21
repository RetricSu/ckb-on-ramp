import type { OrderStatus, SwapOrder } from '@ckb-on-ramp/contracts';

export type SwapStep =
  | 'idle'
  | 'authorizing_node'
  | 'connecting_peer'
  | 'checking_channel'
  | 'provisioning_channel'
  | 'creating_invoice'
  | 'creating_order'
  | 'awaiting_payment'
  | 'settled'
  | 'failed';

export interface SwapReceipt {
  paymentHash: string;
  paySats: number;
  receiveRaw: string;
  receiveCwbtc: string;
  feeSats: number;
  status: OrderStatus;
  createdAt: number;
  settledAt?: number;
  lightningInvoice: string;
  channelId?: string;
  failureReason?: string;
}
