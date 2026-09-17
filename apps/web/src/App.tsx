import { useCallback, useEffect, useMemo, useState } from 'react';
import { FiberNodeButton } from '@fiber-pay/react';
import type { BootstrapSession, HealthResponse, Quote, SwapOrder } from '@ckb-on-ramp/contracts';
import { ApiError, api } from './api';
import { formatCwbtc, parseCwbtc, toHex } from './amount';
import { CWBTC_ASSET, CWBTC_SCRIPT, FiberProvider, useFiber } from './FiberProvider';

type Busy = 'bootstrap' | 'quote' | 'order' | null;

function shorten(value: string, head = 12, tail = 8) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function loadStoredOrder(): SwapOrder | null {
  try {
    const value = localStorage.getItem('ckb-on-ramp:last-order');
    if (!value) return null;
    const order = JSON.parse(value) as Partial<SwapOrder>;
    return order.payment_hash && order.lightning_invoice ? order as SwapOrder : null;
  } catch {
    return null;
  }
}

function Workbench() {
  const fiber = useFiber();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapSession | null>(null);
  const [amount, setAmount] = useState('0.000001');
  const [touched, setTouched] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [order, setOrder] = useState<SwapOrder | null>(loadStoredOrder);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [copied, setCopied] = useState<'invoice' | 'command' | null>(null);

  useEffect(() => { void api.health().then(setHealth).catch(() => setHealth(null)); }, []);
  useEffect(() => {
    if (!order || pollingStopped || ['Success', 'Failed', 'Expired'].includes(order.status)) return;
    const timer = window.setInterval(() => {
      void api.getOrder(order.payment_hash).then((next) => {
        setOrder(next);
        localStorage.setItem('ckb-on-ramp:last-order', JSON.stringify(next));
      }).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        if (reason instanceof ApiError && reason.status === 404) setPollingStopped(true);
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [order?.payment_hash, order?.status, pollingStopped]);

  const clearOrder = () => {
    setOrder(null); setPollingStopped(false);
    localStorage.removeItem('ckb-on-ramp:last-order');
  };

  const parsed = useMemo(() => {
    try { return { raw: parseCwbtc(amount), error: null }; }
    catch (reason) { return { raw: null, error: reason instanceof Error ? reason.message : String(reason) }; }
  }, [amount]);
  const nodePubkey = fiber.nodeInfo?.pubkey;
  const routeReady = bootstrap?.status === 'ready';
  const canQuote = routeReady && parsed.raw !== null && !busy;

  const run = useCallback(async (kind: Exclude<Busy, null>, operation: () => Promise<void>) => {
    setBusy(kind); setError(null);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  }, []);

  const prepareRoute = () => run('bootstrap', async () => {
    if (!nodePubkey) throw new Error('Start the browser Fiber node before preparing a receive route.');
    const next = await api.bootstrap(nodePubkey); setBootstrap(next);
    if (next.status !== 'ready') throw new Error(next.message);
  });
  const requestQuote = () => run('quote', async () => {
    if (!parsed.raw) throw new Error('Enter a valid cWBTC amount.');
    setQuote(await api.quote(parsed.raw.toString())); clearOrder();
  });
  const createOrder = () => run('order', async () => {
    if (!fiber.node || !quote) throw new Error('The Fiber node and quote must both be ready.');
    const invoice = await fiber.node.newInvoice({
      amount: toHex(BigInt(quote.receive_raw)), currency: 'Fibt', udt_type_script: CWBTC_SCRIPT,
      hash_algorithm: 'sha256', final_expiry_delta: toHex(86_400n),
      description: 'CKB On-ramp: BTC to cWBTC',
    });
    const next = await api.createOrder({ fiber_invoice: invoice.invoice_address, quote_id: quote.quote_id }, crypto.randomUUID());
    setPollingStopped(false); setOrder(next); localStorage.setItem('ckb-on-ramp:last-order', JSON.stringify(next));
  });
  const copy = async (kind: 'invoice' | 'command', text: string) => {
    await navigator.clipboard.writeText(text); setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  };
  const reset = () => { setQuote(null); clearOrder(); setError(null); };
  const lndCommand = order ? `lncli payinvoice --pay_req="${order.lightning_invoice}"` : '';

  return (
    <>
      <header className="nav">
        <a className="wordmark" href="#main" aria-label="CKB On-ramp home">CKB / ON-RAMP</a>
        <FiberNodeButton fiber={fiber} network="testnet" strategy="passkey" passkeyUsername="CKB On-ramp user" asset={CWBTC_ASSET} className="node-button" />
      </header>
      <main id="main" className="shell">
        <section className="intro">
          <div>
            <p className="kicker">TESTNET · {health?.mode?.toUpperCase() ?? 'API OFFLINE'}</p>
            <h1>BTC in. Your first CKB asset out.</h1>
          </div>
          <p className="lede">Create a Fiber node in this browser, pay one Lightning invoice from your own LND, and receive cWBTC without opening an exchange account.</p>
        </section>

        {health?.mode === 'mock' && <div className="notice" role="status"><strong>Mock operator.</strong> The browser node is real; inbound liquidity and CCH settlement are simulated.</div>}

        <div className="workbench">
          <ol className="steps" aria-label="Deposit steps">
            <li className={fiber.isRunning ? 'complete' : 'active'}><span>1</span><div><strong>Start node</strong><small>Passkey-protected in this browser</small></div></li>
            <li className={routeReady ? 'complete' : fiber.isRunning ? 'active' : ''}><span>2</span><div><strong>Prepare route</strong><small>Provider supplies inbound liquidity</small></div></li>
            <li className={quote ? 'complete' : routeReady ? 'active' : ''}><span>3</span><div><strong>Set amount</strong><small>Review amount and operator fee</small></div></li>
            <li className={order ? 'active' : ''}><span>4</span><div><strong>Pay from LND</strong><small>Keys and macaroon stay with you</small></div></li>
          </ol>

          <section className="panel" aria-live="polite">
            <div className="panel-heading">
              <div><h2>Receive cWBTC</h2><p>The node invoice and Lightning invoice share one SHA-256 payment hash.</p></div>
              <span className={`status ${fiber.isRunning ? 'status-success' : ''}`}>{fiber.isRunning ? 'NODE READY' : 'NODE OFFLINE'}</span>
            </div>

            <dl className="node-facts">
              <div><dt>Browser node</dt><dd>{nodePubkey ? shorten(nodePubkey) : 'Create with the button above'}</dd></div>
              <div><dt>Receive route</dt><dd>{routeReady ? 'Ready' : 'Not prepared'}</dd></div>
            </dl>

            {!routeReady && (
              <div className="action-block">
                <p>A fresh node cannot receive until a service peer opens or provisions a route with inbound UDT liquidity.</p>
                <button className="button primary" onClick={() => void prepareRoute()} disabled={!fiber.isRunning || busy !== null}>
                  {busy === 'bootstrap' ? 'Preparing…' : 'Prepare receive route'}
                </button>
                {!fiber.isRunning && <p className="helper">Start the Fiber node first. Its private key remains browser-side.</p>}
              </div>
            )}

            {routeReady && !order && (
              <div className="form-block">
                <label htmlFor="amount">cWBTC to receive</label>
                <div className="amount-row">
                  <input id="amount" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setQuote(null); }} onBlur={() => setTouched(true)} aria-invalid={touched && !!parsed.error} aria-describedby="amount-help" />
                  <span>cWBTC</span>
                </div>
                <p id="amount-help" className={touched && parsed.error ? 'helper error' : 'helper'}>{touched && parsed.error ? parsed.error : 'cWBTC uses 8 decimals. One raw unit maps to one sat in the current CCH model.'}</p>
                {!quote ? (
                  <button className="button primary" onClick={() => void requestQuote()} disabled={!canQuote}>{busy === 'quote' ? 'Quoting…' : 'Review quote'}</button>
                ) : (
                  <div className="quote">
                    <dl><div><dt>You receive</dt><dd>{formatCwbtc(quote.receive_raw)} cWBTC</dd></div><div><dt>You pay</dt><dd>{quote.pay_sats.toLocaleString()} sats</dd></div><div><dt>Operator fee</dt><dd>{quote.fee_sats.toLocaleString()} sats</dd></div></dl>
                    <div className="quote-actions">
                      <button className="button primary" onClick={() => void createOrder()} disabled={busy !== null}>{busy === 'order' ? 'Creating invoice…' : 'Create Lightning invoice'}</button>
                      <button className="button secondary" onClick={() => setQuote(null)} disabled={busy !== null}>Change amount</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {order && (
              <div className="payment-block">
                <div className="payment-status"><span className={`status ${order.status === 'Success' ? 'status-success' : ''}`}>{order.status.toUpperCase()}</span><span>{order.pay_sats.toLocaleString()} sats</span></div>
                <label>Lightning invoice</label>
                <code className="invoice">{order.lightning_invoice}</code>
                <div className="button-row">
                  <button className="button primary" onClick={() => void copy('invoice', order.lightning_invoice)}>{copied === 'invoice' ? 'Copied' : 'Copy invoice'}</button>
                  <button className="button secondary" onClick={() => void copy('command', lndCommand)}>{copied === 'command' ? 'Copied' : 'Copy lncli command'}</button>
                </div>
                <pre><code>{lndCommand}</code></pre>
                <p className="helper">Run this on the machine that owns your LND credentials. Keep this tab and the Fiber node open until settlement. Never paste a macaroon or seed into this site.</p>
                {order.status === 'Success' && <div className="success-message"><strong>Settlement complete.</strong><span>{formatCwbtc(order.receive_raw)} cWBTC was paid to the Fiber invoice created by this browser node.</span></div>}
                {['Success', 'Failed', 'Expired'].includes(order.status) && <button className="button secondary" onClick={reset}>Start another deposit</button>}
              </div>
            )}
            {error && <div className="error-box" role="alert"><strong>The step did not complete.</strong><span>{error}</span>{pollingStopped && <button className="button secondary" onClick={reset}>Discard saved order</button>}</div>}
          </section>
        </div>

        <section className="trust">
          <h2>What stays where</h2>
          <dl><div><dt>In your browser</dt><dd>Fiber identity, invoice signing, local node storage.</dd></div><div><dt>On your LND machine</dt><dd>Bitcoin keys, macaroon, TLS credentials, payment approval.</dd></div><div><dt>With the operator</dt><dd>Quote, public Fiber node id, channel provisioning, CCH order status.</dd></div></dl>
        </section>
      </main>
      <footer><p>CKB On-ramp · Testnet scaffold · No custody of LND credentials</p></footer>
    </>
  );
}

export function App() { return <FiberProvider><Workbench /></FiberProvider>; }
