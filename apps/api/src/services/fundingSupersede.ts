import type { OperatorCkbSender } from './ccc.js';
import type { InflightOutpointsTracker } from './inflightOutpoints.js';
import type { BootstrapSessionStore, StoredBootstrapSession } from './bootstrapStore.js';

/** Chain states in which a signed funding tx may still confirm; its inputs must stay reserved. */
const LIVE_TX_STATUSES = new Set(['sent', 'pending', 'proposed', 'committed']);

const normalizePubkey = (value?: string) => (value ?? '').trim().toLowerCase().replace(/^0x/, '');

export interface SupersedeContext {
  /** Channel requesting a signature now. */
  channelId: string;
  session: StoredBootstrapSession;
  conflictingKeys: string[];
  store: BootstrapSessionStore;
  inflight: InflightOutpointsTracker;
  sender: OperatorCkbSender;
  /** True while a signature for that channel is still being produced. */
  isSigning: (channelId: string) => boolean;
}

export interface SupersedeResult {
  released: string[];
  /** Why the conflict could not be cleared (empty when released). */
  blockedReason?: string;
}

/**
 * A user node builds the external-funding tx itself and deterministically picks the
 * same operator gift cells on every attempt. When an earlier attempt from the SAME
 * node was signed but its funding tx never reached the chain (e.g. the submit failed),
 * its reservation only blocks that node's own retry (issue #2). Such reservations are
 * released so the retry can be signed immediately.
 *
 * Double-spend protection is kept: reservations held by a different node, by a
 * channel whose signing is still in progress, by a channel without a stored signed
 * tx, or by a tx that the CKB node reports as sent/pending/proposed/committed are
 * never released here. Only the API reservation is dropped; the operator FNN's
 * pending channel is left alone so that, should the old tx be broadcast after all,
 * that channel still completes normally (the two txs spend the same input, so at
 * most one can confirm).
 */
export async function releaseSupersededReservations(ctx: SupersedeContext): Promise<SupersedeResult> {
  const holders = ctx.inflight.activeHolders(ctx.conflictingKeys);
  const requester = normalizePubkey(ctx.session.node_pubkey);
  if (!requester) return { released: [], blockedReason: 'requesting session has no node_pubkey' };

  const releasable: StoredBootstrapSession[] = [];
  for (const holder of holders) {
    if (!holder || holder === ctx.channelId) {
      return { released: [], blockedReason: 'outpoint reserved without an owning channel' };
    }
    const previous = ctx.store.getByChannelId(holder);
    if (!previous) return { released: [], blockedReason: `no session for reserving channel ${holder}` };
    if (normalizePubkey(previous.node_pubkey) !== requester) {
      return { released: [], blockedReason: 'outpoints are reserved by another node' };
    }
    if (ctx.isSigning(holder) || previous.signed_funding_tx === undefined) {
      return { released: [], blockedReason: `signing for channel ${holder} has not completed` };
    }
    if (!ctx.sender.getFundingTxStatus) {
      return { released: [], blockedReason: 'operator signer cannot check funding tx status' };
    }
    let status: string;
    try {
      status = await ctx.sender.getFundingTxStatus(previous.signed_funding_tx);
    } catch (error) {
      return { released: [], blockedReason: error instanceof Error ? error.message : String(error) };
    }
    if (LIVE_TX_STATUSES.has(status)) {
      return { released: [], blockedReason: `funding tx of channel ${holder} is ${status} on chain` };
    }
    releasable.push(previous);
  }

  const released: string[] = [];
  for (const previous of releasable) {
    const previousChannel = previous.channel_id!;
    ctx.inflight.release(previousChannel);
    ctx.store.set(previous.session_id, {
      ...previous,
      status: 'failed',
      message: `Superseded by a newer funding attempt from the same node (channel ${ctx.channelId}); the previous funding tx never reached the chain.`,
    });
    released.push(previousChannel);
  }
  return { released };
}
