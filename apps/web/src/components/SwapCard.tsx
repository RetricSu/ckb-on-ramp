import { useState } from 'react';
import type { useSwap } from '../useSwap';
import {
  ArrowDownIcon,
  BtcIcon,
  ChevronDownIcon,
  CkbIcon,
  InfoIcon,
  LightningBoltIcon,
  RefreshIcon,
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
    health,
    step,
    cwbtcBalance,
    initiateSwap,
    order,
    setIsSettlementOpen,
  } = swap;

  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [rateInverted, setRateInverted] = useState(false);

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
  } else if (health?.can_receive === false) {
    buttonText = 'Receiving temporarily unavailable';
    isButtonDisabled = true;
  }

  // Effective fee rate percentage dynamically from server quote
  const feeRatePercent =
    quote && Number(quote.receive_raw) > 0
      ? ((quote.fee_sats / Number(quote.receive_raw)) * 100).toFixed(2)
      : null;

  // Effective exchange rate (after fees) and its delta vs the 1:1 nominal peg.
  // Displayed like 1inch's rate line so users see the real price, not the headline peg.
  const paySats = quote ? quote.pay_sats : 0;
  const receiveSats = quote ? Number(quote.receive_raw) : 0;
  const effectiveRate = paySats > 0 ? receiveSats / paySats : null;
  const rateDeltaPercent =
    effectiveRate !== null ? ((effectiveRate - 1) * 100).toFixed(2) : null;
  const rateDisplay =
    effectiveRate !== null
      ? rateInverted
        ? `1 cWBTC = ${(1 / effectiveRate).toFixed(8)} BTC`
        : `1 BTC = ${effectiveRate.toFixed(8)} cWBTC`
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
          <h2 className="card-title">Swap</h2>
          {quote && (
            <span className="quote-freshness" title="Quote refreshes automatically as you edit the amount">
              {isQuoting ? 'Updating quote…' : 'Live quote'}
            </span>
          )}
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

          {quote && (
            <div className="receive-box-footer">
              <span className="box-sublabel">
                ≈ {receiveSats.toLocaleString()} sats
                {rateDeltaPercent !== null && Number(rateDeltaPercent) !== 0 && (
                  <span className="rate-delta"> ({rateDeltaPercent}%)</span>
                )}
              </span>
            </div>
          )}

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
                {quote && rateDisplay
                  ? `${rateDisplay} · Fee ${quote.fee_sats.toLocaleString()} sats`
                  : 'Rate, fee & settlement details'}
              </span>
            </div>
            <div className={`toggle-chevron ${detailsExpanded ? 'expanded' : ''}`}>
              <ChevronDownIcon width="14" height="14" />
            </div>
          </button>

          {detailsExpanded && (
            <div className="details-content">
              <div className="detail-row">
                <span className="detail-label">Rate</span>
                {rateDisplay ? (
                  <button
                    type="button"
                    className="rate-flip-button"
                    onClick={() => setRateInverted((prev) => !prev)}
                    title="Invert rate"
                  >
                    <span>{rateDisplay}</span>
                    <RefreshIcon width="12" height="12" />
                  </button>
                ) : (
                  <span className="detail-value">1 BTC = 1.00000000 cWBTC (before fees)</span>
                )}
              </div>
              {quote && (
                <div className="detail-row highlight-row">
                  <span className="detail-label">Operator Fee</span>
                  <span className="detail-value">
                    {quote.fee_sats.toLocaleString()} sats {feeRatePercent && `(${feeRatePercent}%)`}
                  </span>
                </div>
              )}
              <div className="detail-row">
                <span className="detail-label">Slippage</span>
                <span className="detail-value">0% — amount fixed by invoice</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Route</span>
                <span className="detail-value">Lightning → CCH → Fiber</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Estimated Arrival</span>
                <span className="detail-value green-text">~10 seconds</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Settlement</span>
                <span className="detail-value">Non-custodial · local Fiber node</span>
              </div>
            </div>
          )}
        </div>

        {health?.can_receive === false && (
          <div className="quote-error-banner">
            {health.unavailable_reason ?? 'The operator cannot open a new inbound channel right now.'}
          </div>
        )}
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
          {quote && feeRatePercent
            ? `Includes ${feeRatePercent}% operator fee · Non-custodial · No account required`
            : 'Non-custodial · No account required'}
        </p>
      </div>
    </div>
  );
}
