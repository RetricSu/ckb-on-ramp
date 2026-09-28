import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CWBTC_SCRIPT } from '@ckb-on-ramp/contracts';
import { serializeUdtTypeScript } from '@fiber-pay/sdk/browser';
import type { CloseableChannel } from './closeToWallet.js';
import {
  SPEND_COPY,
  SPEND_ERRORS,
  assertCanSpendInvoice,
  assertInvoiceShape,
  decodeMoleculeScript,
  humanizeSpendError,
  isCwbtcInvoiceUdt,
  previewSpendInvoice,
  spendOnFiberInvoice,
  type SpendInvoice,
  type SpendNode,
  type SpendPayment,
} from './spendOnFiber.js';

const CHANNEL_ID = '0x60e1bb6f3c2618eadcaec013fabc1a29eadd9a17ef369bd273baedfea66817c7';
const PAYMENT_HASH = '0x' + 'ab'.repeat(32);
const FIBT_INVOICE =
  'fibt10000001p902j3k6qenczxzat8lhv0shw9pctksul3vvrfe9avxheunkstyqlxf9rpfxdyzyxjd3uq3nadqpl2tjdsf9dl7c27p2sghmrycwyt5p0hywfdjvgdsmtlhsghqyxtkq0xn3s7lzfyrv2v0q8twny2k759sas4rc0yjxplzl38vgk0jq7kfav9fxtvndmxqdzeu2mcsyedf7s9nrsks76wgrrd4kvm5qt63cgpsj6nkqhvu0t5zt6ps9xszhdr8aup04sc870ypft098ur6hu83yntqrmcupyt075vnxqrgsln36vvtw2yeky0x5pmep9zeh8qds493khsqu86mud8y98xqq7jekx82xsunlwue9n2kvjezlj3g8aut85sh2rujke9s87w6uqu7mtxlhpn2g40z8w47e89hj8q7p9wmfggr0r5nszwquakdpygsq58kkswasrn5j6vad3h6h3898twej8jv7kf2y3lc0fxhzpzcv9w9cpuxhzd9';

const CWBTC_UDT_HEX = serializeUdtTypeScript(CWBTC_SCRIPT);

function cwbtcInvoice(overrides: Partial<SpendInvoice> = {}): SpendInvoice {
  return {
    currency: 'Fibt',
    amount: '0xf4240',
    data: {
      payment_hash: PAYMENT_HASH,
      attrs: [{ udt_script: CWBTC_UDT_HEX }],
    },
    ...overrides,
  };
}

function readyChannel(overrides: Partial<CloseableChannel> = {}): CloseableChannel {
  return {
    channel_id: CHANNEL_ID,
    state: { state_name: 'ChannelReady' },
    local_balance: '0x5f5e100',
    offered_tlc_balance: '0x0',
    received_tlc_balance: '0x0',
    pending_tlcs: [],
    funding_udt_type_script: {
      code_hash: CWBTC_SCRIPT.code_hash,
      args: CWBTC_SCRIPT.args,
    },
    shutdown_transaction_hash: null,
    ...overrides,
  };
}

function mockNode(options?: {
  invoice?: SpendInvoice;
  parseError?: Error;
  channels?: CloseableChannel[];
  send?: SpendPayment;
  payments?: SpendPayment[];
  onSend?: (params: { invoice: string; max_fee_amount?: `0x${string}`; dry_run?: boolean }) => void;
  onShutdown?: () => void;
}): SpendNode & { shutdownCalls: number; sendCalls: number } {
  const payments = [...(options?.payments ?? [])];
  const state = { shutdownCalls: 0, sendCalls: 0 };
  const node: SpendNode & { shutdownCalls: number; sendCalls: number; shutdownChannel?: () => Promise<void> } = {
    get shutdownCalls() {
      return state.shutdownCalls;
    },
    get sendCalls() {
      return state.sendCalls;
    },
    parseInvoice: async () => {
      if (options?.parseError) throw options.parseError;
      return { invoice: options?.invoice ?? cwbtcInvoice() };
    },
    listChannels: async () => ({ channels: options?.channels ?? [readyChannel()] }),
    sendPayment: async (params) => {
      state.sendCalls += 1;
      options?.onSend?.(params);
      return options?.send ?? { payment_hash: PAYMENT_HASH, status: 'Created', fee: '0x0' };
    },
    getPayment: async () => {
      return payments.shift() ?? { payment_hash: PAYMENT_HASH, status: 'Success', fee: '0x0' };
    },
    shutdownChannel: async () => {
      state.shutdownCalls += 1;
      options?.onShutdown?.();
    },
  };
  return node;
}

describe('spendOnFiber', () => {
  describe('assertInvoiceShape', () => {
    it('rejects an empty invoice as undecoded', () => {
      assert.throws(() => assertInvoiceShape(''), { message: SPEND_ERRORS.EMPTY });
      assert.throws(() => assertInvoiceShape('   '), { message: SPEND_ERRORS.EMPTY });
    });

    it('rejects undecodable text', () => {
      assert.throws(() => assertInvoiceShape('not-an-invoice'), { message: SPEND_ERRORS.UNDECODED });
      assert.throws(() => assertInvoiceShape('lnbc1garbage'), { message: SPEND_ERRORS.UNDECODED });
    });

    it('rejects mainnet fibb invoices', () => {
      assert.throws(() => assertInvoiceShape('fibb1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'), {
        message: SPEND_ERRORS.MAINNET,
      });
    });
  });

  describe('isCwbtcInvoiceUdt', () => {
    it('accepts molecule-serialized cWBTC and rejects other UDT', () => {
      const decoded = decodeMoleculeScript(CWBTC_UDT_HEX);
      assert.ok(decoded);
      assert.equal(decoded.code_hash.toLowerCase(), CWBTC_SCRIPT.code_hash.toLowerCase());
      assert.equal(isCwbtcInvoiceUdt(CWBTC_UDT_HEX), true);
      assert.equal(isCwbtcInvoiceUdt({ code_hash: CWBTC_SCRIPT.code_hash, args: CWBTC_SCRIPT.args }), true);
      assert.equal(
        isCwbtcInvoiceUdt(serializeUdtTypeScript({ ...CWBTC_SCRIPT, args: '0x00' })),
        false,
      );
      assert.equal(isCwbtcInvoiceUdt(undefined), false);
    });
  });

  describe('assertCanSpendInvoice', () => {
    it('rejects when the Fiber node is not running', () => {
      assert.throws(
        () =>
          assertCanSpendInvoice({
            nodeRunning: false,
            invoice: cwbtcInvoice(),
            channels: [readyChannel()],
          }),
        { message: SPEND_ERRORS.NO_NODE },
      );
    });

    it('rejects a non-cWBTC invoice', () => {
      assert.throws(
        () =>
          assertCanSpendInvoice({
            nodeRunning: true,
            invoice: cwbtcInvoice({
              data: { payment_hash: PAYMENT_HASH, attrs: [{ udt_script: serializeUdtTypeScript({ ...CWBTC_SCRIPT, args: '0x00' }) }] },
            }),
            channels: [readyChannel()],
          }),
        { message: SPEND_ERRORS.NOT_CWBTC },
      );
    });

    it('rejects a CKB invoice with no UDT', () => {
      assert.throws(
        () =>
          assertCanSpendInvoice({
            nodeRunning: true,
            invoice: cwbtcInvoice({ data: { payment_hash: PAYMENT_HASH, attrs: [] } }),
            channels: [readyChannel()],
          }),
        { message: SPEND_ERRORS.NOT_CWBTC },
      );
    });

    it('rejects when the amount is greater than channel local_balance', () => {
      assert.throws(
        () =>
          assertCanSpendInvoice({
            nodeRunning: true,
            invoice: cwbtcInvoice({ amount: '0x5f5e101' }),
            channels: [readyChannel({ local_balance: '0x5f5e100' })],
          }),
        { message: SPEND_ERRORS.INSUFFICIENT },
      );
    });
  });

  describe('previewSpendInvoice / spendOnFiberInvoice', () => {
    it('rejects an undecoded invoice without calling sendPayment', async () => {
      const node = mockNode({ parseError: new Error('Invalid invoice') });
      await assert.rejects(
        () =>
          spendOnFiberInvoice({
            invoice: FIBT_INVOICE,
            nodeRunning: true,
            node,
          }),
        { message: SPEND_ERRORS.UNDECODED },
      );
      assert.equal(node.sendCalls, 0);
      assert.equal(node.shutdownCalls, 0);
    });

    it('rejects a non-cWBTC invoice without calling sendPayment', async () => {
      const node = mockNode({
        invoice: cwbtcInvoice({
          data: {
            payment_hash: PAYMENT_HASH,
            attrs: [{ udt_script: serializeUdtTypeScript({ ...CWBTC_SCRIPT, args: '0x11' }) }],
          },
        }),
      });
      await assert.rejects(
        () => spendOnFiberInvoice({ invoice: FIBT_INVOICE, nodeRunning: true, node }),
        { message: SPEND_ERRORS.NOT_CWBTC },
      );
      assert.equal(node.sendCalls, 0);
    });

    it('rejects when channel local_balance is below the invoice amount', async () => {
      const node = mockNode({
        channels: [readyChannel({ local_balance: '0x1' })],
      });
      await assert.rejects(
        () => spendOnFiberInvoice({ invoice: FIBT_INVOICE, nodeRunning: true, node }),
        { message: SPEND_ERRORS.INSUFFICIENT },
      );
      assert.equal(node.sendCalls, 0);
    });

    it('rejects when the node is not running and does not send or close', async () => {
      const node = mockNode();
      await assert.rejects(
        () => spendOnFiberInvoice({ invoice: FIBT_INVOICE, nodeRunning: false, node }),
        { message: SPEND_ERRORS.NO_NODE },
      );
      assert.equal(node.sendCalls, 0);
      assert.equal(node.shutdownCalls, 0);
    });

    it('calls sendPayment on success and does not close the channel', async () => {
      const sent: Array<{ invoice: string; max_fee_amount?: `0x${string}`; dry_run?: boolean }> = [];
      const node = mockNode({
        onSend: (params) => sent.push(params),
        send: { payment_hash: PAYMENT_HASH, status: 'Created', fee: '0x0' },
        payments: [{ payment_hash: PAYMENT_HASH, status: 'Success', fee: '0x0' }],
      });

      const result = await spendOnFiberInvoice({
        invoice: FIBT_INVOICE,
        nodeRunning: true,
        node,
        sleep: async () => {},
        pollIntervalMs: 1,
      });

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.invoice, FIBT_INVOICE);
      assert.equal(sent[0]?.dry_run, undefined);
      assert.equal(node.sendCalls, 1);
      assert.equal(node.shutdownCalls, 0);
      assert.equal(result.paymentHash, PAYMENT_HASH);
      assert.equal(result.channelId, CHANNEL_ID);
      assert.equal(result.amountRaw, 0xf4240n);

      const preview = await previewSpendInvoice({
        invoice: FIBT_INVOICE,
        nodeRunning: true,
        node,
      });
      assert.equal(preview.currency, 'Fibt');
      assert.equal(preview.amountLabel.length > 0, true);
    });
  });

  describe('copy', () => {
    it('says the channel stays open and does not pretend to route the whole network', () => {
      assert.match(SPEND_COPY, /channel stays open/i);
      assert.match(SPEND_COPY, /operator/);
      assert.match(SPEND_COPY, /fibt/);
    });
  });

  describe('humanizeSpendError', () => {
    it('maps no-route / peer-down to unreachable copy', () => {
      assert.equal(humanizeSpendError(new Error('Failed to build route')), SPEND_ERRORS.UNREACHABLE);
      assert.equal(humanizeSpendError(new Error('peer is not connected')), SPEND_ERRORS.UNREACHABLE);
    });
  });
});
