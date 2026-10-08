import { createHash } from 'node:crypto';
import { normalizeCkbTransactionForRpc } from '@ckb-on-ramp/contracts';

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortedJson(object[key])]));
  }
  return value;
}

// Bind every field, including witnesses; allow only key-order and RPC/CCC naming differences.
export function fundingRequestHash(tx: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortedJson(normalizeCkbTransactionForRpc(tx))))
    .digest('hex');
}

export class FundingSigningError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'FundingSigningError';
  }
}
