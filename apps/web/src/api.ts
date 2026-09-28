import type {
  BootstrapRequest,
  BootstrapSession,
  CreateOrderRequest,
  HealthResponse,
  NodeInfo,
  Quote,
  SignFundingRequest,
  SignFundingResponse,
  SwapOrder,
} from '@ckb-on-ramp/contracts';

const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || '/api';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isFundingInflightCollision(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ('status' in err && (err as { status: unknown }).status === 409) return true;
  // Real 409 bodies say "in flight"; do not match a bare "409" substring
  // (channel_id hex can contain it) or unrelated "collision" text.
  const msg = err instanceof Error ? err.message : '';
  return msg.toLowerCase().includes('in flight');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok) throw new ApiError(payload.error ?? payload.message ?? `API request failed with HTTP ${response.status}`, response.status);
  return payload;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  nodeInfo: () => request<NodeInfo>('/node-info'),
  bootstrap: (payload: BootstrapRequest) => request<BootstrapSession>('/bootstrap', {
    method: 'POST', body: JSON.stringify(payload),
  }),
  getBootstrapSession: (sessionId: string) => request<BootstrapSession>(`/bootstrap/${encodeURIComponent(sessionId)}`),
  quote: (receiveRaw: string) => request<Quote>('/quotes', {
    method: 'POST', body: JSON.stringify({ receive_raw: receiveRaw }),
  }),
  createOrder: (input: CreateOrderRequest, idempotencyKey: string) => request<SwapOrder>('/orders', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input),
  }),
  getOrder: (paymentHash: string) => request<SwapOrder>(`/orders/${encodeURIComponent(paymentHash)}`),
  signFunding: (payload: SignFundingRequest) => request<SignFundingResponse>('/sign-funding', {
    method: 'POST', body: JSON.stringify(payload),
  }),
};
