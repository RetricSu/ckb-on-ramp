import { Router } from 'express';
import type { CreateOrderRequest, Quote, QuoteRequest } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';
import { prepareInboundLiquidity } from '../services/bootstrap.js';
import { CchRpcError, cchGateway } from '../services/cch.js';
import { createQuote } from '../services/quote.js';

const router = Router();
const quotes = new Map<string, Quote>();
const idempotency = new Map<string, { paymentHash: string; fingerprint: string; createdAt: number }>();
const MAX_TRANSIENT_RECORDS = 1_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const trimOldest = <K, V>(map: Map<K, V>) => {
  while (map.size >= MAX_TRANSIENT_RECORDS) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
};
router.get('/health', async (_req, res) => {
  const fnnReachable = await cchGateway.health();
  res.json({ ok: config.mode === 'mock' || fnnReachable, mode: config.mode === 'mock' ? 'mock' : 'testnet', fnn_reachable: fnnReachable });
});
router.post('/bootstrap', async (req, res) => {
  try {
    const session = await prepareInboundLiquidity(String(req.body?.node_pubkey ?? ''));
    res.status(session.status === 'failed' ? 501 : 201).json(session);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.post('/quotes', (req, res) => {
  try {
    const quote = createQuote(String((req.body as QuoteRequest | undefined)?.receive_raw ?? ''));
    for (const [id, candidate] of quotes) if (Date.parse(candidate.expires_at) <= Date.now()) quotes.delete(id);
    trimOldest(quotes);
    quotes.set(quote.quote_id, quote); res.status(201).json(quote);
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
router.post('/orders', async (req, res, next) => {
  try {
    const input = req.body as Partial<CreateOrderRequest>;
    const key = req.header('Idempotency-Key');
    if (!key) { res.status(400).json({ error: 'Idempotency-Key header is required' }); return; }
    if (!input.fiber_invoice || !/^fib[a-z0-9]+$/i.test(input.fiber_invoice)) { res.status(400).json({ error: 'fiber_invoice is missing or invalid' }); return; }
    if (!input.quote_id) { res.status(400).json({ error: 'quote_id is required' }); return; }
    const fingerprint = `${input.quote_id}:${input.fiber_invoice}`;
    const replay = idempotency.get(key);
    if (replay && Date.now() - replay.createdAt <= IDEMPOTENCY_TTL_MS) {
      if (replay.fingerprint !== fingerprint) { res.status(409).json({ error: 'Idempotency-Key was already used for a different request' }); return; }
      const existing = await cchGateway.getOrder(replay.paymentHash);
      if (existing) { res.json(existing); return; }
    } else if (replay) idempotency.delete(key);
    const quote = quotes.get(input.quote_id);
    if (!quote || Date.parse(quote.expires_at) <= Date.now()) { res.status(410).json({ error: 'Quote is missing or expired. Request a new quote.' }); return; }
    const order = await cchGateway.createOrder(input as CreateOrderRequest, quote);
    trimOldest(idempotency);
    idempotency.set(key, { paymentHash: order.payment_hash, fingerprint, createdAt: Date.now() }); res.status(201).json(order);
  } catch (error) {
    if (error instanceof CchRpcError) { res.status(400).json({ error: error.message, upstream: true }); return; }
    next(error);
  }
});
router.get('/orders/:paymentHash', async (req, res, next) => {
  try {
    const order = await cchGateway.getOrder(req.params.paymentHash);
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    res.json(order);
  } catch (error) {
    if (error instanceof CchRpcError) {
      const status = error.message.includes('Key not found') ? 404 : 400;
      res.status(status).json({ error: status === 404 ? 'Order not found' : error.message, upstream: true }); return;
    }
    next(error);
  }
});
export default router;
