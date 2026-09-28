import type { Quote } from '@ckb-on-ramp/contracts';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { assertWithinFundingLimit, parseFundingLimit } from './fundingAvailability.js';

const MAX_RAW = BigInt(Number.MAX_SAFE_INTEGER);

export function createQuote(receiveRawInput: string, now = Date.now(), fundingLimit = parseFundingLimit()): Quote {
  if (!/^\d+$/.test(receiveRawInput)) throw new Error('receive_raw must be a positive integer string');
  const receiveRaw = BigInt(receiveRawInput);
  if (receiveRaw <= 0n || receiveRaw > MAX_RAW) throw new Error('receive_raw is outside the supported range');
  assertWithinFundingLimit(receiveRaw, fundingLimit);
  const proportionalFee = (receiveRaw * BigInt(config.feeRatePpm)) / 1_000_000n;
  const feeSats = BigInt(config.baseFeeSats) + proportionalFee;
  const paySats = receiveRaw + feeSats;
  if (paySats > MAX_RAW) throw new Error('receive_raw plus fees exceeds the supported range');
  return {
    quote_id: randomUUID(),
    receive_raw: receiveRaw.toString(),
    pay_sats: Number(paySats),
    fee_sats: Number(feeSats),
    expires_at: new Date(now + 5 * 60_000).toISOString(),
  };
}
