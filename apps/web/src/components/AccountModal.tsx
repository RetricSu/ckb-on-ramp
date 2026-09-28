import { useState } from 'react';
import type { useSwap } from '../useSwap';
import { connectCccWallet, type ConnectedCccWallet } from '../cccWallet';
import {
  CLOSE_ERRORS,
  L1_SETTLEMENT_COPY,
  closeChannelToWallet,
  humanizeCloseError,
  waitForCkbTxCommitted,
  type CloseToWalletResult,
  type FiberLockScript,
} from '../closeToWallet';
import { CheckIcon, CloseIcon, CopyIcon, KeyIcon, SpinnerIcon, WalletIcon } from './Icons';

interface AccountModalProps {
  swap: ReturnType<typeof useSwap>;
}

function shorten(value: string, head = 12, tail = 10) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function AccountModal({ swap }: AccountModalProps) {
  const { fiber, cwbtcBalance, isAccountOpen, setIsAccountOpen, refreshBalance } = swap;
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedTx, setCopiedTx] = useState(false);
  const [wallet, setWallet] = useState<ConnectedCccWallet | null>(null);
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [closeProgress, setCloseProgress] = useState('');
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<CloseToWalletResult | null>(null);

  if (!isAccountOpen) return null;

  const pubkey = fiber.nodeInfo?.pubkey ?? '';
  const nodeDefaultLock = fiber.nodeInfo?.default_funding_lock_script as FiberLockScript | undefined;

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

  const handleCopyTx = async () => {
    if (!closeResult?.txHash) return;
    try {
      await navigator.clipboard.writeText(closeResult.txHash);
      setCopiedTx(true);
      setTimeout(() => setCopiedTx(false), 2000);
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

  const handleConnectWallet = async () => {
    setCloseError(null);
    setCloseResult(null);
    setIsConnectingWallet(true);
    try {
      const connected = await connectCccWallet();
      setWallet(connected);
    } catch (err) {
      setWallet(null);
      setCloseError(humanizeCloseError(err));
    } finally {
      setIsConnectingWallet(false);
    }
  };

  const handleCloseToWallet = async () => {
    setCloseError(null);
    setCloseResult(null);
    if (!wallet) {
      setCloseError(CLOSE_ERRORS.NO_WALLET);
      return;
    }
    const node = fiber.node;
    if (!fiber.isRunning || !node) {
      setCloseError(CLOSE_ERRORS.NO_NODE);
      return;
    }
    setIsClosing(true);
    setCloseProgress('Asking the Fiber node to close the channel to your wallet…');
    try {
      const result = await closeChannelToWallet({
        walletLock: wallet.lock,
        address: wallet.address,
        nodeRunning: fiber.isRunning,
        node,
        nodeDefaultLock,
        waitForTx: async (txHash) => {
          setCloseProgress('Close transaction broadcast. Waiting for CKB confirmation…');
          await waitForCkbTxCommitted(txHash);
        },
      });
      setCloseResult(result);
      setCloseProgress('');
      void refreshBalance();
    } catch (err) {
      setCloseError(humanizeCloseError(err));
      setCloseProgress('');
    } finally {
      setIsClosing(false);
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

          <div className="l1-withdraw-card">
            <span className="card-label">Withdraw to CKB L1</span>
            <p className="l1-note">{L1_SETTLEMENT_COPY}</p>

            {wallet ? (
              <div className="l1-wallet-row">
                <span className="detail-item-label">CCC wallet</span>
                <code className="pubkey-code" title={wallet.address}>
                  {shorten(wallet.address, 10, 8)}
                </code>
              </div>
            ) : (
              <p className="l1-note">Connect UniSat (or another injected CCC wallet). JoyID is not available in this isolated page.</p>
            )}

            {closeResult && (
              <div className="l1-success">
                <span className="card-label">Settled on CKB L1</span>
                <div className="key-copy-row">
                  <code className="pubkey-code" title={closeResult.txHash}>
                    {shorten(closeResult.txHash)}
                  </code>
                  <button
                    type="button"
                    className="button-icon-copy"
                    onClick={() => void handleCopyTx()}
                    title="Copy transaction hash"
                  >
                    {copiedTx ? <CheckIcon width="14" height="14" /> : <CopyIcon width="14" height="14" />}
                  </button>
                </div>
                <p className="l1-note">Address: {shorten(closeResult.address, 10, 8)}</p>
              </div>
            )}

            {closeProgress && (
              <p className="l1-progress">
                <SpinnerIcon width="14" height="14" className="spin" />
                <span>{closeProgress}</span>
              </p>
            )}

            {closeError && <p className="l1-error">{closeError}</p>}

            <div className="l1-actions">
              {!wallet ? (
                <button
                  type="button"
                  className="button primary full-width"
                  onClick={() => void handleConnectWallet()}
                  disabled={isConnectingWallet || isClosing}
                >
                  {isConnectingWallet ? (
                    <>
                      <SpinnerIcon width="14" height="14" className="spin" />
                      <span>Connecting wallet…</span>
                    </>
                  ) : (
                    <>
                      <WalletIcon width="16" height="16" />
                      <span>Connect CKB wallet</span>
                    </>
                  )}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="button primary full-width"
                    onClick={() => void handleCloseToWallet()}
                    disabled={isClosing || !fiber.isRunning}
                  >
                    {isClosing ? (
                      <>
                        <SpinnerIcon width="14" height="14" className="spin" />
                        <span>Closing channel…</span>
                      </>
                    ) : (
                      <span>Confirm close to this address</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="button secondary full-width"
                    onClick={() => {
                      setWallet(null);
                      setCloseError(null);
                      setCloseResult(null);
                    }}
                    disabled={isClosing}
                  >
                    Use a different wallet
                  </button>
                </>
              )}
            </div>
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
