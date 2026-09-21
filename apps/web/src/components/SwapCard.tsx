import { useState } from 'react';
import type { useSwap } from '../useSwap';
import {
  ArrowDownIcon,
  BtcIcon,
  ChevronDownIcon,
  CkbIcon,
  InfoIcon,
  LightningBoltIcon,
  SpinnerIcon,
} from './Icons';

interface SwapCardProps {
  swap: ReturnType<typeof useSwap>;
}

const PRESET_AMOUNTS = ['0.0001', '0.0005', '0.001', '0.005'];

export function SwapCard({ swap }: SwapCardProps) {
  const {
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
    cwbtcBalance,
    initiateSwap,
    order,
    setIsSettlementOpen,
  } = swap;

  const [detailsExpanded, setDetailsExpanded] = useState(false);

  // Sats equivalent
  const paySatsDisplay = quote ? quote.pay_sats : Math.round(Number(payAmount || '0') * 100_000_000);

  const isBusy = step !== 'idle' && step !== 'settled' && step !== 'failed';
  const hasPendingOrder =
    order && ['Pending', 'IncomingAccepted', 'OutgoingInFlight'].includes(order.status);

  let buttonText = 'Swap BTC for cWBTC';
  let isButtonDisabled = false;

  const currentInputAmount = inputMode === 'pay' ? payAmount : receiveAmount;

  if (isBusy) {
    buttonText = 'Preparing Swap…';
    isButtonDisabled = true;
  } else if (!currentInputAmount || currentInputAmount === '0') {
    buttonText = 'Enter an amount';
    isButtonDisabled = true;
  } else if (parsedTarget.error) {
    buttonText = 'Invalid amount';
    isButtonDisabled = true;
  } else if (isQuoting && !quote) {
    buttonText = 'Calculating quote…';
    isButtonDisabled = true;
  }

  // Effective fee rate percentage dynamically from server quote
  const feeRatePercent =
    quote && Number(quote.receive_raw) > 0
      ? ((quote.fee_sats / Number(quote.receive_raw)) * 100).toFixed(2)
      : null;

  return (
    <div className="swap-card-container">
      {hasPendingOrder && (
        <div className="pending-order-banner">
          <div className="pending-banner-left">
            <span className="pulsing-dot" />
            <span>Order pending: {order.pay_sats.toLocaleString()} sats</span>
          </div>
          <button
            type="button"
            className="link-button"
            onClick={() => setIsSettlementOpen(true)}
          >
            View Invoice →
          </button>
        </div>
      )}

      <div className="swap-card">
        <div className="swap-card-header">
          <div className="card-title-group">
            <h2 className="card-title">Swap</h2>
            <span className="card-subtitle">Instant Cross-Chain Hop</span>
          </div>
          <div className="rate-badge" title="Base exchange rate: 1 BTC = 1 cWBTC">
            <span>1 BTC ≈ 1 cWBTC</span>
          </div>
        </div>

        {/* You Pay Box */}
        <div className="swap-input-box pay-box">
          <div className="box-top-row">
            <label htmlFor="pay-amount" className="box-label">
              You Pay
            </label>
            {paySatsDisplay > 0 && (
              <span className="box-sublabel">≈ {paySatsDisplay.toLocaleString()} sats</span>
            )}
          </div>

          <div className="box-input-row">
            <input
              id="pay-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={payAmount}
              onChange={(e) => {
                setInputMode('pay');
                setPayAmount(e.target.value);
              }}
              onFocus={() => setInputMode('pay')}
              onBlur={() => setTouched(true)}
              className="swap-number-input"
              autoComplete="off"
            />

            <div className="asset-badge btc-badge" title="Bitcoin on Lightning Network">
              <BtcIcon width="26" height="26" />
              <div className="asset-names">
                <span className="asset-symbol">BTC</span>
                <span className="asset-network">
                  <LightningBoltIcon width="11" height="11" /> Lightning
                </span>
              </div>
            </div>
          </div>

          <div className="preset-chips">
            {PRESET_AMOUNTS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`preset-chip ${payAmount === preset && inputMode === 'pay' ? 'active' : ''}`}
                onClick={() => {
                  setInputMode('pay');
                  setPayAmount(preset);
                  setTouched(true);
                }}
              >
                {preset} BTC
              </button>
            ))}
          </div>

          {touched && inputMode === 'pay' && parsedTarget.error && (
            <p className="input-error-text">{parsedTarget.error}</p>
          )}
        </div>

        {/* Arrow Divider */}
        <div className="swap-arrow-divider">
          <div className="divider-line" />
          <div className="arrow-circle" aria-hidden="true">
            <ArrowDownIcon width="16" height="16" />
          </div>
          <div className="divider-line" />
        </div>

        {/* You Receive Box */}
        <div className="swap-input-box receive-box">
          <div className="box-top-row">
            <label htmlFor="receive-amount" className="box-label">
              You Receive
            </label>
            <span className="box-sublabel">Balance: {cwbtcBalance} cWBTC</span>
          </div>

          <div className="box-input-row">
            <input
              id="receive-amount"
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={receiveAmount}
              onChange={(e) => {
                setInputMode('receive');
                setReceiveAmount(e.target.value);
              }}
              onFocus={() => setInputMode('receive')}
              onBlur={() => setTouched(true)}
              className="swap-number-input"
              autoComplete="off"
            />

            <div className="asset-badge ckb-badge" title="Wrapped Bitcoin on CKB Fiber Network">
              <CkbIcon width="26" height="26" />
              <div className="asset-names">
                <span className="asset-symbol">cWBTC</span>
                <span className="asset-network">Fiber Network</span>
              </div>
            </div>
          </div>

          <div className="receive-box-footer">
            <span className="settlement-hint">
              ⚡ Instant off-chain settlement to your browser Fiber node
            </span>
          </div>

          {touched && inputMode === 'receive' && parsedTarget.error && (
            <p className="input-error-text">{parsedTarget.error}</p>
          )}
        </div>

        {/* Quote & Routing Details Drawer */}
        <div className="swap-details-drawer">
          <button
            type="button"
            className="details-toggle-button"
            onClick={() => setDetailsExpanded((prev) => !prev)}
            aria-expanded={detailsExpanded}
          >
            <div className="toggle-left">
              <InfoIcon width="14" height="14" />
              <span>
                {quote
                  ? `Fee: ${quote.fee_sats.toLocaleString()} sats (${feeRatePercent ? `~${feeRatePercent}%` : 'Base + proportional'})`
                  : 'Fee breakdown & routing details'}
              </span>
            </div>
            <div className={`toggle-chevron ${detailsExpanded ? 'expanded' : ''}`}>
              <ChevronDownIcon width="14" height="14" />
            </div>
          </button>

          {detailsExpanded && (
            <div className="details-content">
              <div className="detail-row">
                <span className="detail-label">Base Exchange Rate</span>
                <span className="detail-value">1 BTC = 1.00000000 cWBTC</span>
              </div>
              {quote ? (
                <>
                  <div className="detail-row highlight-row">
                    <span className="detail-label">Total Operator Fee</span>
                    <span className="detail-value">
                      {quote.fee_sats.toLocaleString()} sats {feeRatePercent && `(${feeRatePercent}%)`}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Total Amount to Pay</span>
                    <span className="detail-value bold-text">{quote.pay_sats.toLocaleString()} sats</span>
                  </div>
                </>
              ) : (
                <div className="detail-row">
                  <span className="detail-label">Network Fee Policy</span>
                  <span className="detail-value">Base fee + 0.3% CCH routing</span>
                </div>
              )}
              <div className="detail-row">
                <span className="detail-label">Estimated Arrival</span>
                <span className="detail-value green-text">~10 seconds (Instant)</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Inbound Channel</span>
                <span className="detail-value">Scheme B 0-CKB Sponsored</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Custody Mode</span>
                <span className="detail-value">Non-Custodial (Local Node)</span>
              </div>
            </div>
          )}
        </div>

        {quoteError && <div className="quote-error-banner">{quoteError}</div>}

        {/* Primary Action Button */}
        <button
          type="button"
          className="swap-primary-button"
          onClick={() => void initiateSwap()}
          disabled={isButtonDisabled}
        >
          {isBusy ? (
            <>
              <SpinnerIcon width="20" height="20" />
              <span>{buttonText}</span>
            </>
          ) : (
            <span>{buttonText}</span>
          )}
        </button>

        <p className="swap-card-footnote">
          No account or KYC required. Your Lightning payment unlocks wrapped BTC directly to your
          browser&apos;s private Fiber node.
        </p>
      </div>
    </div>
  );
}
