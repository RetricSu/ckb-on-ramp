export type ChannelTicketStep =
  | 'waiting_for_channel'
  | 'waiting_for_accept'
  | 'signing_funding'
  | 'submitting_funding'
  | 'waiting_for_ready';

export interface ChannelOpeningTicket {
  sessionId: string;
  channelId?: string;
  unsignedFundingTx?: unknown;
  signedFundingTx?: unknown;
  step: ChannelTicketStep;
  targetRaw: string;
  createdAt: number;
}

export const CHANNEL_TICKET_KEY = 'ckb-on-ramp:channel-ticket';

export function loadChannelTicket(): ChannelOpeningTicket | null {
  try {
    const raw = localStorage.getItem(CHANNEL_TICKET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChannelOpeningTicket>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.sessionId || typeof parsed.sessionId !== 'string') return null;
    if (!parsed.step || typeof parsed.step !== 'string') return null;
    return parsed as ChannelOpeningTicket;
  } catch {
    return null;
  }
}

export function saveChannelTicket(ticket: ChannelOpeningTicket): void {
  try {
    localStorage.setItem(CHANNEL_TICKET_KEY, JSON.stringify(ticket));
  } catch (err) {
    console.warn('[ChannelTicket] Failed to save channel ticket to localStorage:', err);
  }
}

export function clearChannelTicket(): void {
  try {
    localStorage.removeItem(CHANNEL_TICKET_KEY);
  } catch (err) {
    console.warn('[ChannelTicket] Failed to clear channel ticket from localStorage:', err);
  }
}
