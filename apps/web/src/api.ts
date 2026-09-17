import type { BootstrapSession, CreateOrderRequest, HealthResponse, NodeInfo, Quote, SwapOrder } from '@ckb-on-ramp/contracts';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001/api';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? `API request failed with HTTP ${response.status}`, response.status);
  return payload;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  nodeInfo: () => request<NodeInfo>('/node-info'),
  bootstrap: (nodePubkey: string) => request<BootstrapSession>('/bootstrap', {
    method: 'POST', body: JSON.stringify({ node_pubkey: nodePubkey }),
  }),
  quote: (receiveRaw: string) => request<Quote>('/quotes', {
    method: 'POST', body: JSON.stringify({ receive_raw: receiveRaw }),
  }),
  createOrder: (input: CreateOrderRequest, idempotencyKey: string) => request<SwapOrder>('/orders', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input),
  }),
  getOrder: (paymentHash: string) => request<SwapOrder>(`/orders/${encodeURIComponent(paymentHash)}`),
};
