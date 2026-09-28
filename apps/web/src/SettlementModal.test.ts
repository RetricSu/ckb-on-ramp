import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettlementModal } from './components/SettlementModal.js';

Object.assign(globalThis, { React });

test('shows the wallet-first payment path while keeping lncli collapsed', () => {
  const swap = {
    order: {
      status: 'Pending',
      pay_sats: 10_000,
      lightning_invoice: 'lnbc100u1walletfirst',
      created_at: '2026-09-28T08:00:00.000Z',
    },
    isSettlementOpen: true,
    setIsSettlementOpen: () => undefined,
    setIsHistoryOpen: () => undefined,
    resetSwap: () => undefined,
    refreshBalance: () => undefined,
  } as unknown as ComponentProps<typeof SettlementModal>['swap'];

  const html = renderToStaticMarkup(React.createElement(SettlementModal, { swap }));

  assert.match(html, /Phoenix, Zeus, Blink, Cash App/);
  assert.match(html, /Copy Invoice/);
  assert.match(html, /href="lightning:lnbc100u1walletfirst"/);
  assert.match(html, /On-chain BTC cannot pay this invoice/);
  assert.match(html, /Advanced: pay from a node/);
  assert.doesNotMatch(html, /lncli/);
});
