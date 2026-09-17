export type Environment = 'mock' | 'testnet';
export type BootstrapStatus = 'waiting_for_node' | 'connecting_peer' | 'provisioning_liquidity' | 'ready' | 'failed';
export interface BootstrapRequest {
  node_pubkey: string;
  funding_address: string;
}
export interface BootstrapSession {
  session_id: string;
  status: BootstrapStatus;
  peer_address?: string;
  channel_id?: string;
  message: string;
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
export interface HealthResponse { ok: boolean; mode: Environment; fnn_reachable: boolean; }
export interface NodeInfo {
  node_id: string;
  addresses: string[];
  channel_count: number;
  peer_count: number;
}
