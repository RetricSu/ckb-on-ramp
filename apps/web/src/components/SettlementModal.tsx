import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import type { useSwap } from '../useSwap';
import { formatCwbtc } from '../amount';
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  ExternalLinkIcon,
  SpinnerIcon,
} from './Icons';

interface SettlementModalProps {
  swap: ReturnType<typeof useSwap>;
}

function shorten(value: string, head = 10, tail = 8) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function SettlementModal({ swap }: SettlementModalProps) {
  const {
    order,
    isSettlementOpen,
    setIsSettlementOpen,
    setIsHistoryOpen,
    resetSwap,
    refreshBalance,
  } = swap;

  const [qrUrl, setQrUrl] = useState<string>('');
  const [copiedInvoice, setCopiedInvoice] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [copiedHash, setCopiedHash] = useState(false);
  const [geekExpanded, setGeekExpanded] = useState(false);

  // Generate QR Code data URL when order invoice changes
  useEffect(() => {
    if (!order?.lightning_invoice) return;

    QRCode.toDataURL(order.lightning_invoice.toUpperCase(), {
      width: 240,
      margin: 1,
      color: {
        dark: '#111827',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => setQrUrl(url))
      .catch((err) => console.error('Failed to generate QR Code:', err));
  }, [order?.lightning_invoice]);

  const lndCommand = useMemo(() => {
    return order ? `lncli payinvoice --pay_req="${order.lightning_invoice}"` : '';
  }, [order]);

  const copyText = async (
    text: string,
    setter: React.Dispatch<React.SetStateAction<boolean>>,
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      setTimeout(() => setter(false), 2000);
    } catch {
      // fallback
    }
  };

  if (!isSettlementOpen || !order) return null;

  const isSuccess = order.status === 'Success' || order.status === 'OutgoingSuccess';
  const isExpired = order.status === 'Expired';
  const isFailed = order.status === 'Failed';

  const createdTimeFormatted = order.created_at
    ? new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-dialog settlement-dialog">
        <div className="modal-header">
          <div className="modal-title-group">
            <h3 id="modal-title" className="modal-title">
              {isSuccess ? 'Swap Settled' : 'Pay with Lightning'}
            </h3>
            <span className="modal-kicker">
              {isSuccess ? 'OFF-CHAIN ASSET RECEIVED' : 'CROSS-CHAIN SETTLEMENT'}
            </span>
          </div>

          <button
            type="button"
            className="modal-close-button"
            onClick={() => setIsSettlementOpen(false)}
            aria-label="Close modal"
          >
            <CloseIcon width="20" height="20" />
          </button>
        </div>

        {/* Success View */}
        {isSuccess ? (
          <div className="settlement-success-view">
            <div className="success-badge-circle">
              <CheckIcon width="36" height="36" className="success-check-icon" />
            </div>

            <h4 className="success-headline">Payment Received!</h4>
            <p className="success-description">
              You swapped <strong>{order.pay_sats.toLocaleString()} sats</strong> for{' '}
              <strong className="cwb-amount">+{formatCwbtc(order.receive_raw)} cWBTC</strong>.
            </p>

            <div className="receipt-summary-card">
              <div className="receipt-summary-row">
                <span className="summary-label">Received Asset</span>
                <span className="summary-value bold-text">
                  {formatCwbtc(order.receive_raw)} cWBTC
                </span>
              </div>
              <div className="receipt-summary-row">
                <span className="summary-label">Paid via Lightning</span>
                <span className="summary-value">{order.pay_sats.toLocaleString()} sats</span>
              </div>
              <div className="receipt-summary-row">
                <span className="summary-label">Routing & Fee</span>
                <span className="summary-value">{order.fee_sats.toLocaleString()} sats</span>
              </div>
              <div className="receipt-summary-row">
                <span className="summary-label">Payment Hash</span>
                <button
                  type="button"
                  className="hash-copy-button"
                  onClick={() => void copyText(order.payment_hash, setCopiedHash)}
                  title="Click to copy hash"
                >
                  <span>{shorten(order.payment_hash)}</span>
                  {copiedHash ? <CheckIcon width="12" height="12" /> : <CopyIcon width="12" height="12" />}
                </button>
              </div>
              <div className="receipt-summary-row">
                <span className="summary-label">Settlement Mode</span>
                <span className="summary-value green-text">Fiber Channel Local Hop</span>
              </div>
            </div>

            <div className="success-actions">
              <button
                type="button"
                className="button primary full-width"
                onClick={() => {
                  resetSwap();
                  void refreshBalance();
                }}
              >
                Make Another Swap
              </button>
              <button
                type="button"
                className="button secondary full-width"
                onClick={() => {
                  setIsSettlementOpen(false);
                  setIsHistoryOpen(true);
                }}
              >
                View in Receipts
              </button>
            </div>
          </div>
        ) : isExpired || isFailed ? (
          /* Expired or Failed View */
          <div className="settlement-failed-view">
            <div className="failed-badge-circle">
              <CloseIcon width="32" height="32" className="failed-icon" />
            </div>
            <h4 className="failed-headline">
              {isExpired ? 'Invoice Expired' : 'Payment Failed'}
            </h4>
            <p className="failed-description">
              {isExpired
                ? 'The invoice expired before settlement was detected. No funds were deducted.'
                : order.failure_reason || 'The Lightning payment or Fiber routing failed to settle.'}
            </p>
            <button
              type="button"
              className="button primary full-width"
              onClick={() => {
                resetSwap();
              }}
            >
              Start New Swap
            </button>
          </div>
        ) : (
          /* Active Payment View */
          <div className="settlement-payment-view">
            {/* Live Status Pill */}
            <div className="live-status-pill">
              <span className="pulsing-radar-ring" />
              <span className="status-label">
                {order.status === 'IncomingAccepted'
                  ? 'Payment received! Forwarding via Fiber…'
                  : order.status === 'OutgoingInFlight'
                    ? 'Settling cWBTC to browser node…'
                    : 'Watching for payment on Lightning…'}
              </span>
            </div>

            {/* Amount Spotlight */}
            <div className="amount-spotlight">
              <div className="spotlight-sats">
                <span>{order.pay_sats.toLocaleString()}</span>
                <small>sats</small>
              </div>
              <span className="spotlight-btc">
                ≈ {(order.pay_sats / 100_000_000).toFixed(8)} BTC
              </span>
            </div>

            {/* QR Code */}
            <div
              className="qr-wrapper"
              onClick={() => void copyText(order.lightning_invoice, setCopiedInvoice)}
              title="Click QR Code to copy invoice"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  void copyText(order.lightning_invoice, setCopiedInvoice);
                }
              }}
            >
              {qrUrl ? (
                <img src={qrUrl} alt="Lightning BOLT11 Invoice QR Code" className="qr-image" />
              ) : (
                <div className="qr-placeholder">
                  <SpinnerIcon width="32" height="32" />
                </div>
              )}
              <span className="qr-tap-hint">
                {copiedInvoice ? '✓ Copied Invoice!' : 'Click QR to copy invoice'}
              </span>
            </div>

            {createdTimeFormatted && (
              <div className="created-time-note">
                <span>Created at {createdTimeFormatted} · Standard BOLT11 invoice</span>
              </div>
            )}

            {/* Invoice Action Bar */}
            <div className="invoice-action-box">
              <div className="invoice-preview-text" title={order.lightning_invoice}>
                {shorten(order.lightning_invoice, 18, 14)}
              </div>

              <div className="invoice-buttons-row">
                <button
                  type="button"
                  className="button primary copy-invoice-btn"
                  onClick={() => void copyText(order.lightning_invoice, setCopiedInvoice)}
                >
                  {copiedInvoice ? (
                    <>
                      <CheckIcon width="16" height="16" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon width="16" height="16" />
                      <span>Copy Invoice</span>
                    </>
                  )}
                </button>

                <a
                  href={`lightning:${order.lightning_invoice}`}
                  className="button secondary open-wallet-btn"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLinkIcon width="14" height="14" />
                  <span>Open in Wallet</span>
                </a>
              </div>
            </div>

            {/* Geek / lncli CLI command drawer */}
            <div className="geek-drawer">
              <button
                type="button"
                className="geek-toggle-button"
                onClick={() => setGeekExpanded((prev) => !prev)}
                aria-expanded={geekExpanded}
              >
                <span>Terminal lncli command</span>
                <span className={`geek-chevron ${geekExpanded ? 'expanded' : ''}`}>
                  <ChevronDownIcon width="14" height="14" />
                </span>
              </button>

              {geekExpanded && (
                <div className="geek-content">
                  <pre className="geek-pre">
                    <code>{lndCommand}</code>
                  </pre>
                  <button
                    type="button"
                    className="geek-copy-button"
                    onClick={() => void copyText(lndCommand, setCopiedCommand)}
                  >
                    {copiedCommand ? (
                      <>
                        <CheckIcon width="14" height="14" />
                        <span>Command Copied</span>
                      </>
                    ) : (
                      <>
                        <CopyIcon width="14" height="14" />
                        <span>Copy Command</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            <p className="settlement-footnote">
              Pay from Phoenix, Zeus, LND, CashApp, Blink, or any Lightning wallet. Keep this tab
              open until settlement is confirmed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
