import { Router } from 'express';
import type { CreateOrderRequest, Quote, QuoteRequest, SignFundingResponse } from '@ckb-on-ramp/contracts';
import {
  getBootstrapSession,
  getBootstrapSessionByChannelId,
  getBootstrapSessionStore,
  prepareInboundLiquidity,
  recoverSessionFromFnn,
} from '../services/bootstrap.js';
import { type OperatorCkbSender } from '../services/ccc.js';
import { CchRpcError, cchGateway as defaultCchGateway, type CchGateway } from '../services/cch.js';
import { FundingPolicyError } from '../services/errors.js';
import { getOperatorSigner } from '../services/operatorSigner.js';
import { createQuote } from '../services/quote.js';

export interface ApiRouterDependencies {
  cchGateway?: CchGateway;
  prepareInboundLiquidity?: typeof prepareInboundLiquidity;
  operatorCkbSender?: OperatorCkbSender;
}

export function createApiRouter(deps: ApiRouterDependencies = {}): Router {
  const router = Router();
  const gateway = deps.cchGateway ?? defaultCchGateway;
  const prepLiquidity = deps.prepareInboundLiquidity ?? prepareInboundLiquidity;

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
    const fnnReachable = await gateway.health();
    res.json({ ok: fnnReachable, mode: 'testnet', fnn_reachable: fnnReachable });
  });

  router.get('/node-info', async (_req, res, next) => {
    try {
      const info = await gateway.getNodeInfo();
      res.json(info);
    } catch (error) {
      if (error instanceof CchRpcError) {
        res.status(502).json({ error: error.message, upstream: true });
        return;
      }
      next(error);
    }
  });

  router.get('/bootstrap/:sessionId', async (req, res) => {
    let session = getBootstrapSession(req.params.sessionId);
    if (!session) {
      session = getBootstrapSessionByChannelId(req.params.sessionId);
    }
    if (!session) {
      session = await recoverSessionFromFnn(req.params.sessionId, gateway);
    }
    if (!session) {
      res.status(404).json({ error: 'Bootstrap session not found' });
      return;
    }
    res.json(session);
  });

  router.post('/bootstrap', async (req, res) => {
    try {
      const session = await prepLiquidity({
        node_pubkey: String(req.body?.node_pubkey ?? ''),
        funding_address: req.body?.funding_address ? String(req.body.funding_address) : undefined,
        external_funding: req.body?.external_funding === true,
      });
      res.status(session.status === 'failed' ? 501 : 201).json(session);
    } catch (error) {
      if (error instanceof CchRpcError) {
        res.status(502).json({ error: error.message, upstream: true });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      const isValidationError = msg.includes('node_pubkey') || msg.includes('funding_address');
      res.status(isValidationError ? 400 : 500).json({ error: msg });
    }
  });

  router.post('/sign-funding', async (req, res) => {
    try {
      const channelId = String(req.body?.channel_id ?? '').trim();
      const unsignedTx = req.body?.unsigned_funding_tx;
      if (!channelId) {
        res.status(400).json({ error: 'channel_id is required' });
        return;
      }
      if (!unsignedTx || typeof unsignedTx !== 'object') {
        res.status(400).json({ error: 'unsigned_funding_tx is required' });
        return;
      }

      // Gate: Verify channel_id is bound to an active accepted bootstrap session
      let session = getBootstrapSessionByChannelId(channelId);
      if (!session) {
        session = await recoverSessionFromFnn(channelId, gateway);
      }
      if (!session) {
        res.status(400).json({ error: `channel_id (${channelId}) is not associated with an accepted bootstrap session` });
        return;
      }
      if (session.status !== 'provisioning_liquidity') {
        res.status(400).json({ error: `Channel session is not in provisioning state (status: ${session.status})` });
        return;
      }
      if (session.signed) {
        res.status(400).json({ error: `Funding transaction for channel (${channelId}) has already been signed` });
        return;
      }
      if (session.expires_at && Date.now() > session.expires_at) {
        res.status(400).json({ error: `Bootstrap session for channel (${channelId}) has expired` });
        return;
      }
      if (!session.funding_amount) {
        res.status(400).json({ error: `Bootstrap session for channel (${channelId}) is missing negotiated funding amount` });
        return;
      }

      const sender = deps.operatorCkbSender ?? getOperatorSigner();
      if (!sender?.signFundingTransaction) {
        res.status(501).json({
          error: 'Operator external funding signer is not configured (OPERATOR_CKB_PRIVATE_KEY is unset)',
        });
        return;
      }

      // Atomic reservation to prevent TOCTOU concurrent double-signing
      session.signed = true;
      getBootstrapSessionStore().set(session.session_id, session);

      let signedTx: unknown;
      try {
        const fnnLock = gateway.getFnnFundingLockScript ? await gateway.getFnnFundingLockScript() : undefined;
        const allowedAdditional = fnnLock ? [fnnLock] : undefined;
        signedTx = await sender.signFundingTransaction(unsignedTx, {
          expectedExactUdtAmount: BigInt(session.funding_amount),
          allowedAdditionalInputLocks: allowedAdditional,
        });
      } catch (err) {
        session.signed = false; // rollback on failure
        getBootstrapSessionStore().set(session.session_id, session);
        console.error('[sign-funding] failed:', err instanceof Error ? err.message : String(err));
        throw err;
      }

      const response: SignFundingResponse = {
        channel_id: channelId,
        signed_funding_tx: signedTx,
      };
      res.json(response);
    } catch (error) {
      if (error instanceof FundingPolicyError) {
        res.status(400).json({ error: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
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
        const existing = await gateway.getOrder(replay.paymentHash);
        if (existing) { res.json(existing); return; }
      } else if (replay) idempotency.delete(key);
      const quote = quotes.get(input.quote_id);
      if (!quote || Date.parse(quote.expires_at) <= Date.now()) { res.status(410).json({ error: 'Quote is missing or expired. Request a new quote.' }); return; }
      const order = await gateway.createOrder(input as CreateOrderRequest, quote);
      trimOldest(idempotency);
      idempotency.set(key, { paymentHash: order.payment_hash, fingerprint, createdAt: Date.now() }); res.status(201).json(order);
    } catch (error) {
      if (error instanceof CchRpcError) { res.status(400).json({ error: error.message, upstream: true }); return; }
      next(error);
    }
  });

  router.get('/orders/:paymentHash', async (req, res, next) => {
    try {
      const order = await gateway.getOrder(req.params.paymentHash);
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

  return router;
}

const router = createApiRouter();
export default router;
