import { useState } from 'react';
import type { useSwap } from '../useSwap';
import { CkbIcon, HistoryIcon, KeyIcon, SpinnerIcon, WalletIcon } from './Icons';

interface NavbarProps {
  swap: ReturnType<typeof useSwap>;
}

function shorten(value: string, head = 6, tail = 4) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export function Navbar({ swap }: NavbarProps) {
  const { fiber, cwbtcBalance, receipts, health, connectNode, setIsHistoryOpen, setIsAccountOpen } = swap;
  const [isConnecting, setIsConnecting] = useState(false);

  const isOnline = health?.ok && health?.fnn_reachable;

  const pendingCount = receipts.filter(
    (r) => r.status === 'Pending' || r.status === 'IncomingAccepted' || r.status === 'OutgoingInFlight',
  ).length;

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      await connectNode();
    } catch (err) {
      console.warn('Connect error:', err);
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <header className="navbar">
      <div className="navbar-left">
        <a className="wordmark-brand" href="#main" aria-label="CKB On-ramp home">
          <span className="brand-title">CKB / ON-RAMP</span>
          <span className={`network-tag ${isOnline ? 'tag-online' : 'tag-offline'}`}>
            <span className={`live-dot ${isOnline ? 'dot-online' : 'dot-offline'}`} />
            {isOnline ? 'FIBER TESTNET' : 'GATEWAY OFFLINE'}
          </span>
        </a>
      </div>

      <div className="navbar-right">
        {fiber.isRunning && (
          <button
            type="button"
            className="balance-pill"
            onClick={() => setIsAccountOpen(true)}
            title="View cWBTC Fiber Balance"
          >
            <CkbIcon width="16" height="16" />
            <span className="balance-val">{cwbtcBalance} cWBTC</span>
          </button>
        )}

        <button
          type="button"
          className="icon-button"
          onClick={() => setIsHistoryOpen(true)}
          title="Recent Transactions"
          aria-label="Recent Transactions"
        >
          <HistoryIcon width="18" height="18" />
          {pendingCount > 0 && <span className="badge-dot" />}
        </button>

        {fiber.isRunning ? (
          <button
            type="button"
            className="account-pill"
            onClick={() => setIsAccountOpen(true)}
            title={fiber.nodeInfo?.pubkey ?? 'Connected Node'}
          >
            <KeyIcon width="14" height="14" className="key-icon" />
            <span className="pubkey-text">
              {fiber.nodeInfo?.pubkey ? shorten(fiber.nodeInfo.pubkey) : 'Browser Node'}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="connect-button"
            onClick={() => void handleConnect()}
            disabled={isConnecting || fiber.isStarting}
          >
            {isConnecting || fiber.isStarting ? (
              <>
                <SpinnerIcon width="14" height="14" />
                <span>Connecting…</span>
              </>
            ) : (
              <>
                <WalletIcon width="16" height="16" />
                <span>Connect Node</span>
              </>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
