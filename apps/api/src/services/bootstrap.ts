import { randomUUID } from 'node:crypto';
import { CWBTC_SCRIPT, type BootstrapRequest, type BootstrapSession } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';
import { CccOperatorCkbSender, type OperatorCkbSender } from './ccc.js';
import { cchGateway, type CchGateway } from './cch.js';

const CKB_TESTNET_ADDRESS_REGEX = /^ckt1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,120}$/i;
const SECP256K1_PUBKEY_REGEX = /^(0x)?[0-9a-fA-F]{66}$/;

const MAX_BOOTSTRAP_SESSIONS = 1_000;
const sessions = new Map<string, BootstrapSession>();
const sessionTasks = new Map<string, Promise<void>>();

const trimOldest = <K, V>(map: Map<K, V>) => {
  while (map.size >= MAX_BOOTSTRAP_SESSIONS) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
};

export function getBootstrapSession(sessionId: string): BootstrapSession | undefined {
  return sessions.get(sessionId);
}

export function getBootstrapSessionTask(sessionId: string): Promise<void> | undefined {
  return sessionTasks.get(sessionId);
}

export function clearBootstrapSessionsForTest(): void {
  sessions.clear();
  sessionTasks.clear();
}

export function validateBootstrapRequest(input: Partial<BootstrapRequest>): BootstrapRequest {
  const nodePubkey = String(input.node_pubkey ?? '').trim();
  if (!SECP256K1_PUBKEY_REGEX.test(nodePubkey)) {
    throw new Error('node_pubkey must be a compressed secp256k1 public key (66 hex characters)');
  }
  const fundingAddress = String(input.funding_address ?? '').trim();
  if (!CKB_TESTNET_ADDRESS_REGEX.test(fundingAddress)) {
    throw new Error('funding_address must be a valid CKB testnet address (starting with ckt1)');
  }
  return { node_pubkey: nodePubkey, funding_address: fundingAddress };
}

export interface BootstrapDependencies {
  operatorCkbSender?: OperatorCkbSender;
  cchGateway?: CchGateway;
  operatorPrivateKey?: string;
  ckbRpcUrl?: string;
  channelFundingAmount?: string;
}

export async function prepareInboundLiquidity(
  input: BootstrapRequest,
  dependencies?: BootstrapDependencies,
): Promise<BootstrapSession> {
  const validated = validateBootstrapRequest(input);

  const operatorPrivateKey = dependencies?.operatorPrivateKey ?? config.operatorCkbPrivateKey;
  if (!operatorPrivateKey) {
    return {
      session_id: randomUUID(),
      status: 'failed',
      message: 'Scheme B inbound-liquidity provisioning (unpaid CKB capacity gift) is not wired: OPERATOR_CKB_PRIVATE_KEY is not configured and channel funding is not implemented.',
    };
  }

  try {
    const sender =
      dependencies?.operatorCkbSender ??
      new CccOperatorCkbSender(operatorPrivateKey, dependencies?.ckbRpcUrl ?? config.ckbRpcUrl);
    const gateway = dependencies?.cchGateway ?? cchGateway;

    // 1. Submit ≥200 CKB capacity gift to funding_address via CCC SignerCkbPrivateKey (non-blocking)
    const giftResult = await sender.sendCapacityGift(validated.funding_address, 200);

    // 2. Fetch peer address best-effort
    let peerAddress: string | undefined;
    try {
      const nodeInfo = await gateway.getNodeInfo();
      peerAddress = nodeInfo.addresses[0];
    } catch (error) {
      void error;
      // Best-effort; do not fail if getNodeInfo fails
    }

    // 3. Create in-memory session with gift tx hash and provisioning_liquidity status
    const sessionId = randomUUID();
    const session: BootstrapSession = {
      session_id: sessionId,
      status: 'provisioning_liquidity',
      peer_address: peerAddress,
      gift_tx_hash: giftResult.txHash,
      message: `Operator capacity gift submitted (tx: ${giftResult.txHash}). Waiting for CKB confirmation and channel opening.`,
    };

    trimOldest(sessions);
    sessions.set(sessionId, session);

    // 4. Background task: waitTransaction → FNN open_channel → update session (channel_id)
    const rawFundingAmount = dependencies?.channelFundingAmount ?? config.operatorChannelFundingAmount;
    const fundingAmountHex = '0x' + BigInt(rawFundingAmount).toString(16);
    const pubkey = validated.node_pubkey.replace(/^0x/, '');

    const task = (async () => {
      try {
        if (sender.waitForTransaction) {
          await sender.waitForTransaction(giftResult.txHash);
        }
        const openResult = await gateway.openChannel({
          pubkey,
          funding_amount: fundingAmountHex,
          funding_udt_type_script: CWBTC_SCRIPT,
          one_way: true,
          public: false,
        });
        const existing = sessions.get(sessionId);
        if (existing) {
          existing.channel_id = openResult.channel_id;
          existing.status = 'provisioning_liquidity';
          existing.message = `Operator capacity gift confirmed (tx: ${giftResult.txHash}). Channel opening initiated (${openResult.channel_id}). Channel acceptance in progress.`;
        }
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const sanitizedMsg = operatorPrivateKey
          ? rawMsg
              .replaceAll(operatorPrivateKey, '[REDACTED]')
              .replaceAll(operatorPrivateKey.replace(/^0x/, ''), '[REDACTED]')
          : rawMsg;
        const existing = sessions.get(sessionId);
        if (existing) {
          existing.status = 'failed';
          existing.message = `Channel opening failed: ${sanitizedMsg}`;
        }
      }
    })();

    trimOldest(sessionTasks);
    sessionTasks.set(sessionId, task);

    return { ...session };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitizedMsg = operatorPrivateKey
      ? rawMsg
          .replaceAll(operatorPrivateKey, '[REDACTED]')
          .replaceAll(operatorPrivateKey.replace(/^0x/, ''), '[REDACTED]')
      : rawMsg;
    throw new Error(sanitizedMsg);
  }
}
