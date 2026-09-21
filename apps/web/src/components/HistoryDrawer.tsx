import { useState } from 'react';
import type { useSwap } from '../useSwap';
import { clearAllReceipts } from '../receipts';
import { CheckIcon, CloseIcon, CopyIcon, HistoryIcon } from './Icons';

interface HistoryDrawerProps {
  swap: ReturnType<typeof useSwap>;
}

function shorten(value: string, head = 8, tail = 6) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function timeAgo(timestamp: number) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function HistoryDrawer({ swap }: HistoryDrawerProps) {
  const { receipts, setReceipts, isHistoryOpen, setIsHistoryOpen, viewReceipt } = swap;
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  if (!isHistoryOpen) return null;

  const handleCopy = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(() => setCopiedHash(null), 1800);
    } catch {
      // ignore
    }
  };

  const handleClear = () => {
    if (window.confirm('Clear all local transaction receipts?')) {
      clearAllReceipts();
      setReceipts([]);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-dialog history-dialog">
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="history-title-row">
              <HistoryIcon width="18" height="18" />
              <h3 className="modal-title">Recent Transactions</h3>
            </div>
            <span className="modal-kicker">LOCAL DEVICE RECEIPTS</span>
          </div>

          <button
            type="button"
            className="modal-close-button"
            onClick={() => setIsHistoryOpen(false)}
            aria-label="Close"
          >
            <CloseIcon width="20" height="20" />
          </button>
        </div>

        <div className="history-content">
          {receipts.length === 0 ? (
            <div className="history-empty-state">
              <HistoryIcon width="36" height="36" className="empty-icon" />
              <h4>No transactions yet</h4>
              <p>Your swap receipts and settled payments will be recorded here.</p>
            </div>
          ) : (
            <div className="receipts-list">
              {receipts.map((r) => {
                const isSuccess = r.status === 'Success' || r.status === 'OutgoingSuccess';
                const isPending =
                  r.status === 'Pending' ||
                  r.status === 'IncomingAccepted' ||
                  r.status === 'OutgoingInFlight';

                return (
                  <div key={r.paymentHash} className="receipt-item-card">
                    <div className="receipt-item-header">
                      <div className="receipt-time">{timeAgo(r.createdAt)}</div>
                      <span
                        className={`receipt-status-pill ${
                          isSuccess ? 'success' : isPending ? 'pending' : 'failed'
                        }`}
                      >
                        {isSuccess ? 'SETTLED' : isPending ? 'PENDING' : r.status.toUpperCase()}
                      </span>
                    </div>

                    <div className="receipt-amounts-row">
                      <div className="amount-col">
                        <span className="col-label">Paid</span>
                        <span className="col-val">{r.paySats.toLocaleString()} sats</span>
                      </div>
                      <div className="amount-arrow">➔</div>
                      <div className="amount-col">
                        <span className="col-label">Received</span>
                        <span className="col-val bold-text">+{r.receiveCwbtc} cWBTC</span>
                      </div>
                    </div>

                    <div className="receipt-item-footer">
                      <button
                        type="button"
                        className="receipt-hash-btn"
                        onClick={() => void handleCopy(r.paymentHash)}
                        title="Click to copy payment hash"
                      >
                        <span>{shorten(r.paymentHash)}</span>
                        {copiedHash === r.paymentHash ? (
                          <CheckIcon width="12" height="12" />
                        ) : (
                          <CopyIcon width="12" height="12" />
                        )}
                      </button>

                      {isPending && (
                        <button
                          type="button"
                          className="pay-pending-btn"
                          onClick={() => {
                            viewReceipt(r);
                          }}
                        >
                          View Invoice →
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {receipts.length > 0 && (
          <div className="history-footer">
            <button type="button" className="clear-history-btn" onClick={handleClear}>
              Clear Receipts
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
