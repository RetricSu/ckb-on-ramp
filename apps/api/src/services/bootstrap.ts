import { randomUUID } from 'node:crypto';
import { CWBTC_SCRIPT, normalizeChannelStateName, type BootstrapRequest, type BootstrapSession } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';
import { CccOperatorCkbSender, type OperatorCkbSender } from './ccc.js';
import { cchGateway, type CchGateway } from './cch.js';

import { redactSecret } from '../utils/redact.js';
import { getOperatorSigner } from './operatorSigner.js';
import {
  FileBootstrapSessionStore,
  type BootstrapSessionStore,
} from './bootstrapStore.js';

const CKB_TESTNET_ADDRESS_REGEX = /^ckt1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,120}$/i;
const SECP256K1_PUBKEY_REGEX = /^(0x)?[0-9a-fA-F]{66}$/;

const MAX_BOOTSTRAP_SESSIONS = 1_000;
let activeStore: BootstrapSessionStore = new FileBootstrapSessionStore();
const sessionTasks = new Map<string, Promise<void>>();

const trimOldest = <K, V>(map: Map<K, V>) => {
  while (map.size >= MAX_BOOTSTRAP_SESSIONS) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
};

export function setBootstrapSessionStore(store: BootstrapSessionStore): void {
  activeStore = store;
}

export function getBootstrapSessionStore(): BootstrapSessionStore {
  return activeStore;
}

export function getBootstrapSession(sessionId: string): BootstrapSession | undefined {
  return activeStore.get(sessionId);
}

export function getBootstrapSessionByChannelId(channelId: string): BootstrapSession | undefined {
  return activeStore.getByChannelId(channelId);
}

export async function recoverSessionFromFnn(
  channelId: string,
  gateway: CchGateway = cchGateway,
  fundingAmount: string = config.operatorChannelFundingAmount,
): Promise<BootstrapSession | undefined> {
  if (!gateway.listChannels) return undefined;
  try {
    const target = channelId.trim().toLowerCase();
    const res = await gateway.listChannels({});
    const channels = res?.channels ?? [];
    const matched = channels.find((ch) => String(ch.channel_id ?? '').trim().toLowerCase() === target);
    if (!matched) return undefined;

    const pubkey = String(matched.pubkey ?? '').replace(/^0x/, '');
    const reconstructed: BootstrapSession = {
      session_id: randomUUID(),
      channel_id: matched.channel_id,
      status: 'provisioning_liquidity',
      node_pubkey: pubkey,
      funding_amount: fundingAmount,
      expires_at: Date.now() + 5 * 60 * 1000,
      signed: false,
      message: 'Reconstructed bootstrap session from FNN list_channels.',
    };

    activeStore.set(reconstructed.session_id, reconstructed);
    return reconstructed;
  } catch (err) {
    console.warn(`[Bootstrap Recovery] Failed to query FNN for channel ${channelId}:`, err);
    return undefined;
  }
}

export function getBootstrapSessionTask(sessionId: string): Promise<void> | undefined {
  return sessionTasks.get(sessionId);
}

export function clearBootstrapSessionsForTest(): void {
  activeStore.clear();
  sessionTasks.clear();
}

export function validateBootstrapRequest(input: Partial<BootstrapRequest>): BootstrapRequest {
  const nodePubkey = String(input.node_pubkey ?? '').trim();
  if (!SECP256K1_PUBKEY_REGEX.test(nodePubkey)) {
    throw new Error('node_pubkey must be a compressed secp256k1 public key (66 hex characters)');
  }
  const isExternal = Boolean(input.external_funding);
  const rawFundingAddress = input.funding_address ? String(input.funding_address).trim() : '';

  if (!isExternal && !rawFundingAddress) {
    throw new Error('funding_address must be a valid CKB testnet address (starting with ckt1)');
  }
  if (rawFundingAddress && !CKB_TESTNET_ADDRESS_REGEX.test(rawFundingAddress)) {
    throw new Error('funding_address must be a valid CKB testnet address (starting with ckt1)');
  }

  return {
    node_pubkey: nodePubkey,
    funding_address: rawFundingAddress || undefined,
    external_funding: isExternal ? true : undefined,
  };
}

export interface BootstrapDependencies {
  operatorCkbSender?: OperatorCkbSender;
  cchGateway?: CchGateway;
  operatorPrivateKey?: string;
  ckbRpcUrl?: string;
  channelFundingAmount?: string;
  skipCapacityGift?: boolean;
}

export async function prepareInboundLiquidity(
  input: BootstrapRequest,
  dependencies?: BootstrapDependencies,
): Promise<BootstrapSession> {
  const validated = validateBootstrapRequest(input);

  const operatorPrivateKey = dependencies?.operatorPrivateKey ?? config.operatorCkbPrivateKey;
  const skipCapacityGift = dependencies?.skipCapacityGift ?? config.skipCapacityGift;
  if (!operatorPrivateKey && !skipCapacityGift) {
    const message = validated.external_funding
      ? 'Operator external funding is not configured: OPERATOR_CKB_PRIVATE_KEY is unset.'
      : 'Scheme B inbound-liquidity provisioning (unpaid CKB capacity gift) is not wired: OPERATOR_CKB_PRIVATE_KEY is not configured and channel funding is not implemented.';
    return {
      session_id: randomUUID(),
      status: 'failed',
      message,
    };
  }

  try {
    const gateway = dependencies?.cchGateway ?? cchGateway;
    const rawFundingAmount = dependencies?.channelFundingAmount ?? config.operatorChannelFundingAmount;
    const fundingAmountHex = '0x' + BigInt(rawFundingAmount).toString(16);
    const pubkey = validated.node_pubkey.replace(/^0x/, '');

    // 2. Fetch peer address best-effort
    let peerAddress: string | undefined;
    try {
      const nodeInfo = await gateway.getNodeInfo();
      peerAddress = nodeInfo.addresses[0];
    } catch (error) {
      void error;
      // Best-effort; do not fail if getNodeInfo fails
    }

    if (validated.external_funding) {
      // External funding mode: Operator acts as acceptor (出 1.0 cWBTC)
      // and waits for the incoming channel opening offer from the user node.
      const sessionId = randomUUID();
      const session: BootstrapSession = {
        session_id: sessionId,
        status: 'waiting_for_channel',
        peer_address: peerAddress,
        message: 'Operator ready to accept inbound channel. Waiting for open_channel_with_external_funding offer.',
        node_pubkey: pubkey,
        funding_amount: rawFundingAmount,
        expires_at: Date.now() + 5 * 60 * 1000,
        signed: false,
      };

      activeStore.set(sessionId, session);

      const targetPubkey = pubkey.toLowerCase();
      const task = (async () => {
        try {
          const start = Date.now();
          const timeoutMs = 60_000;
          let accepted = false;

          if (!gateway.listChannels || !gateway.acceptChannel) {
            throw new Error('Gateway does not support channel acceptance');
          }

          let lastAcceptError: string | undefined;

          while (Date.now() - start < timeoutMs) {
            let listRes: { channels?: any[] } | undefined;
            try {
              listRes = await gateway.listChannels({ only_pending: true, pubkey: targetPubkey });
            } catch (listErr) {
              console.warn('[Bootstrap Watcher] listChannels transient error:', listErr);
            }

            const candidates = (listRes?.channels ?? []).filter((ch) => {
              const pk = String(ch.pubkey ?? '').replace(/^0x/, '').toLowerCase();
              const isPending = normalizeChannelStateName(ch.state?.state_name) === 'NEGOTIATINGFUNDING';
              const udt = ch.funding_udt_type_script;
              const isCwbtc =
                !udt ||
                (String(udt.code_hash ?? udt.codeHash ?? '').toLowerCase() === CWBTC_SCRIPT.code_hash.toLowerCase() &&
                  String(udt.args ?? '').toLowerCase() === CWBTC_SCRIPT.args.toLowerCase());
              return ch.is_acceptor && pk === targetPubkey && isPending && isCwbtc;
            });

            for (const pending of candidates) {
              try {
                const acceptRes = await gateway.acceptChannel({
                  temporary_channel_id: pending.channel_id,
                  funding_amount: fundingAmountHex,
                });
                const existing = activeStore.get(sessionId);
                if (existing) {
                  existing.channel_id = acceptRes.channel_id;
                  existing.status = 'provisioning_liquidity';
                  existing.message = `Inbound channel offer accepted (${acceptRes.channel_id}). External funding collaboration in progress.`;
                  activeStore.set(sessionId, existing);
                }
                accepted = true;
                break;
              } catch (acceptErr) {
                lastAcceptError = acceptErr instanceof Error ? acceptErr.message : String(acceptErr);
                console.warn(`[Bootstrap Watcher] acceptChannel failed on ${pending.channel_id}:`, lastAcceptError);
              }
            }

            if (accepted) {
              break;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }

          if (!accepted) {
            const existing = activeStore.get(sessionId);
            if (existing && existing.status === 'waiting_for_channel') {
              existing.status = 'failed';
              const detail = lastAcceptError ? ` Last error: ${lastAcceptError}` : '';
              existing.message = `Timed out waiting for open_channel_with_external_funding offer from user node.${detail}`;
              activeStore.set(sessionId, existing);
            }
          }
        } catch (err) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          const sanitizedMsg = redactSecret(rawMsg, operatorPrivateKey, '[REDACTED]');
          const existing = activeStore.get(sessionId);
          if (existing) {
            existing.status = 'failed';
            existing.message = `Channel acceptance failed: ${sanitizedMsg}`;
            activeStore.set(sessionId, existing);
          }
        }
      })();

      trimOldest(sessionTasks);
      sessionTasks.set(sessionId, task);

      return { ...session };
    }

    const sender = skipCapacityGift
      ? undefined
      : dependencies?.operatorCkbSender ??
        (dependencies?.operatorPrivateKey
          ? new CccOperatorCkbSender(dependencies.operatorPrivateKey, dependencies?.ckbRpcUrl ?? config.ckbRpcUrl)
          : getOperatorSigner());

    // 1. Submit ≥200 CKB capacity gift unless local e2e skips it (offckb accounts are pre-funded).
    const giftResult = sender ? await sender.sendCapacityGift(validated.funding_address!, 200) : undefined;

    // 3. Create in-memory session with gift tx hash and provisioning_liquidity status
    const sessionId = randomUUID();
    const session: BootstrapSession = {
      session_id: sessionId,
      status: 'provisioning_liquidity',
      peer_address: peerAddress,
      gift_tx_hash: giftResult?.txHash,
      message: giftResult
        ? `Operator capacity gift submitted (tx: ${giftResult.txHash}). Waiting for CKB confirmation and channel opening.`
        : 'Skipping CKB capacity gift (SKIP_CAPACITY_GIFT=1). Opening inbound UDT channel.',
    };

    activeStore.set(sessionId, session);

    // 4. Background task: waitTransaction → FNN open_channel → update session (channel_id)
    const task = (async () => {
      try {
        if (sender?.waitForTransaction && giftResult?.txHash) {
          await sender.waitForTransaction(giftResult.txHash);
        }
        const openResult = await gateway.openChannel({
          pubkey,
          funding_amount: fundingAmountHex,
          funding_udt_type_script: CWBTC_SCRIPT,
          one_way: true,
          public: false,
        });
        const existing = activeStore.get(sessionId);
        if (existing) {
          existing.channel_id = openResult.channel_id;
          existing.status = 'provisioning_liquidity';
          existing.message = giftResult
            ? `Operator capacity gift confirmed (tx: ${giftResult.txHash}). Channel opening initiated (${openResult.channel_id}). Channel acceptance in progress.`
            : `Channel opening initiated (${openResult.channel_id}). Channel acceptance in progress.`;
          activeStore.set(sessionId, existing);
        }
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const sanitizedMsg = redactSecret(rawMsg, operatorPrivateKey, '[REDACTED]');
        const existing = activeStore.get(sessionId);
        if (existing) {
          existing.status = 'failed';
          existing.message = `Channel opening failed: ${sanitizedMsg}`;
          activeStore.set(sessionId, existing);
        }
      }
    })();

    trimOldest(sessionTasks);
    sessionTasks.set(sessionId, task);

    return { ...session };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = redactSecret(rawMsg, operatorPrivateKey, '[REDACTED]');
    throw new Error(sanitizedMsg);
  }
}
