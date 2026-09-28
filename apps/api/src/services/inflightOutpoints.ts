import { normalizeCkbTransactionForCcc } from '@ckb-on-ramp/contracts';

export class InflightCollisionError extends Error {
  constructor(
    message: string,
    public readonly conflictingKeys: string[],
  ) {
    super(message);
    this.name = 'InflightCollisionError';
  }
}

export interface InflightReservation {
  channelId?: string;
  expiresAt: number;
  reservedAt: number;
}

export interface InflightReserveOptions {
  ttlMs?: number;
  now?: number;
}

export const DEFAULT_INFLIGHT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Normalizes an outpoint (txHash + index) into a canonical lowercased key: `txHash:index`.
 * Both txHash and index are formatted with 0x prefixes and lowercased.
 */
export function normalizeOutpointKey(txHashOrKey: string, index?: string | number | bigint): string {
  if (index === undefined && txHashOrKey.includes(':')) {
    const colonIdx = txHashOrKey.indexOf(':');
    const hashPart = txHashOrKey.slice(0, colonIdx);
    const indexPart = txHashOrKey.slice(colonIdx + 1);
    return normalizeOutpointKey(hashPart, indexPart);
  }

  let hash = txHashOrKey.trim().toLowerCase();
  if (!hash.startsWith('0x')) {
    hash = `0x${hash}`;
  }

  let idxStr: string;
  if (typeof index === 'number' || typeof index === 'bigint') {
    idxStr = `0x${index.toString(16).toLowerCase()}`;
  } else if (index !== undefined) {
    const raw = String(index).trim().toLowerCase();
    try {
      idxStr = `0x${BigInt(raw).toString(16)}`;
    } catch {
      idxStr = raw.startsWith('0x') ? raw : `0x${raw}`;
    }
  } else {
    idxStr = '0x0';
  }

  return `${hash}:${idxStr}`;
}

/**
 * Extracts and canonicalizes all previous_output outpoints from an unsigned funding transaction.
 * Supports snake_case, camelCase, or mixed representations.
 */
export function extractFundingTxOutpointKeys(unsignedTx: unknown): string[] {
  if (!unsignedTx || typeof unsignedTx !== 'object') {
    return [];
  }

  const normalized = normalizeCkbTransactionForCcc(unsignedTx) as {
    inputs?: Array<{
      previousOutput?: { txHash?: unknown; index?: unknown };
      previous_output?: { tx_hash?: unknown; index?: unknown };
    }>;
  };

  const inputs = Array.isArray(normalized.inputs) ? normalized.inputs : [];
  const keys: string[] = [];

  for (const input of inputs) {
    const prev = input?.previousOutput ?? input?.previous_output;
    if (!prev) continue;

    const rawTxHash =
      'txHash' in prev ? prev.txHash : 'tx_hash' in prev ? prev.tx_hash : undefined;
    const rawIndex = prev.index;

    if (rawTxHash !== undefined && rawIndex !== undefined) {
      keys.push(normalizeOutpointKey(String(rawTxHash), rawIndex as string | number | bigint));
    }
  }

  return Array.from(new Set(keys));
}

export class InflightOutpointsTracker {
  private readonly reservations = new Map<string, InflightReservation>();

  /**
   * Attempts to reserve outpoint keys.
   * Enforces all-or-nothing: if any key is currently reserved by a different channel,
   * an InflightCollisionError is thrown and NO keys are reserved.
   * Same-channel re-reservations are permitted.
   */
  tryReserve(
    arg1: string | string[],
    arg2?: string | string[],
    options?: InflightReserveOptions,
  ): void {
    let keys: string[];
    let channelId: string | undefined;

    if (Array.isArray(arg1)) {
      keys = arg1;
      channelId = typeof arg2 === 'string' ? arg2 : undefined;
    } else if (typeof arg1 === 'string' && Array.isArray(arg2)) {
      channelId = arg1;
      keys = arg2;
    } else if (typeof arg1 === 'string') {
      keys = [arg1];
      channelId = typeof arg2 === 'string' ? arg2 : undefined;
    } else {
      keys = [];
    }

    if (keys.length === 0) {
      return;
    }

    const now = options?.now ?? Date.now();
    const ttlMs = options?.ttlMs ?? DEFAULT_INFLIGHT_TTL_MS;
    const canonicalKeys = Array.from(new Set(keys.map((k) => normalizeOutpointKey(k))));

    // Pass 1: Check collisions (all-or-nothing check)
    const colliding: string[] = [];
    for (const key of canonicalKeys) {
      const existing = this.reservations.get(key);
      if (existing && existing.expiresAt > now) {
        // Active reservation: collision if belonging to a different channel
        if (!channelId || existing.channelId !== channelId) {
          colliding.push(key);
        }
      }
    }

    if (colliding.length > 0) {
      throw new InflightCollisionError(
        `Outpoint(s) already in flight: ${colliding.join(', ')}`,
        colliding,
      );
    }

    // Pass 2: Reserve all keys
    const expiresAt = now + ttlMs;
    for (const key of canonicalKeys) {
      this.reservations.set(key, {
        channelId,
        expiresAt,
        reservedAt: now,
      });
    }
  }

  /**
   * Releases reservations for given keys or for a given channelId.
   */
  release(keysOrChannelId?: string | string[], channelId?: string): void {
    if (keysOrChannelId === undefined) {
      this.reservations.clear();
      return;
    }

    if (Array.isArray(keysOrChannelId)) {
      for (const rawKey of keysOrChannelId) {
        const key = normalizeOutpointKey(rawKey);
        const existing = this.reservations.get(key);
        if (existing) {
          if (!channelId || existing.channelId === channelId) {
            this.reservations.delete(key);
          }
        }
      }
      return;
    }

    if (typeof keysOrChannelId === 'string') {
      if (keysOrChannelId.includes(':')) {
        // Specific key
        const key = normalizeOutpointKey(keysOrChannelId);
        const existing = this.reservations.get(key);
        if (existing && (!channelId || existing.channelId === channelId)) {
          this.reservations.delete(key);
        }
      } else {
        // Channel ID
        const targetChannel = keysOrChannelId;
        for (const [key, entry] of this.reservations.entries()) {
          if (entry.channelId === targetChannel) {
            this.reservations.delete(key);
          }
        }
      }
    }
  }

  /**
   * Checks if an outpoint is currently in flight.
   */
  isReserved(key: string, now: number = Date.now()): boolean {
    const canonical = normalizeOutpointKey(key);
    const existing = this.reservations.get(canonical);
    return Boolean(existing && existing.expiresAt > now);
  }

  /**
   * Returns current active reservation count.
   */
  size(now: number = Date.now()): number {
    let count = 0;
    for (const entry of this.reservations.values()) {
      if (entry.expiresAt > now) count += 1;
    }
    return count;
  }

  /**
   * Clears all reservations (for testing).
   */
  clearForTest(): void {
    this.reservations.clear();
  }
}

export const defaultInflightTracker = new InflightOutpointsTracker();
export const tryReserve = defaultInflightTracker.tryReserve.bind(defaultInflightTracker);
export const release = defaultInflightTracker.release.bind(defaultInflightTracker);
export const clearForTest = defaultInflightTracker.clearForTest.bind(defaultInflightTracker);
