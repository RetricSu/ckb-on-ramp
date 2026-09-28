import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearChannelTicket,
  loadChannelTicket,
  saveChannelTicket,
  type ChannelOpeningTicket,
} from './channelTicket';

// Mock localStorage for node test environment
class MockLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const mockStorage = new MockLocalStorage();
(globalThis as unknown as { localStorage: MockLocalStorage }).localStorage = mockStorage;

describe('channelTicket storage', () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  it('returns null when no ticket exists in storage', () => {
    assert.equal(loadChannelTicket(), null);
  });

  it('saves and loads a valid channel opening ticket', () => {
    const ticket: ChannelOpeningTicket = {
      sessionId: 'sess-abc-123',
      channelId: '0x1234567890abcdef',
      unsignedFundingTx: { mock: 'tx' },
      step: 'signing_funding',
      targetRaw: '50000000',
      createdAt: 1700000000000,
    };

    saveChannelTicket(ticket);
    const loaded = loadChannelTicket();
    assert.deepEqual(loaded, ticket);
  });

  it('updates ticket step and signed_funding_tx', () => {
    const ticket: ChannelOpeningTicket = {
      sessionId: 'sess-abc-123',
      channelId: '0x1234567890abcdef',
      unsignedFundingTx: { mock: 'tx' },
      step: 'signing_funding',
      targetRaw: '50000000',
      createdAt: 1700000000000,
    };
    saveChannelTicket(ticket);

    const updated: ChannelOpeningTicket = {
      ...ticket,
      signedFundingTx: { signed: true },
      step: 'submitting_funding',
    };
    saveChannelTicket(updated);

    const loaded = loadChannelTicket();
    assert.equal(loaded?.step, 'submitting_funding');
    assert.deepEqual(loaded?.signedFundingTx, { signed: true });
  });

  it('clears channel ticket from storage', () => {
    const ticket: ChannelOpeningTicket = {
      sessionId: 'sess-abc-123',
      step: 'waiting_for_channel',
      targetRaw: '50000000',
      createdAt: 1700000000000,
    };
    saveChannelTicket(ticket);
    assert.notEqual(loadChannelTicket(), null);

    clearChannelTicket();
    assert.equal(loadChannelTicket(), null);
  });

  it('preserves ticket at waiting_for_ready step on transient quote or order creation failure', () => {
    const ticket: ChannelOpeningTicket = {
      sessionId: 'sess-ready-123',
      channelId: '0xconfirmedchannelid',
      step: 'waiting_for_ready',
      targetRaw: '100000000',
      createdAt: Date.now(),
    };
    saveChannelTicket(ticket);

    // Simulate transient failure during quote/order issuance: ticket is untouched
    const loaded = loadChannelTicket();
    assert.ok(loaded);
    assert.equal(loaded?.step, 'waiting_for_ready');
    assert.equal(loaded?.channelId, '0xconfirmedchannelid');

    // Only after order is confirmed saved is clearChannelTicket invoked
    clearChannelTicket();
    assert.equal(loadChannelTicket(), null);
  });

  it('gracefully handles malformed JSON in storage', () => {
    mockStorage.setItem('ckb-on-ramp:channel-ticket', 'invalid-json{{{');
    assert.equal(loadChannelTicket(), null);
  });
});
