import { Router } from 'express';
import type { CreateOrderRequest, Quote, QuoteRequest, SignFundingResponse } from '@ckb-on-ramp/contracts';
import {
  getBootstrapSession,
  getBootstrapSessionByChannelId,
  getBootstrapSessionStore,
  prepareInboundLiquidity,
} from '../services/bootstrap.js';
import { type OperatorCkbSender } from '../services/ccc.js';
import { CchRpcError, cchGateway as defaultCchGateway, type CchGateway } from '../services/cch.js';
import { FundingPolicyError } from '../services/errors.js';
import { fundingRequestHash, FundingSigningError } from '../services/fundingSigning.js';
import { releaseSupersededReservations } from '../services/fundingSupersede.js';
import {
  InflightCollisionError,
  InflightOutpointsTracker,
  defaultInflightTracker,
  extractFundingTxOutpointKeys,
} from '../services/inflightOutpoints.js';
import { getOperatorSigner } from '../services/operatorSigner.js';
import { createQuote } from '../services/quote.js';
import {
  assertWithinFundingLimit,
  getReceiveReadiness,
  type OperatorInventory,
} from '../services/fundingAvailability.js';

export interface ApiRouterDependencies {
  cchGateway?: CchGateway;
  prepareInboundLiquidity?: typeof prepareInboundLiquidity;
  operatorCkbSender?: OperatorCkbSender;
  inflightTracker?: InflightOutpointsTracker;
  operatorInventory?: OperatorInventory;
}

export function createApiRouter(deps: ApiRouterDependencies = {}): Router {
  const router = Router();
  const gateway = deps.cchGateway ?? defaultCchGateway;
  const prepLiquidity = deps.prepareInboundLiquidity ?? prepareInboundLiquidity;
  const inflight = deps.inflightTracker ?? defaultInflightTracker;
  const pendingSignatures = new Map<string, { hash: string; promise: Promise<SignFundingResponse> }>();
  const checkReceiveReadiness = async (fundingAmount?: string) => {
    try {
      return await getReceiveReadiness({
        gateway,
        sender: deps.operatorCkbSender ?? getOperatorSigner(),
        fundingAmount,
        inventory: deps.operatorInventory,
      });
    } catch (error) {
      return { canReceive: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

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
    const readiness = fnnReachable
      ? await checkReceiveReadiness()
      : { canReceive: false, reason: 'FNN is unreachable' };
    res.json({
      ok: fnnReachable,
      mode: 'testnet',
      fnn_reachable: fnnReachable,
      can_receive: readiness.canReceive,
      unavailable_reason: readiness.reason,
    });
  });

  router.get('/node-info', async (_req, res, next) => {
    try {
      const info = await gateway.getNodeInfo();
      const readiness = await checkReceiveReadiness();
      res.json({ ...info, can_receive: readiness.canReceive, unavailable_reason: readiness.reason });
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
      res.status(404).json({ error: 'Bootstrap session not found' });
      return;
    }
    res.json(session);
  });

  // Read-only recovery of a cooperative-close hash when browser WASM omits it.
  // This never reconstructs a bootstrap session or grants signing permission.
  router.get('/channels/:channelId/close', async (req, res, next) => {
    const session = getBootstrapSessionByChannelId(req.params.channelId);
    if (!session?.node_pubkey || !gateway.listChannels) {
      res.status(404).json({ error: 'Known channel session not found' });
      return;
    }
    try {
      const normalize = (value: string) => value.replace(/^0x/i, '').toLowerCase();
      const listed = await gateway.listChannels({ include_closed: true, pubkey: session.node_pubkey });
      const channel = listed.channels.find((item) =>
        normalize(item.channel_id) === normalize(req.params.channelId) &&
        normalize(item.pubkey) === normalize(session.node_pubkey!),
      );
      const hash = channel?.shutdown_transaction_hash;
      const cooperative = channel?.state?.state_name?.replace(/[^a-z]/gi, '').toLowerCase() === 'closed' &&
        channel.state.state_flags === 'COOPERATIVE';
      res.json({ channel_id: session.channel_id, shutdown_transaction_hash:
        cooperative && typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash) ? hash : null });
    } catch (error) { next(error); }
  });

  router.post('/bootstrap', async (req, res) => {
    try {
      const session = await prepLiquidity({
        node_pubkey: String(req.body?.node_pubkey ?? ''),
        funding_address: req.body?.funding_address ? String(req.body.funding_address) : undefined,
        external_funding: req.body?.external_funding === true,
      });
      const status = session.status !== 'failed'
        ? 201
        : session.failure_code === 'not_configured'
          ? 501
          : 503;
      res.status(status).json(session);
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
      const channelId = String(req.body?.channel_id ?? '').trim().toLowerCase();
      const unsignedTx = req.body?.unsigned_funding_tx;
      if (!channelId) {
        res.status(400).json({ error: 'channel_id is required' });
        return;
      }
      if (!unsignedTx || typeof unsignedTx !== 'object' || Array.isArray(unsignedTx)) {
        res.status(400).json({ error: 'unsigned_funding_tx is required' });
        return;
      }

      // FNN channel status cannot recreate a lost signing authorization.
      const store = getBootstrapSessionStore();
      const session = store.getByChannelId(channelId);
      if (!session) {
        res.status(400).json({ error: `channel_id (${channelId}) is not associated with an accepted bootstrap session` });
        return;
      }
      const requestHash = fundingRequestHash(unsignedTx);
      if (session.signed) {
        if (!session.funding_request_hash || session.funding_request_hash !== requestHash) {
          res.status(400).json({ error: `Funding transaction for channel (${channelId}) has already been signed or reserved for a different transaction` });
          return;
        }
        // Retrieving an existing result does not consume inventory or grant new authorization.
        if (session.signed_funding_tx !== undefined) {
          res.json({ channel_id: channelId, signed_funding_tx: session.signed_funding_tx });
          return;
        }
        const pending = pendingSignatures.get(channelId);
        if (pending?.hash === requestHash) {
          res.json(await pending.promise);
          return;
        }
        res.status(503).json({ error: 'Funding signing outcome is unavailable. Do not re-sign this channel; wait for the pending channel to resolve or start a new bootstrap.' });
        return;
      }
      if (session.status !== 'provisioning_liquidity') {
        res.status(400).json({ error: `Channel session is not in provisioning state (status: ${session.status})` });
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
      assertWithinFundingLimit(BigInt(session.funding_amount));

      const sender = deps.operatorCkbSender ?? getOperatorSigner();
      if (!sender?.signFundingTransaction) {
        res.status(501).json({
          error: 'Operator external funding signer is not configured (OPERATOR_CKB_PRIVATE_KEY is unset)',
        });
        return;
      }

      const outpointKeys = extractFundingTxOutpointKeys(unsignedTx);
      // Synchronous durable claim BEFORE the first await, also guarding other router instances.
      const reservedSession = { ...session, signed: true, funding_request_hash: requestHash };
      store.set(session.session_id, reservedSession);

      const signing = (async (): Promise<SignFundingResponse> => {
        let outpointsReserved = false;
        let signedTx: unknown;
        try {
          const readiness = await getReceiveReadiness({
            gateway,
            sender,
            fundingAmount: session.funding_amount,
            externalFunding: true,
            inventory: deps.operatorInventory,
          });
          if (!readiness.canReceive) {
            throw new FundingSigningError(503, `Operator cannot fund this channel: ${readiness.reason ?? 'inventory is unavailable'}`);
          }
          // Other channels retain independent outpoint collision protection.
          try {
            inflight.tryReserve(outpointKeys, channelId);
          } catch (collision) {
            if (!(collision instanceof InflightCollisionError)) throw collision;
            // A retry from the same node may supersede its own earlier attempt whose
            // funding tx never reached the chain (issue #2); anything else stays a 409.
            const superseded = await releaseSupersededReservations({
              channelId,
              session,
              conflictingKeys: collision.conflictingKeys,
              store,
              inflight,
              sender,
              isSigning: (other) => other !== channelId && pendingSignatures.has(other),
            });
            if (superseded.released.length === 0) {
              throw new InflightCollisionError(
                `${collision.message}${superseded.blockedReason ? ` (${superseded.blockedReason})` : ''}`,
                collision.conflictingKeys,
              );
            }
            console.info(`[sign-funding] channel ${channelId} superseded stale reservation(s) of ${superseded.released.join(', ')}`);
            inflight.tryReserve(outpointKeys, channelId);
          }
          outpointsReserved = true;
          const fnnLock = gateway.getFnnFundingLockScript ? await gateway.getFnnFundingLockScript() : undefined;
          if (session.expires_at && Date.now() > session.expires_at) {
            throw new FundingSigningError(400, `Bootstrap session for channel (${channelId}) has expired`);
          }
          signedTx = await sender.signFundingTransaction!(unsignedTx, {
            expectedExactUdtAmount: BigInt(session.funding_amount!),
            allowedAdditionalInputLocks: fnnLock ? [fnnLock] : undefined,
          });
        } catch (error) {
          // No signature returned: restore authorization before allowing a new attempt.
          store.set(session.session_id, session);
          if (outpointsReserved) inflight.release(outpointKeys, channelId);
          throw error;
        }

        // A failure here must KEEP authorization consumed: signing already completed.
        store.set(session.session_id, { ...reservedSession, signed_funding_tx: signedTx });
        return { channel_id: channelId, signed_funding_tx: signedTx };
      })();
      pendingSignatures.set(channelId, { hash: requestHash, promise: signing });
      try {
        res.json(await signing);
      } finally {
        pendingSignatures.delete(channelId);
      }
    } catch (error) {
      if (error instanceof InflightCollisionError) {
        res.status(409).json({ error: error.message, conflicting_outpoints: error.conflictingKeys });
        return;
      }
      if (error instanceof FundingSigningError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof FundingPolicyError) {
        res.status(400).json({ error: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('operator channel funding limit') || msg.includes('Funding amount must be positive')) {
        res.status(400).json({ error: msg });
        return;
      }
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
      assertWithinFundingLimit(BigInt(quote.receive_raw));
      const order = await gateway.createOrder(input as CreateOrderRequest, quote);
      trimOldest(idempotency);
      idempotency.set(key, { paymentHash: order.payment_hash, fingerprint, createdAt: Date.now() }); res.status(201).json(order);
    } catch (error) {
      if (error instanceof CchRpcError) { res.status(400).json({ error: error.message, upstream: true }); return; }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('operator channel funding limit') || msg.includes('Funding amount must be positive')) {
        res.status(400).json({ error: msg });
        return;
      }
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
