import type { SwapOrder } from '@ckb-on-ramp/contracts';
import { formatCwbtc } from './amount';
import { CHANNEL_TICKET_KEY } from './channelTicket';
import type { SwapReceipt } from './types';

const STORAGE_KEY = 'ckb-on-ramp:receipts';
const LAST_ORDER_KEY = 'ckb-on-ramp:last-order';

export function loadReceipts(): SwapReceipt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list;
  } catch {
    return [];
  }
}

export function saveReceipt(receipt: SwapReceipt): SwapReceipt[] {
  try {
    const receipts = loadReceipts();
    const index = receipts.findIndex((r) => r.paymentHash === receipt.paymentHash);
    if (index >= 0) {
      receipts[index] = { ...receipts[index], ...receipt };
    } else {
      receipts.unshift(receipt);
    }
    // Limit stored receipts to 50
    const trimmed = receipts.slice(0, 50);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    return trimmed;
  } catch {
    return [receipt];
  }
}

export function updateReceiptStatus(
  paymentHash: string,
  status: SwapReceipt['status'],
  settledAt?: number,
  failureReason?: string,
): SwapReceipt[] {
  try {
    const receipts = loadReceipts();
    const target = receipts.find((r) => r.paymentHash === paymentHash);
    if (target) {
      target.status = status;
      if (settledAt) target.settledAt = settledAt;
      if (failureReason) target.failureReason = failureReason;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(receipts));
    }
    return receipts;
  } catch {
    return [];
  }
}

export function clearAllReceipts(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LAST_ORDER_KEY);
    localStorage.removeItem(CHANNEL_TICKET_KEY);
  } catch {
    // ignore
  }
}

export function orderToReceipt(order: SwapOrder, channelId?: string): SwapReceipt {
  return {
    paymentHash: order.payment_hash,
    paySats: order.pay_sats,
    receiveRaw: order.receive_raw,
    receiveCwbtc: formatCwbtc(order.receive_raw),
    feeSats: order.fee_sats,
    status: order.status,
    createdAt: Date.parse(order.created_at) || Date.now(),
    settledAt: order.status === 'Success' || order.status === 'OutgoingSuccess' ? Date.now() : undefined,
    lightningInvoice: order.lightning_invoice,
    channelId,
    failureReason: order.failure_reason,
  };
}
