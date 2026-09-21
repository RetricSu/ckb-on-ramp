import { useState } from 'react';
import type { useSwap } from '../useSwap';
import { CheckIcon, CloseIcon, CopyIcon, KeyIcon, WalletIcon } from './Icons';

interface AccountModalProps {
  swap: ReturnType<typeof useSwap>;
}

function shorten(value: string, head = 12, tail = 10) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function AccountModal({ swap }: AccountModalProps) {
  const { fiber, cwbtcBalance, isAccountOpen, setIsAccountOpen } = swap;
  const [copiedKey, setCopiedKey] = useState(false);

  if (!isAccountOpen) return null;

  const pubkey = fiber.nodeInfo?.pubkey ?? '';

  const handleCopyKey = async () => {
    if (!pubkey) return;
    try {
      await navigator.clipboard.writeText(pubkey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleDisconnect = async () => {
    try {
      await fiber.stop();
      setIsAccountOpen(false);
    } catch (err) {
      console.warn('Stop node error:', err);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-dialog account-dialog">
        <div className="modal-header">
          <div className="modal-title-group">
            <h3 className="modal-title">Browser Fiber Node</h3>
            <span className="modal-kicker">LOCAL WALLET STATUS</span>
          </div>

          <button
            type="button"
            className="modal-close-button"
            onClick={() => setIsAccountOpen(false)}
            aria-label="Close"
          >
            <CloseIcon width="20" height="20" />
          </button>
        </div>

        <div className="account-modal-content">
          <div className="account-balance-card">
            <span className="card-label">Available cWBTC Balance</span>
            <div className="card-balance-number">
              <strong>{cwbtcBalance}</strong>
              <small>cWBTC</small>
            </div>
            <span className="card-balance-sub">Off-chain capacity in local Fiber channel</span>
          </div>

          <div className="account-details-list">
            <div className="account-detail-item">
              <span className="detail-item-label">Node Public Key</span>
              <div className="key-copy-row">
                <code className="pubkey-code">{pubkey ? shorten(pubkey) : 'Unavailable'}</code>
                {pubkey && (
                  <button
                    type="button"
                    className="button-icon-copy"
                    onClick={() => void handleCopyKey()}
                    title="Copy full public key"
                  >
                    {copiedKey ? <CheckIcon width="14" height="14" /> : <CopyIcon width="14" height="14" />}
                  </button>
                )}
              </div>
            </div>

            <div className="account-detail-item">
              <span className="detail-item-label">Protection Mode</span>
              <span className="detail-item-val">
                <KeyIcon width="14" height="14" />
                Passkey (WebAuthn / Local Biometrics)
              </span>
            </div>

            <div className="account-detail-item">
              <span className="detail-item-label">Network</span>
              <span className="detail-item-val green-text">CKB Fiber Testnet</span>
            </div>

            <div className="account-detail-item">
              <span className="detail-item-label">Node Status</span>
              <span className="detail-item-val">
                <span className="live-dot" />
                {fiber.isRunning ? 'Active & Listening' : 'Offline'}
              </span>
            </div>
          </div>

          <div className="account-actions">
            <button
              type="button"
              className="button secondary full-width disconnect-btn"
              onClick={() => void handleDisconnect()}
            >
              Lock / Disconnect Node
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
