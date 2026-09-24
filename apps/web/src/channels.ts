import { useEffect } from 'react';
import { normalizeChannelStateName } from '@ckb-on-ramp/contracts';
import type {
  AcceptChannelParams,
  AcceptChannelResult,
  Channel,
  ChannelId,
  ListChannelsParams,
  ListChannelsResult,
} from '@fiber-pay/sdk/browser';

export { normalizeChannelStateName };

/**
 * Minimal interface required from a Fiber node client to inspect and accept channels.
 * FiberBrowserNode naturally satisfies this interface.
 */
export interface ChannelAcceptorClient {
  listChannels(params?: ListChannelsParams): Promise<ListChannelsResult>;
  acceptChannel(params: AcceptChannelParams): Promise<AcceptChannelResult>;
}

/**
 * Determines whether a given channel represents an incoming inbound channel offer
 * that is currently pending acceptance.
 *
 * Requirements for acceptance:
 * 1. is_acceptor === true (our node is receiving the offer from an external peer/funder).
 * 2. state_name is NegotiatingFunding.
 * 3. channel_id is present and not a mock placeholder (does not start with 'mock_').
 */
export function isPendingInboundOffer(channel?: Channel | null): boolean {
  if (!channel || !channel.is_acceptor) return false;
  if (!channel.channel_id || typeof channel.channel_id !== 'string') return false;
  if (channel.channel_id.startsWith('mock_')) return false;

  const stateName = normalizeChannelStateName(channel.state?.state_name);
  return stateName === 'NEGOTIATINGFUNDING';
}

export interface AcceptPendingOffersOptions {
  acceptedIds?: Set<string>;
  inFlightIds?: Set<string>;
  onAccepted?: (channelId: ChannelId) => void;
  onError?: (error: unknown, channelId?: ChannelId) => void;
}

/**
 * Inspects pending channels and explicitly accepts inbound offers with funding_amount: '0x0'.
 *
 * - Skips cleanly if there are no pending channels or in mock mode with no pending channels.
 * - Enforces funding_amount: '0x0', never auto-accepting with 99 CKB (0x24e160300).
 * - Tracks inFlight and accepted channel IDs to prevent duplicate accept calls.
 */
export async function acceptPendingOffers(
  client: ChannelAcceptorClient,
  options?: AcceptPendingOffersOptions,
): Promise<ChannelId[]> {
  const result = await client.listChannels({ only_pending: true });
  const channels = result?.channels ?? [];
  if (channels.length === 0) {
    return [];
  }

  const acceptedIds = options?.acceptedIds ?? new Set<string>();
  const inFlightIds = options?.inFlightIds ?? new Set<string>();
  const newlyAccepted: ChannelId[] = [];

  for (const channel of channels) {
    if (!isPendingInboundOffer(channel)) {
      continue;
    }

    const tempId = channel.channel_id;
    if (acceptedIds.has(tempId) || inFlightIds.has(tempId)) {
      continue;
    }

    inFlightIds.add(tempId);
    try {
      const res = await client.acceptChannel({
        temporary_channel_id: tempId,
        funding_amount: '0x0',
      });
      const finalId = res?.channel_id ?? tempId;
      acceptedIds.add(tempId);
      if (finalId !== tempId) {
        acceptedIds.add(finalId);
      }
      newlyAccepted.push(finalId);
      options?.onAccepted?.(finalId);
    } catch (error) {
      if (options?.onError) {
        options.onError(error, tempId);
      } else {
        console.warn(`Failed to accept channel offer ${tempId}:`, error);
      }
    } finally {
      inFlightIds.delete(tempId);
    }
  }

  return newlyAccepted;
}

export interface ChannelAcceptorOptions {
  node: ChannelAcceptorClient;
  pollIntervalMs?: number;
  onAccepted?: (channelId: ChannelId) => void;
  onError?: (error: unknown, channelId?: ChannelId) => void;
}

export interface ChannelAcceptorController {
  stop: () => void;
  isRunning: () => boolean;
  pollNow: () => Promise<ChannelId[]>;
}

/**
 * Starts periodic polling for pending inbound channel offers on a running Fiber node.
 */
export function startChannelAcceptor(options: ChannelAcceptorOptions): ChannelAcceptorController {
  const { node, pollIntervalMs = 3000, onAccepted, onError } = options;
  const acceptedIds = new Set<string>();
  const inFlightIds = new Set<string>();

  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activePollPromise: Promise<ChannelId[]> | null = null;

  const runPoll = async (): Promise<ChannelId[]> => {
    if (!running) return [];
    if (activePollPromise) return activePollPromise;

    activePollPromise = (async () => {
      try {
        return await acceptPendingOffers(node, {
          acceptedIds,
          inFlightIds,
          onAccepted,
          onError,
        });
      } catch (error) {
        if (onError) {
          onError(error);
        } else {
          console.warn('Channel acceptor poll error:', error);
        }
        return [];
      } finally {
        activePollPromise = null;
      }
    })();

    return activePollPromise;
  };

  const scheduleNext = () => {
    if (!running) return;
    timer = setTimeout(() => {
      void runPoll().finally(() => {
        scheduleNext();
      });
    }, pollIntervalMs);
  };

  // Run initial poll, then schedule periodic checks
  void runPoll().finally(() => {
    scheduleNext();
  });

  return {
    stop: () => {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isRunning: () => running,
    pollNow: runPoll,
  };
}

/**
 * React hook to automatically start channel offer acceptance when the Fiber node is running.
 */
export function useChannelAcceptor(
  node: ChannelAcceptorClient | null | undefined,
  isRunning: boolean,
  options?: Omit<ChannelAcceptorOptions, 'node'>,
): void {
  useEffect(() => {
    if (!isRunning || !node) return;
    const controller = startChannelAcceptor({
      node,
      ...options,
    });
    return () => {
      controller.stop();
    };
  }, [isRunning, node, options?.pollIntervalMs, options?.onAccepted, options?.onError]);
}

export interface WaitForChannelReadyOptions {
  node: Pick<ChannelAcceptorClient, 'listChannels'>;
  sessionId?: string;
  expectedChannelId?: string;
  existingReadyIds?: Set<string>;
  minInboundCapacity?: bigint;
  isCwbtcChannel: (ch: Channel) => boolean;
  getBootstrapSession?: (sessionId: string) => Promise<{ status: string; message?: string }>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Polls until the newly opened cWBTC channel reaches CHANNELREADY on the local node.
 * - Throws immediately if server reports session failure without string-filtering.
 * - Avoids falsely matching existing stale channels with insufficient inbound capacity.
 */
export async function waitForCwbtcChannelReady(
  options: WaitForChannelReadyOptions,
): Promise<ChannelId> {
  const {
    node,
    sessionId,
    expectedChannelId,
    existingReadyIds,
    minInboundCapacity,
    isCwbtcChannel,
    getBootstrapSession,
    timeoutMs = 600_000,
    pollIntervalMs = 2_000,
  } = options;

  const pollStart = Date.now();

  while (Date.now() - pollStart < timeoutMs) {
    if (sessionId && getBootstrapSession) {
      const s = await getBootstrapSession(sessionId).catch(() => null);
      if (s && s.status === 'failed') {
        throw new Error(s.message || 'Channel provisioning failed on operator node.');
      }
    }

    try {
      const res = await node.listChannels({});
      const ready = (res?.channels ?? []).find((ch: Channel) => {
        if (normalizeChannelStateName(ch.state?.state_name) !== 'CHANNELREADY') return false;
        if (!isCwbtcChannel(ch)) return false;

        if (expectedChannelId && ch.channel_id.toLowerCase() === expectedChannelId.toLowerCase()) {
          return true;
        }

        if (existingReadyIds && existingReadyIds.has(ch.channel_id)) {
          return false;
        }

        if (minInboundCapacity !== undefined) {
          try {
            return BigInt(ch.remote_balance) >= minInboundCapacity;
          } catch {
            return false;
          }
        }

        return true;
      });

      if (ready) {
        return ready.channel_id;
      }
    } catch {
      // Ignore transient query error
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error('Channel opening timed out. The testnet channel did not confirm in time. Please retry.');
}
