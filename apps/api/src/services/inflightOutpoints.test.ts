import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  InflightCollisionError,
  InflightOutpointsTracker,
  extractFundingTxOutpointKeys,
  normalizeOutpointKey,
} from './inflightOutpoints.js';

describe('InflightOutpointsTracker', () => {
  let tracker: InflightOutpointsTracker;

  beforeEach(() => {
    tracker = new InflightOutpointsTracker();
  });

  describe('normalizeOutpointKey', () => {
    it('normalizes hex txHash and hex index to lowercase 0x format', () => {
      assert.equal(
        normalizeOutpointKey('0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890', '0x0'),
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0x0',
      );
    });

    it('normalizes numeric index and hex index with different paddings to identical representation', () => {
      const hash = '0x' + 'aa'.repeat(32);
      assert.equal(normalizeOutpointKey(hash, 0), `${hash}:0x0`);
      assert.equal(normalizeOutpointKey(hash, '0x0'), `${hash}:0x0`);
      assert.equal(normalizeOutpointKey(hash, '0x00'), `${hash}:0x0`);
      assert.equal(normalizeOutpointKey(hash, 1), `${hash}:0x1`);
      assert.equal(normalizeOutpointKey(hash, '0x1'), `${hash}:0x1`);
      assert.equal(normalizeOutpointKey(hash, '0x01'), `${hash}:0x1`);
      assert.equal(normalizeOutpointKey(hash, 16), `${hash}:0x10`);
    });

    it('handles combined key strings', () => {
      const hash = '0x' + 'BB'.repeat(32);
      assert.equal(normalizeOutpointKey(`${hash}:0x0`), `${hash.toLowerCase()}:0x0`);
      assert.equal(normalizeOutpointKey(`${hash}:0`), `${hash.toLowerCase()}:0x0`);
    });
  });

  describe('extractFundingTxOutpointKeys', () => {
    it('extracts outpoints from snake_case transaction', () => {
      const tx = {
        inputs: [
          { previous_output: { tx_hash: '0x' + '11'.repeat(32), index: '0x0' } },
          { previous_output: { tx_hash: '0x' + '22'.repeat(32), index: '0x1' } },
        ],
      };
      const keys = extractFundingTxOutpointKeys(tx);
      assert.deepEqual(keys, [
        `0x${'11'.repeat(32)}:0x0`,
        `0x${'22'.repeat(32)}:0x1`,
      ]);
    });

    it('extracts outpoints from camelCase transaction', () => {
      const tx = {
        inputs: [
          { previousOutput: { txHash: '0x' + '33'.repeat(32), index: 0 } },
        ],
      };
      const keys = extractFundingTxOutpointKeys(tx);
      assert.deepEqual(keys, [`0x${'33'.repeat(32)}:0x0`]);
    });

    it('deduplicates identical outpoint inputs within the same transaction', () => {
      const tx = {
        inputs: [
          { previous_output: { tx_hash: '0x' + '44'.repeat(32), index: '0x0' } },
          { previous_output: { tx_hash: '0x' + '44'.repeat(32), index: 0 } },
        ],
      };
      const keys = extractFundingTxOutpointKeys(tx);
      assert.equal(keys.length, 1);
      assert.equal(keys[0], `0x${'44'.repeat(32)}:0x0`);
    });

    it('gracefully handles missing inputs or invalid objects', () => {
      assert.deepEqual(extractFundingTxOutpointKeys(null), []);
      assert.deepEqual(extractFundingTxOutpointKeys({}), []);
      assert.deepEqual(extractFundingTxOutpointKeys({ inputs: [] }), []);
      assert.deepEqual(extractFundingTxOutpointKeys({ inputs: [{ foo: 'bar' }] }), []);
    });
  });

  describe('tryReserve and collision detection', () => {
    const key1 = `0x${'aa'.repeat(32)}:0x0`;
    const key2 = `0x${'bb'.repeat(32)}:0x0`;
    const key3 = `0x${'cc'.repeat(32)}:0x0`;

    it('reserves available keys successfully', () => {
      tracker.tryReserve([key1, key2], 'channel-1');
      assert.equal(tracker.isReserved(key1), true);
      assert.equal(tracker.isReserved(key2), true);
      assert.equal(tracker.isReserved(key3), false);
      assert.equal(tracker.size(), 2);
    });

    it('allows same-channel re-reservation', () => {
      tracker.tryReserve([key1], 'channel-1');
      // Same channel re-reserves -> should succeed
      assert.doesNotThrow(() => {
        tracker.tryReserve([key1], 'channel-1');
      });
      assert.equal(tracker.isReserved(key1), true);
    });

    it('throws dedicated InflightCollisionError when another channel collides', () => {
      tracker.tryReserve([key1], 'channel-1');

      assert.throws(
        () => tracker.tryReserve([key1], 'channel-2'),
        (err: unknown) => {
          assert.ok(err instanceof InflightCollisionError);
          assert.deepEqual(err.conflictingKeys, [key1]);
          assert.match(err.message, /already in flight/);
          return true;
        },
      );
    });

    it('enforces all-or-nothing: if one key collides, none of the batch are reserved', () => {
      tracker.tryReserve([key1], 'channel-1');

      // channel-2 tries to reserve key1 (collides) and key2 (free)
      assert.throws(() => {
        tracker.tryReserve([key1, key2], 'channel-2');
      });

      // key2 must NOT have been reserved by channel-2!
      assert.equal(tracker.isReserved(key2), false);
    });

    it('auto-releases keys after TTL expires', () => {
      const startTime = 1_000_000;
      const ttlMs = 5 * 60 * 1000; // 5 min

      tracker.tryReserve([key1], 'channel-1', { now: startTime, ttlMs });
      assert.equal(tracker.isReserved(key1, startTime + 1000), true);

      // Just before expiration -> still reserved
      assert.equal(tracker.isReserved(key1, startTime + ttlMs - 1), true);

      // After expiration -> no longer reserved
      assert.equal(tracker.isReserved(key1, startTime + ttlMs + 1), false);

      // Channel 2 can now reserve it
      assert.doesNotThrow(() => {
        tracker.tryReserve([key1], 'channel-2', { now: startTime + ttlMs + 1, ttlMs });
      });
      assert.equal(tracker.isReserved(key1, startTime + ttlMs + 2), true);
    });

    it('release removes keys specifically or by channel', () => {
      tracker.tryReserve([key1, key2], 'channel-1');
      tracker.tryReserve([key3], 'channel-2');

      // Release key1
      tracker.release([key1], 'channel-1');
      assert.equal(tracker.isReserved(key1), false);
      assert.equal(tracker.isReserved(key2), true);
      assert.equal(tracker.isReserved(key3), true);

      // Release by channel-2
      tracker.release('channel-2');
      assert.equal(tracker.isReserved(key3), false);

      // Clear all
      tracker.clearForTest();
      assert.equal(tracker.size(), 0);
    });
  });
});
