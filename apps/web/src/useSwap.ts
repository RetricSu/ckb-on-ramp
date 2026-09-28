import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HealthResponse, NodeInfo, Quote, SwapOrder } from '@ckb-on-ramp/contracts';
import type { Channel, FiberBrowserNode } from '@fiber-pay/sdk/browser';
import { ApiError, api, isFundingInflightCollision } from './api';
import { formatCwbtc, parseCwbtc, toHex } from './amount';
import { CWBTC_SCRIPT, useFiber } from './FiberProvider';
import { normalizeChannelStateName, waitForCwbtcChannelReady } from './channels';
import { pickPeerAddress, prepareReceiveRoute, waitForConnectedPeer } from './peer';
import { loadReceipts, orderToReceipt, saveReceipt, updateReceiptStatus } from './receipts';
import {
  determineAutoResumeStrategy,
  isPendingStatus,
  shouldExpireOrderOn404,
  shouldResumeNode,
} from './nodeResume';
import {
  clearChannelTicket,
  loadChannelTicket,
  saveChannelTicket,
  type ChannelOpeningTicket,
} from './channelTicket';
import type { SwapReceipt, SwapStep } from './types';

const LAST_ORDER_KEY = 'ckb-on-ramp:last-order';
// Fiber invoice final_expiry_delta is milliseconds. Node min is 9_600_000 (160 min);
// CCH also requires it < half of BTC CLTV (~108_000_000 ms). 24h sits in that window.
const FIBER_INVOICE_FINAL_EXPIRY_DELTA_MS = 86_400_000n;

function toHexChannelId(val: string): `0x${string}` {
  if (val.startsWith('0x')) {
    return val as `0x${string}`;
  }
  return `0x${val}`;
}

export function isCwbtcChannel(channel?: Channel | null): boolean {
  if (!channel || !channel.funding_udt_type_script) return false;
  const script = channel.funding_udt_type_script;
  return (
    script.code_hash?.toLowerCase() === CWBTC_SCRIPT.code_hash.toLowerCase() &&
    script.args?.toLowerCase() === CWBTC_SCRIPT.args.toLowerCase()
  );
}

function loadStoredOrder(): SwapOrder | null {
  try {
    const value = localStorage.getItem(LAST_ORDER_KEY);
    if (!value) return null;
    const order = JSON.parse(value) as Partial<SwapOrder>;
    return order.payment_hash && order.lightning_invoice ? (order as SwapOrder) : null;
  } catch {
    return null;
  }
}

export function useSwap() {
  const fiber = useFiber();
  // Keep an up-to-date ref so async polling loops never suffer from stale render closures
  const fiberRef = useRef(fiber);
  fiberRef.current = fiber;

  // Amount input mode: 'pay' (BTC) or 'receive' (cWBTC)
  const [inputMode, setInputMode] = useState<'pay' | 'receive'>('pay');
  const [payAmount, setPayAmount] = useState('0.0001');
  const [receiveAmount, setReceiveAmount] = useState('0.00009580');
  const [touched, setTouched] = useState(false);

  // Quote state
  const [quote, setQuote] = useState<Quote | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Swap pipeline state
  const [step, setStep] = useState<SwapStep>('idle');
  const [progressTitle, setProgressTitle] = useState('');
  const [progressMessage, setProgressMessage] = useState('');
  const [order, setOrder] = useState<SwapOrder | null>(loadStoredOrder);
  const [error, setError] = useState<string | null>(null);

  // Network & Node facts
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [operatorNode, setOperatorNode] = useState<NodeInfo | null>(null);

  // Balances & Receipts
  const [cwbtcBalanceRaw, setCwbtcBalanceRaw] = useState<bigint>(0n);
  const [receipts, setReceipts] = useState<SwapReceipt[]>(loadReceipts);
  const consecutive404Ref = useRef(0);
  const autoResumeAttemptedRef = useRef(false);

  // Modals
  const [isSettlementOpen, setIsSettlementOpen] = useState(false);
  const [isProgressOpen, setIsProgressOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);

  // Auto-open settlement modal if a pending order was restored from storage
  useEffect(() => {
    if (order && ['Pending', 'IncomingAccepted', 'OutgoingInFlight'].includes(order.status)) {
      setIsSettlementOpen(true);
      setStep('awaiting_payment');
    }
  }, []);

  // Initial health & operator node fetch
  const fetchHealthAndOperator = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
    } catch {
      setHealth(null);
    }
    try {
      const info = await api.nodeInfo();
      setOperatorNode(info);
    } catch {
      setOperatorNode(null);
    }
  }, []);

  useEffect(() => {
    void fetchHealthAndOperator();
  }, [fetchHealthAndOperator]);

  // Derive target receive_raw from either pay input or receive input
  const parsedTarget = useMemo(() => {
    try {
      if (inputMode === 'receive') {
        const raw = parseCwbtc(receiveAmount);
        return { raw, error: null };
      }
      // When inputting payAmount (BTC):
      // pay_sats = receive_raw + baseFee + floor(receive_raw * feeRatePpm / 1_000_000)
      // Base fee defaults to 100 sats, feeRatePpm ~3000 (0.3%)
      const paySats = parseCwbtc(payAmount); // 8 decimals = sats
      if (paySats <= 100n) {
        return { raw: null, error: 'Amount must be greater than base network fee (100 sats).' };
      }
      // Invert: receive_raw ≈ (paySats - 100) * 1_000_000 / 1_003_000
      const approxReceiveRaw = ((paySats - 100n) * 1_000_000n) / 1_003_000n;
      if (approxReceiveRaw <= 0n) {
        return { raw: null, error: 'Amount is too low to cover fees.' };
      }
      return { raw: approxReceiveRaw, error: null };
    } catch (reason) {
      return {
        raw: null,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [inputMode, payAmount, receiveAmount]);

  // Debounced quote fetch
  const quoteTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (quoteTimerRef.current) window.clearTimeout(quoteTimerRef.current);
    setQuoteError(null);

    if (!parsedTarget.raw) {
      setQuote(null);
      setIsQuoting(false);
      return;
    }

    const rawStr = parsedTarget.raw.toString();
    setIsQuoting(true);

    quoteTimerRef.current = window.setTimeout(async () => {
      try {
        const q = await api.quote(rawStr);
        setQuote(q);
        setQuoteError(null);
        // Sync the complementary field
        if (inputMode === 'pay') {
          setReceiveAmount(formatCwbtc(q.receive_raw));
        } else {
          setPayAmount((q.pay_sats / 100_000_000).toFixed(8));
        }
      } catch (err) {
        setQuote(null);
        setQuoteError(err instanceof Error ? err.message : 'Failed to fetch quote');
      } finally {
        setIsQuoting(false);
      }
    }, 280);

    return () => {
      if (quoteTimerRef.current) window.clearTimeout(quoteTimerRef.current);
    };
  }, [parsedTarget.raw, inputMode]);

  // Live cWBTC balance & ready channel check (filtered strictly by funding_udt_type_script)
  const refreshBalance = useCallback(async () => {
    const currentFiber = fiberRef.current;
    if (!currentFiber.isRunning || !currentFiber.node) {
      setCwbtcBalanceRaw(0n);
      return;
    }
    try {
      const res = await currentFiber.node.listChannels({});
      const channels = res?.channels ?? [];
      let total = 0n;
      for (const ch of channels) {
        const isReady = normalizeChannelStateName(ch.state?.state_name) === 'CHANNELREADY';
        if (isReady && isCwbtcChannel(ch)) {
          try {
            total += BigInt(ch.local_balance);
          } catch {
            // ignore malformed hex
          }
        }
      }
      setCwbtcBalanceRaw(total);
    } catch {
      // transient query error
    }
  }, []);

  useEffect(() => {
    void refreshBalance();
    const timer = window.setInterval(() => void refreshBalance(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshBalance]);

  // Background polling for active order
  useEffect(() => {
    if (!order || ['Success', 'Failed', 'Expired'].includes(order.status)) return;

    const timer = window.setInterval(async () => {
      try {
        const next = await api.getOrder(order.payment_hash);
        consecutive404Ref.current = 0;
        setOrder(next);
        localStorage.setItem(LAST_ORDER_KEY, JSON.stringify(next));

        const isComplete = next.status === 'Success' || next.status === 'OutgoingSuccess';
        const isFailed = next.status === 'Failed' || next.status === 'Expired';

        if (isComplete) {
          setStep('settled');
          const updated = updateReceiptStatus(next.payment_hash, 'Success', Date.now());
          setReceipts(updated);
          void refreshBalance();
        } else if (isFailed) {
          setStep('failed');
          const updated = updateReceiptStatus(next.payment_hash, next.status, undefined, next.failure_reason);
          setReceipts(updated);
        } else {
          updateReceiptStatus(next.payment_hash, next.status);
        }
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 404) {
          consecutive404Ref.current += 1;
          if (shouldExpireOrderOn404(consecutive404Ref.current)) {
            setOrder((prev) => (prev ? { ...prev, status: 'Expired' } : null));
          }
        }
      }
    }, 1500);

    return () => window.clearInterval(timer);
  }, [order?.payment_hash, order?.status, refreshBalance]);

  // Cross-session polling for all pending receipts in localStorage
  useEffect(() => {
    const pendingReceipts = receipts.filter(
      (r) => r.status === 'Pending' || r.status === 'IncomingAccepted' || r.status === 'OutgoingInFlight',
    );
    if (pendingReceipts.length === 0) return;

    const pollPending = async () => {
      let anyChanged = false;
      for (const r of pendingReceipts) {
        try {
          const remoteOrder = await api.getOrder(r.paymentHash);
          if (remoteOrder && remoteOrder.status !== r.status) {
            updateReceiptStatus(
              remoteOrder.payment_hash,
              remoteOrder.status,
              remoteOrder.status === 'Success' ? Date.now() : undefined,
              remoteOrder.failure_reason,
            );
            anyChanged = true;
          }
        } catch {
          // ignore transient poll error
        }
      }
      if (anyChanged) {
        setReceipts(loadReceipts());
        void refreshBalance();
      }
    };

    void pollPending();
    const timer = window.setInterval(() => void pollPending(), 6000);
    return () => window.clearInterval(timer);
  }, [receipts, refreshBalance]);

  // Unified silent node initializer (using fiberRef to avoid stale closures & fail fast on errors)
  const ensureNodeRunning = useCallback(
    async (options?: { allowCreate?: boolean }): Promise<FiberBrowserNode> => {
      const allowCreate = options?.allowCreate ?? true;
      if (fiberRef.current.isRunning && fiberRef.current.node) {
        return fiberRef.current.node;
      }

      setProgressTitle('Authorizing Local Wallet');
      const e2ePassword = import.meta.env.DEV ? String(import.meta.env.VITE_E2E_PASSWORD ?? '').trim() : '';
      if (e2ePassword) {
        setProgressMessage('Authorizing browser Fiber node via local password (dev e2e). Your keys stay in this browser.');
        await fiberRef.current.startWithPassword(e2ePassword);
      } else {
        setProgressMessage('Authorizing browser Fiber node via Passkey. Your keys stay in this browser.');
        if (!fiberRef.current.isPasskeySupported && !fiberRef.current.hasPasskeyConfigured) {
          const reason =
            fiberRef.current.passkeyUnavailableReason ||
            'Passkeys / WebAuthn are not supported in this browser. Please use a modern browser with WebAuthn.';
          throw new Error(reason);
        }
        if (fiberRef.current.hasPasskeyConfigured) {
          await fiberRef.current.startWithPasskey();
        } else if (allowCreate) {
          await fiberRef.current.createPasskeyAndStart('CKB On-ramp user');
        } else {
          throw new Error('Auto-resume forbidden from creating a new passkey; waiting for configured passkey.');
        }
      }

      // Poll fiberRef.current with immediate error checking
      const maxWait = e2ePassword ? 120_000 : 20_000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const current = fiberRef.current;
        if (current.error) {
          const err = current.error;
          if (
            err.includes('cancelled') ||
            err.includes('NotAllowedError') ||
            err.includes('AbortError') ||
            err.includes('abort') ||
            err.includes('cancel')
          ) {
            throw new Error('Passkey authorization was cancelled. Click Swap to try again.');
          }
          throw new Error(`Failed to start Fiber node: ${err}`);
        }

        if (current.isRunning && current.node) {
          return current.node;
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      if (fiberRef.current.error) {
        throw new Error(`Failed to start Fiber node: ${fiberRef.current.error}`);
      }
      throw new Error('Local Fiber node took too long to initialize. Please check passkey permissions.');
    },
    [],
  );

  // Helper to connect to operator relay peer
  const connectOperatorPeer = useCallback(async (node: FiberBrowserNode) => {
    try {
      const info = await api.nodeInfo();
      setOperatorNode(info);
      const peerAddress = pickPeerAddress(info.addresses);
      if (peerAddress) {
        await node.connectPeer({ address: peerAddress, save: true });
      }
    } catch (err) {
      console.warn('[useSwap] Failed to auto-connect to operator peer:', err);
    }
  }, []);

  // Shared connect action for Navbar
  const connectNode = useCallback(async () => {
    setError(null);
    try {
      const node = await ensureNodeRunning();
      await connectOperatorPeer(node);
      void refreshBalance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [ensureNodeRunning, connectOperatorPeer, refreshBalance]);

  // Resumes an in-flight channel opening workflow after page refresh
  const resumeChannelOpening = useCallback(
    async (node: FiberBrowserNode, ticket: ChannelOpeningTicket) => {
      setIsProgressOpen(true);
      setError(null);
      try {
        setStep('provisioning_channel');
        setProgressTitle('Resuming Channel Opening');
        setProgressMessage('Checking channel status with operator…');

        const opInfo = await api.nodeInfo();
        setOperatorNode(opInfo);

        let channelId = ticket.channelId;
        const targetRaw = BigInt(ticket.targetRaw);

        if (
          ticket.step === 'waiting_for_channel' ||
          ticket.step === 'waiting_for_accept' ||
          ticket.step === 'signing_funding'
        ) {
          let acceptedChannelId = channelId;
          const pollSessionStart = Date.now();
          const sessionTimeoutMs = 30_000;
          while (Date.now() - pollSessionStart < sessionTimeoutMs) {
            const s = await api.getBootstrapSession(ticket.sessionId).catch(() => null);
            if (s) {
              if (s.status === 'failed') {
                clearChannelTicket();
                throw new Error(s.message || 'Operator failed to accept channel offer.');
              }
              if (s.status === 'provisioning_liquidity' && s.channel_id) {
                acceptedChannelId = s.channel_id;
                break;
              }
            }
            await new Promise((r) => setTimeout(r, 1000));
          }

          if (!acceptedChannelId) {
            throw new Error('Timed out waiting for operator node to confirm channel acceptance.');
          }
          channelId = acceptedChannelId;

          if (!ticket.unsignedFundingTx) {
            throw new Error('Cannot resume channel signing without unsigned_funding_tx.');
          }

          setProgressTitle('Signing Channel Transaction');
          setProgressMessage('Requesting operator signature for funding capacity…');
          saveChannelTicket({
            ...ticket,
            channelId,
            step: 'signing_funding',
          });

          const signResult = await api.signFunding({
            channel_id: acceptedChannelId,
            unsigned_funding_tx: ticket.unsignedFundingTx,
          });

          ticket.signedFundingTx = signResult.signed_funding_tx;
          ticket.step = 'submitting_funding';
          saveChannelTicket(ticket);
        }

        if (ticket.step === 'submitting_funding') {
          setProgressTitle('Submitting Funding Transaction');
          setProgressMessage('Submitting signed funding transaction to network…');

          if (!channelId || !ticket.signedFundingTx) {
            throw new Error('Missing channelId or signed funding tx for submission.');
          }

          const submitResult = await node.submitSignedFundingTx({
            channel_id: toHexChannelId(channelId),
            signed_funding_tx: ticket.signedFundingTx as Record<string, unknown>,
          });

          channelId = submitResult?.channel_id ?? channelId;
          ticket.channelId = channelId;
          ticket.step = 'waiting_for_ready';
          saveChannelTicket(ticket);
        }

        if (ticket.step === 'waiting_for_ready') {
          setProgressTitle('Confirming Inbound Channel');
          setProgressMessage('Funding transaction submitted. Waiting for on-chain confirmation…');

          channelId = await waitForCwbtcChannelReady({
            node,
            sessionId: ticket.sessionId,
            expectedChannelId: channelId,
            existingReadyIds: new Set(),
            minInboundCapacity: targetRaw,
            isCwbtcChannel,
            getBootstrapSession: (sid) => api.getBootstrapSession(sid),
            timeoutMs: 120_000,
          });

          ticket.step = 'waiting_for_ready';
          ticket.channelId = channelId;
          saveChannelTicket(ticket);
        }

        void refreshBalance();

        // Final safety gate: verify ready cWBTC channel is active before signing invoice
        const finalChannelCheck = await node.listChannels({});
        const hasConfirmedReadyChannel = (finalChannelCheck?.channels ?? []).some((ch) => {
          return normalizeChannelStateName(ch.state?.state_name) === 'CHANNELREADY' && isCwbtcChannel(ch);
        });
        if (!hasConfirmedReadyChannel) {
          throw new Error('No ready cWBTC channel found. A channel must be open to receive funds.');
        }

        // Step 4: Obtain fresh authoritative quote
        setStep('creating_invoice');
        setProgressTitle('Generating Swap Invoices');
        setProgressMessage('Signing Fiber invoice and preparing Lightning payment…');

        const activeQuote = await api.quote(targetRaw.toString());
        setQuote(activeQuote);

        // Step 5: Sign Fiber invoice
        const invoice = await node.newInvoice({
          amount: toHex(BigInt(activeQuote.receive_raw)),
          currency: 'Fibt',
          udt_type_script: CWBTC_SCRIPT,
          hash_algorithm: 'sha256',
          final_expiry_delta: toHex(FIBER_INVOICE_FINAL_EXPIRY_DELTA_MS),
          description: 'CKB On-ramp: BTC to cWBTC',
        });

        // Step 6: Create CCH order on backend
        setStep('creating_order');
        const newOrder = await api.createOrder(
          {
            fiber_invoice: invoice.invoice_address,
            quote_id: activeQuote.quote_id,
          },
          crypto.randomUUID(),
        );

        // Save order & receipt
        setOrder(newOrder);
        localStorage.setItem(LAST_ORDER_KEY, JSON.stringify(newOrder));
        const receipt = orderToReceipt(newOrder, channelId);
        const updatedReceipts = saveReceipt(receipt);
        setReceipts(updatedReceipts);

        // Order is safely on disk; clear the opening ticket
        clearChannelTicket();

        // Only transition to awaiting_payment after order is successfully created and persisted
        setStep('awaiting_payment');
        setIsProgressOpen(false);
        setIsSettlementOpen(true);
      } catch (err) {
        // Do NOT clear ticket on transient failure (timeout, network, signing error)
        // Keep ticket in storage so subsequent refresh/retry can resume channel opening
        setStep('failed');
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    },
    [refreshBalance],
  );

  // Auto-resume node on mount or state load
  useEffect(() => {
    if (autoResumeAttemptedRef.current) return;
    if (fiber.isRunning || fiber.isStarting) return;

    const channelTicket = loadChannelTicket();
    const shouldResume = shouldResumeNode({
      hasPasskeyConfigured: fiber.hasPasskeyConfigured,
      pendingOrder: order,
      pendingReceipts: receipts,
      pendingChannel: channelTicket,
    });

    const e2ePassword = import.meta.env.DEV ? String(import.meta.env.VITE_E2E_PASSWORD ?? '').trim() : '';
    const strategy = determineAutoResumeStrategy({
      hasPasskeyConfigured: fiber.hasPasskeyConfigured,
      e2ePassword,
      shouldResume,
    });

    // If strategy says wait (e.g. hasPasskeyConfigured is still initializing/false) or none:
    // DO NOT set autoResumeAttemptedRef! Return and wait for hasPasskeyConfigured to update.
    if (!strategy.canResume) {
      return;
    }

    autoResumeAttemptedRef.current = true;

    void (async () => {
      try {
        const node = await ensureNodeRunning({ allowCreate: false });
        await connectOperatorPeer(node);
        void refreshBalance();

        if (channelTicket) {
          await resumeChannelOpening(node, channelTicket);
        }
      } catch (err) {
        console.warn('[AutoResume] Background node resume stopped:', err);
      }
    })();
  }, [
    fiber.hasPasskeyConfigured,
    fiber.isRunning,
    fiber.isStarting,
    order,
    receipts,
    ensureNodeRunning,
    connectOperatorPeer,
    refreshBalance,
    resumeChannelOpening,
  ]);

  // Open a specific receipt in the settlement modal
  const viewReceipt = useCallback((receipt: SwapReceipt) => {
    const matchingOrder: SwapOrder = {
      order_id: receipt.paymentHash,
      payment_hash: receipt.paymentHash,
      status: receipt.status,
      lightning_invoice: receipt.lightningInvoice,
      fiber_invoice: '',
      receive_raw: receipt.receiveRaw,
      pay_sats: receipt.paySats,
      fee_sats: receipt.feeSats,
      created_at: new Date(receipt.createdAt).toISOString(),
      failure_reason: receipt.failureReason,
    };
    setOrder(matchingOrder);
    setIsHistoryOpen(false);
    setIsSettlementOpen(true);
  }, []);

  // Main Swap execution pipeline
  const initiateSwap = useCallback(async () => {
    if (health?.can_receive === false) {
      setError(health.unavailable_reason ?? 'The operator cannot receive new swaps right now.');
      return;
    }
    if (!parsedTarget.raw) {
      setError('Please enter a valid amount.');
      return;
    }

    if (operatorNode?.operator_channel_funding_amount) {
      const maxFunded = BigInt(operatorNode.operator_channel_funding_amount);
      if (parsedTarget.raw > maxFunded) {
        setError(`Amount exceeds maximum supported inbound channel capacity (${formatCwbtc(maxFunded.toString())} cWBTC). Please enter a smaller amount.`);
        return;
      }
    }

    setError(null);
    setIsProgressOpen(true);

    try {
      // Step 1: Ensure Fiber node is running
      setStep('authorizing_node');
      const node = await ensureNodeRunning();
      const nodeInfo = fiberRef.current.nodeInfo ?? (await node.nodeInfo());
      const nodePubkey = nodeInfo.pubkey;

      // Step 2: Check if there is already an active cWBTC channel with inbound capacity
      setStep('checking_channel');
      setProgressTitle('Checking Inbound Capacity');
      setProgressMessage('Checking if your node already has an active Lightning-Fiber channel…');

      const channelList = await node.listChannels({});
      const readyCwbtcChannels = (channelList?.channels ?? []).filter((ch) => {
        const state = normalizeChannelStateName(ch.state?.state_name);
        return state === 'CHANNELREADY' && isCwbtcChannel(ch);
      });

      const hasReadyInbound = readyCwbtcChannels.some((ch) => {
        try {
          return BigInt(ch.remote_balance) >= parsedTarget.raw!;
        } catch {
          return false;
        }
      });

      const matchingChannel = readyCwbtcChannels.find((ch) => {
        try {
          return BigInt(ch.remote_balance) >= parsedTarget.raw!;
        } catch {
          return false;
        }
      });
      let channelId: string | undefined = matchingChannel?.channel_id;

      if (!hasReadyInbound) {
        // Snapshot existing ready channel IDs so we never mistake a stale, empty ready channel for the new one
        const existingReadyIds = new Set(readyCwbtcChannels.map((ch) => ch.channel_id));

        // Step 3: Peer connection & Scheme B zero-CKB sponsored channel opening
        setStep('connecting_peer');
        setProgressTitle('Connecting to Relay Peer');
        setProgressMessage('Connecting to the Lightning-Fiber gateway…');

        const route = await prepareReceiveRoute({
          nodePubkey,
          defaultFundingLockScript: nodeInfo.default_funding_lock_script,
          connectPeer: (params) => node.connectPeer(params),
          getNodeInfo: () => api.nodeInfo(),
          bootstrap: (request) => api.bootstrap(request),
          mode: health?.mode,
          onOperatorNode: setOperatorNode,
        });

        if (route.channel_id) {
          channelId = route.channel_id;
        }

        // If waiting for external funding channel, user WASM node initiates openChannelWithExternalFunding
        if (route.status === 'waiting_for_channel') {
          saveChannelTicket({
            sessionId: route.session_id,
            channelId: route.channel_id,
            step: 'waiting_for_channel',
            targetRaw: parsedTarget.raw!.toString(),
            createdAt: Date.now(),
          });

          setStep('provisioning_channel');
          setProgressTitle('Opening Sponsored Channel');

          const opInfo = route.operatorNode;
          if (!opInfo.funding_lock_script) {
            throw new Error('Operator node did not advertise a funding_lock_script for external funding.');
          }

          const ensureHex = (val: string): `0x${string}` => (val.startsWith('0x') ? val : `0x${val}`) as `0x${string}`;

          const openParams = {
            pubkey: ensureHex(opInfo.node_id),
            funding_amount: '0x0' as const,
            funding_udt_type_script: CWBTC_SCRIPT,
            shutdown_script: nodeInfo.default_funding_lock_script ?? undefined,
            funding_lock_script: {
              code_hash: ensureHex(opInfo.funding_lock_script.code_hash),
              hash_type: opInfo.funding_lock_script.hash_type,
              args: ensureHex(opInfo.funding_lock_script.args),
            },
            // v0.9.0 sizes the funding fee against a single placeholder witness, but the
            // final tx carries two witness groups (gift lock + FNN lock) and lands ~85
            // shannons under the 1000/KW min fee. 2000/KW leaves headroom.
            funding_fee_rate: '0x7d0' as `0x${string}`,
            public: false,
          };

          const MAX_INFLIGHT_OPEN_RETRIES = 5;
          let currentRoute = route;
          let finalSubmitResult: Awaited<ReturnType<typeof node.submitSignedFundingTx>> | undefined;
          let finalOpenResult: Awaited<ReturnType<typeof node.openChannelWithExternalFunding>> | undefined;
          let finalSignResult: Awaited<ReturnType<typeof api.signFunding>> | undefined;
          let activeSessionId = route.session_id;

          for (let inflightAttempt = 0; inflightAttempt < MAX_INFLIGHT_OPEN_RETRIES; inflightAttempt += 1) {
            if (inflightAttempt > 0) {
              setProgressTitle('Re-opening Sponsored Channel');
              setProgressMessage(`Gift UTXO collision detected. Re-opening channel with fresh UTXOs (attempt ${inflightAttempt + 1}/${MAX_INFLIGHT_OPEN_RETRIES})…`);

              // Exponential backoff before full restart so conflicting transactions can settle or WASM node picks different cells
              await new Promise((r) => setTimeout(r, 1000 * inflightAttempt));

              // Request a fresh bootstrap session from operator (整段重开)
              currentRoute = await prepareReceiveRoute({
                nodePubkey,
                defaultFundingLockScript: nodeInfo.default_funding_lock_script,
                connectPeer: (params) => node.connectPeer(params),
                getNodeInfo: () => api.nodeInfo(),
                bootstrap: (request) => api.bootstrap(request),
                mode: health?.mode,
                onOperatorNode: setOperatorNode,
              });
              activeSessionId = currentRoute.session_id;
              saveChannelTicket({
                sessionId: activeSessionId,
                channelId: currentRoute.channel_id,
                step: 'waiting_for_channel',
                targetRaw: parsedTarget.raw!.toString(),
                createdAt: Date.now(),
              });
            }

            setProgressMessage('Waiting for operator peer handshake…');
            await waitForConnectedPeer(() => node.listPeers(), opInfo.node_id);

            let openResult: Awaited<ReturnType<typeof node.openChannelWithExternalFunding>> | undefined;
            let lastOpenError: string | undefined;
            for (let attempt = 0; attempt < 5; attempt += 1) {
              try {
                openResult = await node.openChannelWithExternalFunding(openParams);
                break;
              } catch (openErr) {
                lastOpenError = openErr instanceof Error ? openErr.message : String(openErr);
                if (!lastOpenError.toLowerCase().includes('not connected') || attempt === 4) {
                  throw openErr;
                }
                await waitForConnectedPeer(() => node.listPeers(), opInfo.node_id, 8_000);
              }
            }
            if (!openResult) {
              throw new Error(lastOpenError || 'Failed to open channel with operator external funding.');
            }

            channelId = openResult.channel_id;
            saveChannelTicket({
              sessionId: activeSessionId,
              channelId: openResult.channel_id,
              unsignedFundingTx: openResult.unsigned_funding_tx,
              step: 'signing_funding',
              targetRaw: parsedTarget.raw!.toString(),
              createdAt: Date.now(),
            });

            setProgressTitle('Signing Channel Transaction');
            setProgressMessage('Waiting for operator channel acceptance…');

            // Poll server bootstrap session until operator FNN acceptance is confirmed
            const pollSessionStart = Date.now();
            const sessionTimeoutMs = 30_000;
            let acceptedSession = currentRoute;
            while (Date.now() - pollSessionStart < sessionTimeoutMs) {
              const s = await api.getBootstrapSession(activeSessionId).catch(() => null);
              if (s) {
                if (s.status === 'failed') {
                  clearChannelTicket();
                  throw new Error(s.message || 'Operator failed to accept channel offer.');
                }
                if (s.status === 'provisioning_liquidity' && s.channel_id) {
                  acceptedSession = { ...currentRoute, ...s };
                  break;
                }
              }
              await new Promise((r) => setTimeout(r, 1000));
            }

            if (!acceptedSession.channel_id) {
              throw new Error('Timed out waiting for operator node to confirm channel acceptance.');
            }

            setProgressMessage('Requesting operator signature for funding capacity…');
            let signResult: Awaited<ReturnType<typeof api.signFunding>> | undefined;
            try {
              signResult = await api.signFunding({
                channel_id: acceptedSession.channel_id,
                unsigned_funding_tx: openResult.unsigned_funding_tx,
              });
            } catch (signErr) {
              if (isFundingInflightCollision(signErr) && inflightAttempt < MAX_INFLIGHT_OPEN_RETRIES - 1) {
                console.warn(
                  `[useSwap] sign-funding 409 collision on attempt ${inflightAttempt + 1}, retrying full open flow:`,
                  signErr instanceof Error ? signErr.message : String(signErr),
                );
                continue; // Whole segment retry!
              }
              throw signErr;
            }

            saveChannelTicket({
              sessionId: activeSessionId,
              channelId: acceptedSession.channel_id,
              unsignedFundingTx: openResult.unsigned_funding_tx,
              signedFundingTx: signResult.signed_funding_tx,
              step: 'submitting_funding',
              targetRaw: parsedTarget.raw!.toString(),
              createdAt: Date.now(),
            });

            setProgressTitle('Submitting Funding Transaction');
            setProgressMessage('Submitting signed funding transaction to network…');

            finalSubmitResult = await node.submitSignedFundingTx({
              channel_id: openResult.channel_id,
              signed_funding_tx: signResult.signed_funding_tx as Record<string, unknown>,
            });
            finalOpenResult = openResult;
            finalSignResult = signResult;
            break;
          }

          if (!finalOpenResult || !finalSignResult) {
            throw new Error('Failed to complete external funding channel negotiation after retries.');
          }

          const finalExpectedChannelId = finalSubmitResult?.channel_id ?? finalOpenResult.channel_id;
          channelId = finalExpectedChannelId;

          saveChannelTicket({
            sessionId: activeSessionId,
            channelId: finalExpectedChannelId,
            unsignedFundingTx: finalOpenResult.unsigned_funding_tx,
            signedFundingTx: finalSignResult.signed_funding_tx,
            step: 'waiting_for_ready',
            targetRaw: parsedTarget.raw!.toString(),
            createdAt: Date.now(),
          });

          setProgressTitle('Confirming Inbound Channel');
          setProgressMessage('Funding transaction submitted. Waiting for on-chain confirmation…');

          channelId = await waitForCwbtcChannelReady({
            node,
            sessionId: activeSessionId,
            expectedChannelId: finalExpectedChannelId,
            existingReadyIds,
            minInboundCapacity: parsedTarget.raw!,
            isCwbtcChannel,
            getBootstrapSession: (sid) => api.getBootstrapSession(sid),
            timeoutMs: 120_000,
          });
        } else if (route.status === 'provisioning_liquidity') {
          setStep('provisioning_channel');
          setProgressTitle('Confirming Inbound Channel');
          setProgressMessage('Network sponsored capacity gifted. Waiting for channel confirmation…');

          channelId = await waitForCwbtcChannelReady({
            node,
            sessionId: route.session_id,
            expectedChannelId: route.channel_id,
            existingReadyIds,
            minInboundCapacity: parsedTarget.raw!,
            isCwbtcChannel,
            getBootstrapSession: (sid) => api.getBootstrapSession(sid),
            timeoutMs: 90_000,
          });
        }
      }

      // Final safety gate: verify that a ready cWBTC channel is active before signing invoice
      const finalChannelCheck = await node.listChannels({});
      const hasConfirmedReadyChannel = (finalChannelCheck?.channels ?? []).some((ch) => {
        return normalizeChannelStateName(ch.state?.state_name) === 'CHANNELREADY' && isCwbtcChannel(ch);
      });
      if (!hasConfirmedReadyChannel) {
        throw new Error('No ready cWBTC channel found. A channel must be open to receive funds.');
      }

      // Step 4: Obtain fresh authoritative quote
      setStep('creating_invoice');
      setProgressTitle('Generating Swap Invoices');
      setProgressMessage('Signing Fiber invoice and preparing Lightning payment…');

      const activeQuote = await api.quote(parsedTarget.raw.toString());
      setQuote(activeQuote);

      // Step 5: Sign Fiber invoice
      const invoice = await node.newInvoice({
        amount: toHex(BigInt(activeQuote.receive_raw)),
        currency: 'Fibt',
        udt_type_script: CWBTC_SCRIPT,
        hash_algorithm: 'sha256',
        final_expiry_delta: toHex(FIBER_INVOICE_FINAL_EXPIRY_DELTA_MS),
        description: 'CKB On-ramp: BTC to cWBTC',
      });

      // Step 6: Create CCH order on backend
      setStep('creating_order');
      const newOrder = await api.createOrder(
        {
          fiber_invoice: invoice.invoice_address,
          quote_id: activeQuote.quote_id,
        },
        crypto.randomUUID(),
      );

      // Save order & receipt
      setOrder(newOrder);
      localStorage.setItem(LAST_ORDER_KEY, JSON.stringify(newOrder));
      const receipt = orderToReceipt(newOrder, channelId);
      const updatedReceipts = saveReceipt(receipt);
      setReceipts(updatedReceipts);

      clearChannelTicket();

      // Transition to Settlement modal
      setStep('awaiting_payment');
      setIsProgressOpen(false);
      setIsSettlementOpen(true);
    } catch (err) {
      setStep('failed');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('501') || msg.includes('OPERATOR_CKB_PRIVATE_KEY')) {
        setError(
          'Testnet Liquidity Provider Offline: The testnet operator has not configured sponsored capacity (OPERATOR_CKB_PRIVATE_KEY is unset). In testnet environments, this means the faucet/operator node is awaiting configuration.',
        );
      } else if (msg.includes('cancelled') || msg.includes('NotAllowedError')) {
        setError('Passkey authorization was cancelled. Please click Swap again when ready to authorize.');
      } else {
        setError(msg);
      }
    }
  }, [parsedTarget.raw, ensureNodeRunning, health?.mode, health?.can_receive, health?.unavailable_reason]);

  const resetSwap = useCallback(() => {
    clearChannelTicket();
    setOrder(null);
    setStep('idle');
    setError(null);
    setIsSettlementOpen(false);
    setIsProgressOpen(false);
    localStorage.removeItem(LAST_ORDER_KEY);
  }, []);

  return {
    inputMode,
    setInputMode,
    payAmount,
    setPayAmount,
    receiveAmount,
    setReceiveAmount,
    touched,
    setTouched,
    parsedTarget,
    quote,
    isQuoting,
    quoteError,
    step,
    progressTitle,
    progressMessage,
    order,
    error,
    setError,
    health,
    operatorNode,
    cwbtcBalanceRaw,
    cwbtcBalance: formatCwbtc(cwbtcBalanceRaw.toString()),
    receipts,
    setReceipts,
    isSettlementOpen,
    setIsSettlementOpen,
    isProgressOpen,
    setIsProgressOpen,
    isHistoryOpen,
    setIsHistoryOpen,
    isAccountOpen,
    setIsAccountOpen,
    initiateSwap,
    resetSwap,
    refreshBalance,
    connectNode,
    ensureNodeRunning,
    viewReceipt,
    fiber,
  };
}
