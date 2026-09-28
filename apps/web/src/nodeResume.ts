import type { SwapOrder } from '@ckb-on-ramp/contracts';
import type { SwapReceipt } from './types';
import type { ChannelOpeningTicket } from './channelTicket';

export function isPendingStatus(status?: string | null): boolean {
  if (!status) return false;
  return ['Pending', 'IncomingAccepted', 'OutgoingInFlight'].includes(status);
}

/**
 * Returns true only after a finite threshold of consecutive 404 errors has been exceeded.
 * Single or transient 404s (e.g. during API restart or gateway sync) must NOT eagerly expire
 * an active in-flight order.
 */
export function shouldExpireOrderOn404(consecutive404Count: number, threshold = 10): boolean {
  return consecutive404Count >= threshold;
}

export interface AutoResumeStrategy {
  canResume: boolean;
  action: 'startWithPasskey' | 'startWithPassword' | 'wait' | 'none';
}

/**
 * Determines whether auto-resume may proceed without user interaction.
 *
 * CRITICAL INVARIANT: Auto-resume must NEVER call createPasskeyAndStart.
 * Calling createPasskeyAndStart would derive a brand new keypair, stranding the
 * user's existing IndexedDB channel state.
 *
 * If shouldResume is true but hasPasskeyConfigured is still false (e.g. during initial render
 * frames before passkey provider has checked WebAuthn/storage) and no dev password is set,
 * the strategy MUST return 'wait' and canResume=false so the effect waits for hasPasskeyConfigured
 * to update without firing.
 */
export function determineAutoResumeStrategy(params: {
  hasPasskeyConfigured?: boolean;
  e2ePassword?: string | null;
  shouldResume: boolean;
}): AutoResumeStrategy {
  if (!params.shouldResume) {
    return { canResume: false, action: 'none' };
  }
  const password = params.e2ePassword ? String(params.e2ePassword).trim() : '';
  if (password) {
    return { canResume: true, action: 'startWithPassword' };
  }
  if (params.hasPasskeyConfigured) {
    return { canResume: true, action: 'startWithPasskey' };
  }
  return { canResume: false, action: 'wait' };
}

export interface ShouldResumeNodeParams {
  hasPasskeyConfigured?: boolean;
  pendingOrder?: Partial<SwapOrder> | null;
  pendingReceipts?: Array<Partial<SwapReceipt>> | null;
  pendingChannel?: ChannelOpeningTicket | null;
}

export function shouldResumeNode(params: ShouldResumeNodeParams): boolean {
  if (params.hasPasskeyConfigured) {
    return true;
  }
  if (params.pendingChannel) {
    return true;
  }
  if (params.pendingOrder && isPendingStatus(params.pendingOrder.status)) {
    return true;
  }
  if (Array.isArray(params.pendingReceipts)) {
    return params.pendingReceipts.some((r) => isPendingStatus(r.status));
  }
  return false;
}
