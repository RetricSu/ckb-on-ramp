import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HealthResponse, NodeInfo, Quote, SwapOrder } from '@ckb-on-ramp/contracts';
import type { Channel, FiberBrowserNode } from '@fiber-pay/sdk/browser';
import { ApiError, api } from './api';
import { formatCwbtc, parseCwbtc, toHex } from './amount';
import { CWBTC_SCRIPT, useFiber } from './FiberProvider';
import { normalizeChannelStateName, waitForCwbtcChannelReady } from './channels';
import { prepareReceiveRoute } from './peer';
import { loadReceipts, orderToReceipt, saveReceipt, updateReceiptStatus } from './receipts';
import type { SwapReceipt, SwapStep } from './types';

const LAST_ORDER_KEY = 'ckb-on-ramp:last-order';
// Fiber invoice final_expiry_delta is milliseconds. Node min is 9_600_000 (160 min);
// CCH also requires it < half of BTC CLTV (~108_000_000 ms). 24h sits in that window.
const FIBER_INVOICE_FINAL_EXPIRY_DELTA_MS = 86_400_000n;

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
          setOrder((prev) => (prev ? { ...prev, status: 'Expired' } : null));
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
  const ensureNodeRunning = useCallback(async (): Promise<FiberBrowserNode> => {
    if (fiberRef.current.isRunning && fiberRef.current.node) {
      return fiberRef.current.node;
    }

    setProgressTitle('Authorizing Local Wallet');
    setProgressMessage('Authorizing browser Fiber node via Passkey. Your keys stay in this browser.');

    // Check passkey support before attempting
    if (!fiberRef.current.isPasskeySupported && !fiberRef.current.hasPasskeyConfigured) {
      const reason =
        fiberRef.current.passkeyUnavailableReason ||
        'Passkeys / WebAuthn are not supported in this browser. Please use a modern browser with WebAuthn.';
      throw new Error(reason);
    }

    if (fiberRef.current.hasPasskeyConfigured) {
      await fiberRef.current.startWithPasskey();
    } else {
      await fiberRef.current.createPasskeyAndStart('CKB On-ramp user');
    }

    // Poll fiberRef.current with immediate error checking
    const maxWait = 20_000;
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
  }, []);

  // Shared connect action for Navbar
  const connectNode = useCallback(async () => {
    setError(null);
    try {
      await ensureNodeRunning();
      void refreshBalance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    }
  }, [ensureNodeRunning, refreshBalance]);

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
          setStep('provisioning_channel');
          setProgressTitle('Opening Sponsored Channel');
          setProgressMessage('Initiating channel with operator external funding…');

          const opInfo = route.operatorNode;
          if (!opInfo.funding_lock_script) {
            throw new Error('Operator node did not advertise a funding_lock_script for external funding.');
          }

          const ensureHex = (val: string): `0x${string}` => (val.startsWith('0x') ? val : `0x${val}`) as `0x${string}`;

          const openResult = await node.openChannelWithExternalFunding({
            pubkey: ensureHex(opInfo.node_id),
            funding_amount: '0x0',
            funding_udt_type_script: CWBTC_SCRIPT,
            shutdown_script: nodeInfo.default_funding_lock_script ?? undefined,
            funding_lock_script: {
              code_hash: ensureHex(opInfo.funding_lock_script.code_hash),
              hash_type: opInfo.funding_lock_script.hash_type,
              args: ensureHex(opInfo.funding_lock_script.args),
            },
          });

          channelId = openResult.channel_id;

          setProgressTitle('Signing Channel Transaction');
          setProgressMessage('Requesting operator signature for funding capacity…');

          let signResult;
          try {
            signResult = await api.signFunding({
              channel_id: openResult.channel_id,
              unsigned_funding_tx: openResult.unsigned_funding_tx,
            });
          } catch (signErr) {
            // Allow sub-second window between FNN accept and API session state update
            if (signErr instanceof ApiError && signErr.message.includes('not associated with an accepted bootstrap session')) {
              await new Promise((r) => setTimeout(r, 1500));
              signResult = await api.signFunding({
                channel_id: openResult.channel_id,
                unsigned_funding_tx: openResult.unsigned_funding_tx,
              });
            } else {
              throw signErr;
            }
          }

          setProgressTitle('Submitting Funding Transaction');
          setProgressMessage('Submitting signed funding transaction to network…');

          const submitResult = await node.submitSignedFundingTx({
            channel_id: openResult.channel_id,
            signed_funding_tx: signResult.signed_funding_tx as Record<string, unknown>,
          });

          const finalExpectedChannelId = submitResult?.channel_id ?? openResult.channel_id;
          channelId = finalExpectedChannelId;

          setProgressTitle('Confirming Inbound Channel');
          setProgressMessage('Funding transaction submitted. Waiting for on-chain confirmation…');

          channelId = await waitForCwbtcChannelReady({
            node,
            sessionId: route.session_id,
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
  }, [parsedTarget.raw, ensureNodeRunning, health?.mode]);

  const resetSwap = useCallback(() => {
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
    viewReceipt,
    fiber,
  };
}
