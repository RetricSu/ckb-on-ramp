import { CWBTC_SCRIPT } from '@ckb-on-ramp/contracts';
import { formatCwbtc, toHex } from './amount';
import { pickReadyCwbtcChannel, type CloseableChannel } from './closeToWallet';

export const SPEND_COPY =
  'Paste a testnet Fiber invoice (fibt…). This pays cWBTC from this browser channel. The channel stays open, so you can still withdraw to CKB L1 after. You usually only have a hop to the operator — if the invoice cannot be routed there, payment fails.';

export const SPEND_ERRORS = {
  EMPTY: 'Paste a Fiber invoice first. It should start with fibt.',
  UNDECODED:
    'Could not read that invoice. Paste a full testnet Fiber invoice starting with fibt.',
  MAINNET: 'That is a mainnet Fiber invoice. This app only pays testnet cWBTC invoices (fibt).',
  NOT_TESTNET: 'That invoice is not a testnet Fiber invoice. Paste one that starts with fibt.',
  NOT_CWBTC: 'This invoice is not for cWBTC. This channel can only pay cWBTC.',
  NO_AMOUNT: 'This invoice has no amount. Paste a fibt invoice that already says how much cWBTC to pay.',
  NO_NODE: 'The browser Fiber node is not running. Start the node, then try again.',
  NO_CHANNEL: 'No ready cWBTC channel to pay from. Swap in some cWBTC first.',
  INSUFFICIENT: 'Not enough cWBTC in the channel to pay this invoice (including fees).',
  UNREACHABLE:
    'Could not reach the other party. You usually only have a channel to the operator — if the invoice is not payable through that hop, payment fails.',
  FAILED: 'Payment failed. The channel is still open.',
  TIMEOUT:
    'Timed out waiting for the payment to finish. The channel is still open — check the invoice and try again if needed.',
} as const;

const HASH_TYPE_BY_BYTE: Record<number, string> = {
  0: 'data',
  1: 'type',
  2: 'data1',
  4: 'data2',
};

export type SpendInvoice = {
  currency?: string;
  amount?: string;
  data?: {
    payment_hash?: string;
    attrs?: Array<Record<string, unknown>>;
  };
};

export type SpendPayment = {
  payment_hash: string;
  status?: string;
  fee?: string;
  failed_error?: string;
};

export type SpendNode = {
  parseInvoice: (params: { invoice: string }) => Promise<{ invoice?: SpendInvoice } | null | undefined>;
  listChannels: (params?: {
    include_closed?: boolean;
  }) => Promise<{ channels?: CloseableChannel[] } | null | undefined>;
  sendPayment: (params: {
    invoice: string;
    max_fee_amount?: `0x${string}`;
    dry_run?: boolean;
  }) => Promise<SpendPayment>;
  getPayment: (params: { payment_hash: `0x${string}` }) => Promise<SpendPayment | null | undefined>;
};

export type SpendPreview = {
  invoice: string;
  amountRaw: bigint;
  amountLabel: string;
  paymentHash: string;
  currency: 'Fibt';
  channelId: string;
  localBalanceRaw: bigint;
  maxFeeRaw: bigint;
};

export type SpendResult = {
  paymentHash: string;
  amountRaw: bigint;
  feeRaw: bigint;
  channelId: string;
};

export function normalizeInvoice(raw: string): string {
  return raw.trim();
}

export function invoicePrefix(raw: string): string {
  const lower = normalizeInvoice(raw).toLowerCase();
  if (lower.startsWith('fibb')) return 'fibb';
  if (lower.startsWith('fibt')) return 'fibt';
  if (lower.startsWith('fibd')) return 'fibd';
  return '';
}

export function assertInvoiceShape(raw: string): string {
  const invoice = normalizeInvoice(raw);
  if (!invoice) {
    throw new Error(SPEND_ERRORS.EMPTY);
  }
  const prefix = invoicePrefix(invoice);
  if (prefix === 'fibb') {
    throw new Error(SPEND_ERRORS.MAINNET);
  }
  if (prefix === 'fibd') {
    throw new Error(SPEND_ERRORS.NOT_TESTNET);
  }
  if (prefix !== 'fibt' || invoice.length < 20) {
    throw new Error(SPEND_ERRORS.UNDECODED);
  }
  return invoice;
}

function readU32LE(hexBody: string, byteOffset: number): number {
  const i = byteOffset * 2;
  const slice = hexBody.slice(i, i + 8);
  if (slice.length !== 8) {
    throw new Error('short');
  }
  const b0 = Number.parseInt(slice.slice(0, 2), 16);
  const b1 = Number.parseInt(slice.slice(2, 4), 16);
  const b2 = Number.parseInt(slice.slice(4, 6), 16);
  const b3 = Number.parseInt(slice.slice(6, 8), 16);
  if ([b0, b1, b2, b3].some((b) => Number.isNaN(b))) {
    throw new Error('nan');
  }
  return b0 + b1 * 256 + b2 * 65536 + b3 * 16777216;
}

export function decodeMoleculeScript(hex: string): {
  code_hash: `0x${string}`;
  hash_type: string;
  args: `0x${string}`;
} | null {
  try {
    const body = (hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex).toLowerCase();
    if (!/^[0-9a-f]*$/.test(body) || body.length % 2 !== 0) return null;
    const total = body.length / 2;
    if (total < 16 + 32 + 1 + 4) return null;
    const codeHashOffset = readU32LE(body, 4);
    const hashTypeOffset = readU32LE(body, 8);
    const argsOffset = readU32LE(body, 12);
    if (codeHashOffset + 32 > total || hashTypeOffset + 1 > total || argsOffset + 4 > total) return null;
    const code_hash = `0x${body.slice(codeHashOffset * 2, (codeHashOffset + 32) * 2)}` as `0x${string}`;
    const hashTypeByte = Number.parseInt(body.slice(hashTypeOffset * 2, hashTypeOffset * 2 + 2), 16);
    const hash_type = HASH_TYPE_BY_BYTE[hashTypeByte];
    if (!hash_type) return null;
    const argsLen = readU32LE(body, argsOffset);
    if (argsOffset + 4 + argsLen > total) return null;
    const args = `0x${body.slice((argsOffset + 4) * 2, (argsOffset + 4 + argsLen) * 2)}` as `0x${string}`;
    return { code_hash, hash_type, args };
  } catch {
    return null;
  }
}

function extractUdtAttr(invoice?: SpendInvoice | null): unknown {
  for (const attr of invoice?.data?.attrs ?? []) {
    if (attr && typeof attr === 'object' && 'udt_script' in attr) {
      return attr.udt_script;
    }
  }
  return undefined;
}

function scriptFieldsEqual(
  script: { code_hash?: string; args?: string },
): boolean {
  return (
    (script.code_hash ?? '').toLowerCase() === CWBTC_SCRIPT.code_hash.toLowerCase() &&
    (script.args ?? '').toLowerCase() === CWBTC_SCRIPT.args.toLowerCase()
  );
}

export function isCwbtcInvoiceUdt(udt: unknown): boolean {
  if (udt == null) return false;
  if (typeof udt === 'object') {
    return scriptFieldsEqual(udt as { code_hash?: string; args?: string });
  }
  if (typeof udt !== 'string' || !udt.trim()) return false;
  const decoded = decodeMoleculeScript(udt);
  return decoded ? scriptFieldsEqual(decoded) : false;
}

function parseHexAmount(value?: string): bigint {
  try {
    return BigInt(value ?? '0x0');
  } catch {
    return 0n;
  }
}

function paymentStatus(value?: string): 'success' | 'failed' | 'pending' {
  const status = (value ?? '').replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (status === 'success') return 'success';
  if (status === 'failed') return 'failed';
  return 'pending';
}

export function assertCanSpendInvoice(input: {
  nodeRunning: boolean;
  invoice?: SpendInvoice | null;
  channels: CloseableChannel[];
}): { amountRaw: bigint; channel: CloseableChannel; paymentHash: string; maxFeeRaw: bigint } {
  if (!input.nodeRunning) {
    throw new Error(SPEND_ERRORS.NO_NODE);
  }
  const parsed = input.invoice;
  if (!parsed) {
    throw new Error(SPEND_ERRORS.UNDECODED);
  }
  const currency = (parsed.currency ?? '').trim();
  if (currency === 'Fibb') {
    throw new Error(SPEND_ERRORS.MAINNET);
  }
  if (currency && currency !== 'Fibt') {
    throw new Error(SPEND_ERRORS.NOT_TESTNET);
  }
  if (!currency) {
    throw new Error(SPEND_ERRORS.UNDECODED);
  }
  if (!isCwbtcInvoiceUdt(extractUdtAttr(parsed))) {
    throw new Error(SPEND_ERRORS.NOT_CWBTC);
  }
  const amountRaw = parseHexAmount(parsed.amount);
  if (amountRaw <= 0n) {
    throw new Error(SPEND_ERRORS.NO_AMOUNT);
  }
  const channel = pickReadyCwbtcChannel(input.channels);
  if (!channel) {
    throw new Error(SPEND_ERRORS.NO_CHANNEL);
  }
  const localBalanceRaw = parseHexAmount(channel.local_balance);
  if (amountRaw > localBalanceRaw) {
    throw new Error(SPEND_ERRORS.INSUFFICIENT);
  }
  const paymentHash = parsed.data?.payment_hash ?? '';
  return {
    amountRaw,
    channel,
    paymentHash,
    maxFeeRaw: localBalanceRaw - amountRaw,
  };
}

export function humanizeSpendError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const known = Object.values(SPEND_ERRORS);
  if ((known as string[]).includes(msg)) return msg;
  const lower = msg.toLowerCase();
  if (
    lower.includes('insufficient') ||
    lower.includes('not enough') ||
    (lower.includes('balance') && (lower.includes('low') || lower.includes('exceed')))
  ) {
    return SPEND_ERRORS.INSUFFICIENT;
  }
  if (lower.includes('udt') || lower.includes('cwbtc')) {
    return SPEND_ERRORS.NOT_CWBTC;
  }
  if (
    lower.includes('not connected') ||
    lower.includes('peer is not connected') ||
    lower.includes('no peer') ||
    lower.includes('no route') ||
    lower.includes('no path') ||
    lower.includes('unreachable') ||
    lower.includes('failed to build route') ||
    lower.includes('build_route') ||
    lower.includes('build route')
  ) {
    return SPEND_ERRORS.UNREACHABLE;
  }
  if (lower.includes('no channel') || lower.includes('channel not')) {
    return SPEND_ERRORS.NO_CHANNEL;
  }
  if (lower.includes('invalid invoice') || lower.includes('parse') || lower.includes('decode') || lower.includes('bech32')) {
    return SPEND_ERRORS.UNDECODED;
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return SPEND_ERRORS.TIMEOUT;
  }
  return `Could not pay this invoice: ${msg}`;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForSpendPayment(options: {
  node: SpendNode;
  paymentHash: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SpendPayment> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;
  const paymentHash = (
    options.paymentHash.startsWith('0x') ? options.paymentHash : `0x${options.paymentHash}`
  ) as `0x${string}`;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    let payment: SpendPayment | null | undefined;
    try {
      payment = await options.node.getPayment({ payment_hash: paymentHash });
    } catch {
      payment = undefined;
    }
    const status = paymentStatus(payment?.status);
    if (status === 'success' && payment) {
      return payment;
    }
    if (status === 'failed') {
      throw new Error(humanizeSpendError(new Error(payment?.failed_error || SPEND_ERRORS.FAILED)));
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(SPEND_ERRORS.TIMEOUT);
}

async function loadSpendPreview(options: {
  invoice: string;
  nodeRunning: boolean;
  node?: SpendNode | null;
}): Promise<SpendPreview> {
  const invoice = assertInvoiceShape(options.invoice);
  if (!options.nodeRunning || !options.node) {
    throw new Error(SPEND_ERRORS.NO_NODE);
  }

  let parsed: SpendInvoice | undefined;
  try {
    const result = await options.node.parseInvoice({ invoice });
    parsed = result?.invoice;
  } catch (err) {
    throw new Error(humanizeSpendError(err));
  }
  if (!parsed) {
    throw new Error(SPEND_ERRORS.UNDECODED);
  }

  let listed: { channels?: CloseableChannel[] } | null | undefined;
  try {
    listed = await options.node.listChannels({});
  } catch (err) {
    throw new Error(humanizeSpendError(err));
  }

  const gated = assertCanSpendInvoice({
    nodeRunning: options.nodeRunning,
    invoice: parsed,
    channels: listed?.channels ?? [],
  });

  return {
    invoice,
    amountRaw: gated.amountRaw,
    amountLabel: formatCwbtc(gated.amountRaw.toString()),
    paymentHash: gated.paymentHash,
    currency: 'Fibt',
    channelId: gated.channel.channel_id,
    localBalanceRaw: parseHexAmount(gated.channel.local_balance),
    maxFeeRaw: gated.maxFeeRaw,
  };
}

export async function previewSpendInvoice(options: {
  invoice: string;
  nodeRunning: boolean;
  node?: SpendNode | null;
}): Promise<SpendPreview> {
  return loadSpendPreview(options);
}

export async function spendOnFiberInvoice(options: {
  invoice: string;
  nodeRunning: boolean;
  node?: SpendNode | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SpendResult> {
  if (!options.node) {
    throw new Error(SPEND_ERRORS.NO_NODE);
  }

  const preview = await loadSpendPreview({
    invoice: options.invoice,
    nodeRunning: options.nodeRunning,
    node: options.node,
  });

  let sent: SpendPayment;
  try {
    sent = await options.node.sendPayment({
      invoice: preview.invoice,
      max_fee_amount: toHex(preview.maxFeeRaw),
    });
  } catch (err) {
    throw new Error(humanizeSpendError(err));
  }

  const initial = paymentStatus(sent.status);
  let finished: SpendPayment = sent;
  if (initial === 'failed') {
    throw new Error(humanizeSpendError(new Error(sent.failed_error || SPEND_ERRORS.FAILED)));
  }
  if (initial !== 'success') {
    finished = await waitForSpendPayment({
      node: options.node,
      paymentHash: sent.payment_hash || preview.paymentHash,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      sleep: options.sleep,
    });
  }

  return {
    paymentHash: finished.payment_hash || sent.payment_hash || preview.paymentHash,
    amountRaw: preview.amountRaw,
    feeRaw: parseHexAmount(finished.fee ?? sent.fee),
    channelId: preview.channelId,
  };
}
