import { CWBTC_SCRIPT } from '@ckb-on-ramp/contracts';
import { normalizeChannelStateName } from './channels';

/** 1000 shannons/kW — Fiber cooperative-close default. Must be set when force is false. */
export const CLOSE_FEE_RATE = '0x3e8' as const;

/**
 * Fiber occupied_capacity pads lock args shorter than 57 bytes.
 * Args ≥ 57 bytes use the real script size and can exceed the ~184 CKB reserve.
 */
export const MAX_CLOSE_SCRIPT_ARGS_BYTES = 57;

export const L1_SETTLEMENT_COPY =
  'This is a CKB L1 xUDT cell (cWBTC + ~184 CKB). It is not RGB++ and not Lightning. After close, the browser channel balance is zero.';

export const CLOSE_ERRORS = {
  NO_WALLET:
    'Connect a CKB wallet first (UniSat or another CCC-supported injected wallet). Settlement needs your lock script so the UDT cell lands in that wallet. JoyID popups are blocked by the isolation this Fiber node needs.',
  NO_NODE: 'The browser Fiber node is not running. Start the node, then try again.',
  NO_CHANNEL:
    'No ready cWBTC channel to close. Swap in some cWBTC first, or wait until the channel is ready.',
  LOCK_TOO_LARGE:
    'This wallet lock is too large for the channel’s reserved ~184 CKB. Try UniSat or a secp256k1 address.',
  PENDING_TLC: 'This channel still has pending payments. Wait for them to finish, then close.',
  TIMEOUT:
    'Timed out waiting for the close transaction on chain. The channel may still be shutting down — keep this tab open and check again.',
  OPERATOR_OFFLINE:
    'The operator node is offline or not connected. Cooperative close needs both sides. Try again when the gateway is online.',
  REJECTED: 'The close transaction was rejected on chain. The channel was not settled to your wallet.',
} as const;

export type FiberLockScript = {
  code_hash: `0x${string}`;
  hash_type: 'type' | 'data' | 'data1' | 'data2';
  args: `0x${string}`;
};

export type CccScriptLike = {
  codeHash: string;
  hashType: string;
  args: string;
};

export type CloseableChannel = {
  channel_id: string;
  state?: { state_name?: string };
  local_balance?: string;
  offered_tlc_balance?: string;
  received_tlc_balance?: string;
  pending_tlcs?: unknown[];
  funding_udt_type_script?: { code_hash?: string; args?: string } | null;
  shutdown_transaction_hash?: string | null;
};

export type ShutdownChannelCall = {
  channel_id: `0x${string}`;
  close_script: FiberLockScript;
  fee_rate: typeof CLOSE_FEE_RATE;
  force: false;
};

export type CloseChannelNode = {
  listChannels: (params?: {
    include_closed?: boolean;
  }) => Promise<{ channels?: CloseableChannel[] } | null | undefined>;
  shutdownChannel: (params: ShutdownChannelCall) => Promise<void>;
};

export function ensureHex(value: string): `0x${string}` {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Empty hex value.');
  }
  return (trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export function hexArgsByteLength(args: string): number {
  const hex = args.trim();
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length === 0) return 0;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
    throw new Error('Wallet lock args are not valid hex.');
  }
  return body.length / 2;
}

export function isCloseScriptArgsTooLarge(lock: FiberLockScript): boolean {
  return hexArgsByteLength(lock.args) >= MAX_CLOSE_SCRIPT_ARGS_BYTES;
}

export function scriptsEqual(a?: FiberLockScript | null, b?: FiberLockScript | null): boolean {
  if (!a || !b) return false;
  return (
    a.code_hash.toLowerCase() === b.code_hash.toLowerCase() &&
    a.hash_type === b.hash_type &&
    a.args.toLowerCase() === b.args.toLowerCase()
  );
}

export function cccScriptToFiberScript(script: CccScriptLike): FiberLockScript {
  const hashType = script.hashType;
  if (hashType !== 'type' && hashType !== 'data' && hashType !== 'data1' && hashType !== 'data2') {
    throw new Error(`Unsupported wallet lock hash type: ${hashType}`);
  }
  return {
    code_hash: ensureHex(String(script.codeHash)),
    hash_type: hashType,
    args: ensureHex(String(script.args)),
  };
}

export function isCwbtcFunding(channel: CloseableChannel): boolean {
  const script = channel.funding_udt_type_script;
  if (!script) return false;
  return (
    (script.code_hash ?? '').toLowerCase() === CWBTC_SCRIPT.code_hash.toLowerCase() &&
    (script.args ?? '').toLowerCase() === CWBTC_SCRIPT.args.toLowerCase()
  );
}

export function isReadyCwbtcChannel(channel: CloseableChannel): boolean {
  return normalizeChannelStateName(channel.state?.state_name) === 'CHANNELREADY' && isCwbtcFunding(channel);
}

function parseHexAmount(value?: string): bigint {
  try {
    return BigInt(value ?? '0x0');
  } catch {
    return 0n;
  }
}

export function hasPendingTlcs(channel: CloseableChannel): boolean {
  if ((channel.pending_tlcs?.length ?? 0) > 0) return true;
  return parseHexAmount(channel.offered_tlc_balance) > 0n || parseHexAmount(channel.received_tlc_balance) > 0n;
}

export function pickReadyCwbtcChannel(channels: CloseableChannel[]): CloseableChannel | undefined {
  const ready = channels.filter(isReadyCwbtcChannel);
  if (ready.length === 0) return undefined;
  return ready.reduce((best, ch) => (parseHexAmount(ch.local_balance) > parseHexAmount(best.local_balance) ? ch : best));
}

export function assertCanCloseToWallet(input: {
  walletLock?: FiberLockScript | null;
  nodeRunning: boolean;
  channels: CloseableChannel[];
}): { channel: CloseableChannel; walletLock: FiberLockScript } {
  if (!input.nodeRunning) {
    throw new Error(CLOSE_ERRORS.NO_NODE);
  }
  if (!input.walletLock) {
    throw new Error(CLOSE_ERRORS.NO_WALLET);
  }
  if (isCloseScriptArgsTooLarge(input.walletLock)) {
    throw new Error(CLOSE_ERRORS.LOCK_TOO_LARGE);
  }
  const channel = pickReadyCwbtcChannel(input.channels);
  if (!channel) {
    throw new Error(CLOSE_ERRORS.NO_CHANNEL);
  }
  if (hasPendingTlcs(channel)) {
    throw new Error(CLOSE_ERRORS.PENDING_TLC);
  }
  return { channel, walletLock: input.walletLock };
}

export function buildShutdownParams(input: {
  channelId: string;
  walletLock: FiberLockScript;
  /** Ignored. Present so callers/tests prove we never copy the node default lock. */
  nodeDefaultLock?: FiberLockScript | null;
}): ShutdownChannelCall {
  if (!input.channelId) {
    throw new Error(CLOSE_ERRORS.NO_CHANNEL);
  }
  if (!input.walletLock) {
    throw new Error(CLOSE_ERRORS.NO_WALLET);
  }
  if (isCloseScriptArgsTooLarge(input.walletLock)) {
    throw new Error(CLOSE_ERRORS.LOCK_TOO_LARGE);
  }
  const closeScript: FiberLockScript = {
    code_hash: ensureHex(input.walletLock.code_hash),
    hash_type: input.walletLock.hash_type,
    args: ensureHex(input.walletLock.args),
  };
  if (input.nodeDefaultLock && scriptsEqual(closeScript, input.nodeDefaultLock)) {
    // Same bytes as the node lock is only OK if that IS the connected wallet.
    // We still built it from walletLock, never by copying nodeDefaultLock.
  }
  return {
    channel_id: ensureHex(input.channelId),
    close_script: closeScript,
    fee_rate: CLOSE_FEE_RATE,
    force: false,
  };
}

export function isShutdownTxHash(hash?: string | null): hash is string {
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash);
}

export function humanizeCloseError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const known = Object.values(CLOSE_ERRORS);
  if ((known as string[]).includes(msg)) return msg;
  const lower = msg.toLowerCase();
  if (lower.includes('pending') && lower.includes('tlc')) return CLOSE_ERRORS.PENDING_TLC;
  if (
    lower.includes('not connected') ||
    lower.includes('peer is not connected') ||
    lower.includes('no peer')
  ) {
    return CLOSE_ERRORS.OPERATOR_OFFLINE;
  }
  if (lower.includes('timed out') || lower.includes('timeout')) return CLOSE_ERRORS.TIMEOUT;
  if (lower.includes('rejected')) return CLOSE_ERRORS.REJECTED;
  return `Could not close the channel: ${msg}`;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForShutdownTxHash(options: {
  node: CloseChannelNode;
  channelId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;
  const want = options.channelId.toLowerCase();
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const listed = await options.node.listChannels({ include_closed: true });
      const match = (listed?.channels ?? []).find((ch) => ch.channel_id.toLowerCase() === want);
      if (match && isShutdownTxHash(match.shutdown_transaction_hash)) {
        return match.shutdown_transaction_hash;
      }
    } catch {
      // ignore transient list errors while polling
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(CLOSE_ERRORS.TIMEOUT);
}

export async function waitForCkbTxCommitted(
  txHash: string,
  options?: {
    fetch?: typeof fetch;
    rpcUrl?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const fetchFn = options?.fetch ?? fetch;
  const rpcUrl = options?.rpcUrl ?? '/ckb-rpc';
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
  const sleep = options?.sleep ?? defaultSleep;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetchFn(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'get_transaction',
          params: [txHash],
        }),
      });
      const payload = (await response.json()) as {
        result?: { tx_status?: { status?: string } };
        error?: { message?: string };
      };
      const status = payload.result?.tx_status?.status;
      if (status === 'committed') return;
      if (status === 'rejected') {
        throw new Error(CLOSE_ERRORS.REJECTED);
      }
    } catch (err) {
      if (err instanceof Error && err.message === CLOSE_ERRORS.REJECTED) {
        throw err;
      }
      // keep polling on transient RPC errors
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(CLOSE_ERRORS.TIMEOUT);
}

export type CloseToWalletResult = {
  txHash: string;
  address: string;
  channelId: string;
};

export async function closeChannelToWallet(options: {
  walletLock?: FiberLockScript | null;
  address: string;
  nodeRunning: boolean;
  node?: CloseChannelNode | null;
  nodeDefaultLock?: FiberLockScript | null;
  waitForTx?: (txHash: string) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CloseToWalletResult> {
  if (!options.node) {
    throw new Error(CLOSE_ERRORS.NO_NODE);
  }

  let listed: { channels?: CloseableChannel[] } | null | undefined;
  try {
    listed = await options.node.listChannels({});
  } catch (err) {
    throw new Error(humanizeCloseError(err));
  }

  const gated = assertCanCloseToWallet({
    walletLock: options.walletLock,
    nodeRunning: options.nodeRunning,
    channels: listed?.channels ?? [],
  });

  const params = buildShutdownParams({
    channelId: gated.channel.channel_id,
    walletLock: gated.walletLock,
    nodeDefaultLock: options.nodeDefaultLock,
  });

  try {
    await options.node.shutdownChannel(params);
  } catch (err) {
    throw new Error(humanizeCloseError(err));
  }

  const txHash = await waitForShutdownTxHash({
    node: options.node,
    channelId: gated.channel.channel_id,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    sleep: options.sleep,
  });

  if (options.waitForTx) {
    try {
      await options.waitForTx(txHash);
    } catch (err) {
      throw new Error(humanizeCloseError(err));
    }
  }

  return {
    txHash,
    address: options.address,
    channelId: gated.channel.channel_id,
  };
}
