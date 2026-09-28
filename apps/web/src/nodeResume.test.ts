import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  determineAutoResumeStrategy,
  isPendingStatus,
  shouldExpireOrderOn404,
  shouldResumeNode,
} from './nodeResume';
import type { ChannelOpeningTicket } from './channelTicket';

describe('nodeResume pure functions', () => {
  describe('isPendingStatus', () => {
    it('returns true for in-flight swap statuses', () => {
      assert.equal(isPendingStatus('Pending'), true);
      assert.equal(isPendingStatus('IncomingAccepted'), true);
      assert.equal(isPendingStatus('OutgoingInFlight'), true);
    });

    it('returns false for terminal or empty statuses', () => {
      assert.equal(isPendingStatus('Success'), false);
      assert.equal(isPendingStatus('OutgoingSuccess'), false);
      assert.equal(isPendingStatus('Failed'), false);
      assert.equal(isPendingStatus('Expired'), false);
      assert.equal(isPendingStatus(undefined), false);
      assert.equal(isPendingStatus(null), false);
      assert.equal(isPendingStatus(''), false);
    });
  });

  describe('shouldResumeNode', () => {
    it('returns true when hasPasskeyConfigured is true regardless of pending order', () => {
      assert.equal(shouldResumeNode({ hasPasskeyConfigured: true }), true);
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: true,
          pendingOrder: { status: 'Success' },
        }),
        true,
      );
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: true,
          pendingOrder: null,
          pendingReceipts: [],
        }),
        true,
      );
    });

    it('returns true when a pending order is in-flight even if passkeyConfigured is false', () => {
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: { status: 'Pending' },
        }),
        true,
      );
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: { status: 'IncomingAccepted' },
        }),
        true,
      );
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: { status: 'OutgoingInFlight' },
        }),
        true,
      );
    });

    it('returns false when order is settled, failed, or expired and no passkey is configured', () => {
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: { status: 'Success' },
        }),
        false,
      );
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: { status: 'Failed' },
        }),
        false,
      );
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: { status: 'Expired' },
        }),
        false,
      );
    });

    it('returns true when pendingReceipts contains at least one in-flight receipt', () => {
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingReceipts: [{ status: 'Success' }, { status: 'Pending' }],
        }),
        true,
      );
    });

    it('returns false when all receipts are in terminal states', () => {
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingReceipts: [{ status: 'Success' }, { status: 'Failed' }],
        }),
        false,
      );
    });

    it('returns true when a pending channel ticket exists', () => {
      const ticket: ChannelOpeningTicket = {
        sessionId: 'session-123',
        channelId: '0xabc',
        step: 'signing_funding',
        targetRaw: '100000000',
        createdAt: Date.now(),
      };
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingChannel: ticket,
        }),
        true,
      );
    });

    it('returns false when parameters are empty or falsy', () => {
      assert.equal(shouldResumeNode({}), false);
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: null,
          pendingReceipts: [],
          pendingChannel: null,
        }),
        false,
      );
    });
  });

  describe('Pending order restore across browser refresh', () => {
    it('restores pending order from storage and triggers node resume', () => {
      const storedOrder = {
        order_id: 'hash123',
        payment_hash: 'hash123',
        status: 'Pending' as const,
        lightning_invoice: 'lnbcrt100u1mock',
        fiber_invoice: 'fibt1mock',
        receive_raw: '10000000',
        pay_sats: 10100,
        fee_sats: 100,
        created_at: new Date().toISOString(),
      };

      // Even before passkey state is determined, the presence of restored in-flight order triggers node start
      assert.equal(isPendingStatus(storedOrder.status), true);
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: false,
          pendingOrder: storedOrder,
        }),
        true,
      );
    });

    it('hasPasskeyConfigured retriggers node start even when orders are empty', () => {
      // User returns or refreshes; no orders in localStorage, but passkey is already configured
      assert.equal(
        shouldResumeNode({
          hasPasskeyConfigured: true,
          pendingOrder: null,
          pendingReceipts: [],
          pendingChannel: null,
        }),
        true,
      );
    });
  });

  describe('determineAutoResumeStrategy and auto-resume key invariants', () => {
    it('MUST NOT allow auto-resume to create a new passkey when hasPasskeyConfigured is false', () => {
      // Invariant: If user refreshes and hasPasskeyConfigured is still false during initial render,
      // auto-resume must return action 'wait' and canResume=false, NEVER creating a new passkey.
      const strategy = determineAutoResumeStrategy({
        hasPasskeyConfigured: false,
        e2ePassword: null,
        shouldResume: true,
      });

      assert.equal(strategy.canResume, false);
      assert.equal(strategy.action, 'wait');
      assert.notEqual(strategy.action, 'createPasskeyAndStart');
    });

    it('proceeds with startWithPasskey only when hasPasskeyConfigured is true', () => {
      const strategy = determineAutoResumeStrategy({
        hasPasskeyConfigured: true,
        e2ePassword: null,
        shouldResume: true,
      });

      assert.equal(strategy.canResume, true);
      assert.equal(strategy.action, 'startWithPasskey');
    });

    it('allows dev e2e password when configured', () => {
      const strategy = determineAutoResumeStrategy({
        hasPasskeyConfigured: false,
        e2ePassword: 'local-test-password',
        shouldResume: true,
      });

      assert.equal(strategy.canResume, true);
      assert.equal(strategy.action, 'startWithPassword');
    });

    it('does nothing when shouldResume is false', () => {
      const strategy = determineAutoResumeStrategy({
        hasPasskeyConfigured: true,
        shouldResume: false,
      });

      assert.equal(strategy.canResume, false);
      assert.equal(strategy.action, 'none');
    });
  });
});
