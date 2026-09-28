import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AcceptChannelParams,
  AcceptChannelResult,
  Channel,
  ChannelId,
  ChannelState,
  ListChannelsParams,
  ListChannelsResult,
} from '@fiber-pay/sdk/browser';
import {
  acceptPendingOffers,
  isPendingInboundOffer,
  normalizeChannelStateName,
  startChannelAcceptor,
  type ChannelAcceptorClient,
} from './channels.js';
import { ApiError, isFundingInflightCollision } from './api.js';

function createMockChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    channel_id: '0x60e1bb6f3c2618eadcaec013fabc1a29eadd9a17ef369bd273baedfea66817c7' as ChannelId,
    is_public: false,
    is_acceptor: true,
    is_one_way: false,
    channel_outpoint: null,
    pubkey: '0x03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957',
    funding_udt_type_script: null,
    state: {
      state_name: 'NegotiatingFunding' as ChannelState,
    },
    local_balance: '0x0',
    offered_tlc_balance: '0x0',
    remote_balance: '0x5f5e100',
    received_tlc_balance: '0x0',
    pending_tlcs: [],
    latest_commitment_transaction_hash: null,
    created_at: '0x0',
    enabled: true,
    tlc_expiry_delta: '0x0',
    tlc_fee_proportional_millionths: '0x0',
    shutdown_transaction_hash: null,
    ...overrides,
  };
}

describe('Channel Acceptor (Scheme B Zero-CKB Inbound Acceptance)', () => {
  describe('normalizeChannelStateName', () => {
    it('normalizes PascalCase and SCREAMING_SNAKE_CASE to identical uppercase representation', () => {
      assert.equal(normalizeChannelStateName('NegotiatingFunding'), 'NEGOTIATINGFUNDING');
      assert.equal(normalizeChannelStateName('NEGOTIATING_FUNDING'), 'NEGOTIATINGFUNDING');
      assert.equal(normalizeChannelStateName('ChannelReady'), 'CHANNELREADY');
      assert.equal(normalizeChannelStateName('CHANNEL_READY'), 'CHANNELREADY');
    });

    it('handles undefined or null gracefully', () => {
      assert.equal(normalizeChannelStateName(undefined), '');
      assert.equal(normalizeChannelStateName(''), '');
    });
  });

  describe('isPendingInboundOffer', () => {
    it('returns true for incoming inbound channel offer in NegotiatingFunding', () => {
      const channel = createMockChannel({
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });
      assert.equal(isPendingInboundOffer(channel), true);
    });

    it('returns true for SCREAMING_SNAKE_CASE state name', () => {
      const channel = createMockChannel({
        is_acceptor: true,
        state: { state_name: 'NEGOTIATING_FUNDING' as ChannelState },
      });
      assert.equal(isPendingInboundOffer(channel), true);
    });

    it('returns false when is_acceptor is false (outbound channel opened by this node)', () => {
      const channel = createMockChannel({
        is_acceptor: false,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });
      assert.equal(isPendingInboundOffer(channel), false);
    });

    it('returns false for channels in subsequent or terminal states', () => {
      const nonNegotiatingStates: string[] = [
        'CollaboratingFundingTx',
        'COLLABORATING_FUNDING_TX',
        'SigningCommitment',
        'AwaitingTxSignatures',
        'AwaitingChannelReady',
        'ChannelReady',
        'ShuttingDown',
        'Closed',
        'Stale',
      ];

      for (const stateName of nonNegotiatingStates) {
        const channel = createMockChannel({
          is_acceptor: true,
          state: { state_name: stateName as ChannelState },
        });
        assert.equal(isPendingInboundOffer(channel), false, `Expected false for state ${stateName}`);
      }
    });

    it('returns false for mock placeholder channel IDs', () => {
      const channel = createMockChannel({
        channel_id: 'mock_33b6489eeff2270ec58566ed55199a8f' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });
      assert.equal(isPendingInboundOffer(channel), false);
    });

    it('returns false for null, undefined, or missing channel_id', () => {
      assert.equal(isPendingInboundOffer(null), false);
      assert.equal(isPendingInboundOffer(undefined), false);
      assert.equal(isPendingInboundOffer({ is_acceptor: true } as Channel), false);
    });
  });

  describe('acceptPendingOffers', () => {
    it('skips cleanly without calling acceptChannel when no pending channels exist', async () => {
      let acceptCalls = 0;
      const client: ChannelAcceptorClient = {
        listChannels: async (_params?: ListChannelsParams): Promise<ListChannelsResult> => ({
          channels: [],
        }),
        acceptChannel: async (_params: AcceptChannelParams): Promise<AcceptChannelResult> => {
          acceptCalls++;
          return { channel_id: '0x1' as ChannelId };
        },
      };

      const accepted = await acceptPendingOffers(client);
      assert.deepEqual(accepted, []);
      assert.equal(acceptCalls, 0);
    });

    it('accepts inbound offer with funding_amount 0x0 (never 99 CKB auto-accept)', async () => {
      const acceptedCalls: AcceptChannelParams[] = [];
      const pendingChannel = createMockChannel({
        channel_id: '0x33b6489eeff2270ec58566ed55199a8f95ffa3780b7a671a6d69eb6c0a11a0c7' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });

      const client: ChannelAcceptorClient = {
        listChannels: async (): Promise<ListChannelsResult> => ({
          channels: [pendingChannel],
        }),
        acceptChannel: async (params: AcceptChannelParams): Promise<AcceptChannelResult> => {
          acceptedCalls.push(params);
          return { channel_id: params.temporary_channel_id };
        },
      };

      const accepted = await acceptPendingOffers(client);

      assert.equal(accepted.length, 1);
      assert.equal(accepted[0], pendingChannel.channel_id);
      assert.equal(acceptedCalls.length, 1);
      const firstCall = acceptedCalls[0];
      assert.ok(firstCall);

      // Verify exact parameter requirements:
      assert.equal(firstCall.temporary_channel_id, pendingChannel.channel_id);
      assert.equal(firstCall.funding_amount, '0x0');

      // Explicit negative check: must NOT auto-accept with 99 CKB (0x24e160300)
      assert.notEqual(firstCall.funding_amount, '0x24e160300');
    });

    it('filters out outbound and non-negotiating channels, accepting only inbound offers', async () => {
      const inboundPending = createMockChannel({
        channel_id: '0x1111111111111111111111111111111111111111111111111111111111111111' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });
      const outbound = createMockChannel({
        channel_id: '0x2222222222222222222222222222222222222222222222222222222222222222' as ChannelId,
        is_acceptor: false,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });
      const alreadyReady = createMockChannel({
        channel_id: '0x3333333333333333333333333333333333333333333333333333333333333333' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'ChannelReady' as ChannelState },
      });
      const mockChannel = createMockChannel({
        channel_id: 'mock_channel_placeholder' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });

      const acceptedCalls: AcceptChannelParams[] = [];
      const client: ChannelAcceptorClient = {
        listChannels: async (): Promise<ListChannelsResult> => ({
          channels: [inboundPending, outbound, alreadyReady, mockChannel],
        }),
        acceptChannel: async (params: AcceptChannelParams): Promise<AcceptChannelResult> => {
          acceptedCalls.push(params);
          return { channel_id: params.temporary_channel_id };
        },
      };

      const accepted = await acceptPendingOffers(client);

      assert.deepEqual(accepted, [inboundPending.channel_id]);
      assert.equal(acceptedCalls.length, 1);
      const singleCall = acceptedCalls[0];
      assert.ok(singleCall);
      assert.equal(singleCall.temporary_channel_id, inboundPending.channel_id);
    });

    it('does not re-accept channels that have already been accepted', async () => {
      const channel = createMockChannel({
        channel_id: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });

      let acceptCount = 0;
      const client: ChannelAcceptorClient = {
        listChannels: async (): Promise<ListChannelsResult> => ({
          channels: [channel],
        }),
        acceptChannel: async (params: AcceptChannelParams): Promise<AcceptChannelResult> => {
          acceptCount++;
          return { channel_id: params.temporary_channel_id };
        },
      };

      const acceptedIds = new Set<string>();

      const firstPass = await acceptPendingOffers(client, { acceptedIds });
      assert.equal(firstPass.length, 1);
      assert.equal(acceptCount, 1);

      // Channel is still reported in listChannels on subsequent poll
      const secondPass = await acceptPendingOffers(client, { acceptedIds });
      assert.equal(secondPass.length, 0);
      assert.equal(acceptCount, 1); // Not called again
    });

    it('calls onError callback and does not mark channel as accepted if acceptChannel fails', async () => {
      const channel = createMockChannel({
        channel_id: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });

      const client: ChannelAcceptorClient = {
        listChannels: async (): Promise<ListChannelsResult> => ({
          channels: [channel],
        }),
        acceptChannel: async (): Promise<AcceptChannelResult> => {
          throw new Error('RPC error: peer unreachable');
        },
      };

      const acceptedIds = new Set<string>();
      let caughtError: unknown = null;
      let failedChannelId: ChannelId | undefined;

      const result = await acceptPendingOffers(client, {
        acceptedIds,
        onError: (err, id) => {
          caughtError = err;
          failedChannelId = id;
        },
      });

      assert.deepEqual(result, []);
      assert.ok(caughtError instanceof Error);
      assert.match((caughtError as Error).message, /peer unreachable/);
      assert.equal(failedChannelId, channel.channel_id);
      assert.equal(acceptedIds.has(channel.channel_id), false);
    });
  });

  describe('startChannelAcceptor lifecycle', () => {
    it('starts polling and can be stopped with stop()', async () => {
      let pollCount = 0;
      const client: ChannelAcceptorClient = {
        listChannels: async (): Promise<ListChannelsResult> => {
          pollCount++;
          return { channels: [] };
        },
        acceptChannel: async (): Promise<AcceptChannelResult> => ({ channel_id: '0x1' as ChannelId }),
      };

      const controller = startChannelAcceptor({
        node: client,
        pollIntervalMs: 20,
      });

      assert.equal(controller.isRunning(), true);

      // Wait enough time for initial poll + at least one interval tick
      await new Promise<void>((resolve) => setTimeout(resolve, 60));

      controller.stop();
      assert.equal(controller.isRunning(), false);

      const countAtStop = pollCount;
      assert.ok(countAtStop >= 1, `Expected at least 1 poll, got ${countAtStop}`);

      // Wait another period to verify no further polls occur after stop()
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      assert.equal(pollCount, countAtStop);
    });

    it('pollNow executes an immediate poll cycle', async () => {
      const channel = createMockChannel({
        channel_id: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as ChannelId,
        is_acceptor: true,
        state: { state_name: 'NegotiatingFunding' as ChannelState },
      });

      const client: ChannelAcceptorClient = {
        listChannels: async (): Promise<ListChannelsResult> => ({
          channels: [channel],
        }),
        acceptChannel: async (params: AcceptChannelParams): Promise<AcceptChannelResult> => {
          return { channel_id: params.temporary_channel_id };
        },
      };

      const controller = startChannelAcceptor({
        node: client,
        pollIntervalMs: 10_000, // large interval so timer won't fire during test
      });

      try {
        const accepted = await controller.pollNow();
        assert.equal(accepted.length, 1);
        assert.equal(accepted[0], channel.channel_id);
      } finally {
        controller.stop();
      }
    });

    it('catches listChannels error without crashing the loop', async () => {
      let errorReported: unknown = null;
      let shouldFail = true;

      const client: ChannelAcceptorClient = {
        listChannels: async (): Promise<ListChannelsResult> => {
          if (shouldFail) {
            throw new Error('FNN node offline');
          }
          return { channels: [] };
        },
        acceptChannel: async (): Promise<AcceptChannelResult> => ({ channel_id: '0x1' as ChannelId }),
      };

      const controller = startChannelAcceptor({
        node: client,
        pollIntervalMs: 20,
        onError: (err) => {
          errorReported = err;
        },
      });

      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        assert.ok(errorReported instanceof Error);
        assert.match((errorReported as Error).message, /FNN node offline/);

        // Node comes back online
        shouldFail = false;
        errorReported = null;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        assert.equal(errorReported, null);
      } finally {
        controller.stop();
      }
    });
  });

  describe('isFundingInflightCollision', () => {
    it('detects ApiError with HTTP 409 status', () => {
      const err = new ApiError('Outpoint(s) already in flight', 409);
      assert.equal(isFundingInflightCollision(err), true);
    });

    it('detects generic objects with status 409', () => {
      assert.equal(isFundingInflightCollision({ status: 409 }), true);
    });

    it('detects the API inflight error text without requiring status', () => {
      assert.equal(isFundingInflightCollision(new Error('Outpoint(s) already in flight')), true);
    });

    it('returns false for unrelated errors or non-409 statuses', () => {
      assert.equal(isFundingInflightCollision(null), false);
      assert.equal(isFundingInflightCollision(undefined), false);
      assert.equal(isFundingInflightCollision(new ApiError('Bad Request', 400)), false);
      assert.equal(isFundingInflightCollision(new Error('Network error')), false);
      assert.equal(isFundingInflightCollision(new ApiError('channel (0x409abc) expired', 400)), false);
      assert.equal(isFundingInflightCollision(new Error('UTXO collision detected')), false);
    });
  });
});
