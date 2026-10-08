import { toFnnRpcTransaction } from '@ckb-on-ramp/contracts';

/** Whole-segment attempts for the sponsored (external funding) channel open. */
export const MAX_FUNDING_ATTEMPTS = 5;

/**
 * Delay before re-opening after a failed attempt. A 409 from /sign-funding now only
 * means another node's funding of the same operator cells is in flight (the API
 * releases this node's own stale reservations), so wait long enough for that tx to
 * land instead of hammering: 5s, 10s, 20s, 30s.
 */
export function fundingRetryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(5_000 * 2 ** (attempt - 1), 30_000);
}

/**
 * The operator-signed tx is handed to FNN `submit_signed_funding_tx`, which rejects
 * any field outside the CKB JSON-RPC Transaction shape. Older API builds (and tickets
 * saved by them) leaked `cellOutput` / `outputData` into inputs, so project the tx
 * onto the FNN shape before submitting. Values (and therefore the tx hash and
 * signatures) are unchanged.
 */
export function signedFundingTxForSubmit(signedTx: unknown): Record<string, unknown> {
  return toFnnRpcTransaction(signedTx);
}

/**
 * Best-effort cleanup of this node's own pending channel when the operator refused to
 * sign it (409). No signed funding tx exists for it, so abandoning cannot strand funds.
 * Never call this after a funding tx was signed.
 */
export async function abandonUnsignedChannel(
  node: { abandonChannel(params: { channel_id: `0x${string}` }): Promise<void> },
  channelId: string,
): Promise<boolean> {
  try {
    await node.abandonChannel({ channel_id: channelId as `0x${string}` });
    return true;
  } catch {
    return false;
  }
}
