import type { useSwap } from '../useSwap';
import { AlertIcon, CheckIcon, CloseIcon, SpinnerIcon } from './Icons';

interface ProgressModalProps {
  swap: ReturnType<typeof useSwap>;
}

export function ProgressModal({ swap }: ProgressModalProps) {
  const {
    step,
    progressTitle,
    progressMessage,
    error,
    isProgressOpen,
    setIsProgressOpen,
    initiateSwap,
  } = swap;

  if (!isProgressOpen) return null;

  const isFailed = step === 'failed' || !!error;

  const stepsList = [
    {
      id: 'authorizing_node',
      label: 'Local Node Wallet',
      description: 'Passkey authentication in browser',
      isDone:
        step === 'checking_channel' ||
        step === 'provisioning_channel' ||
        step === 'creating_invoice' ||
        step === 'creating_order' ||
        step === 'awaiting_payment' ||
        step === 'settled',
      isActive: step === 'authorizing_node',
    },
    {
      id: 'connecting_peer',
      label: 'Fiber Network Relay',
      description: 'Connecting to Lightning-Fiber gateway',
      isDone:
        step === 'provisioning_channel' ||
        step === 'creating_invoice' ||
        step === 'creating_order' ||
        step === 'awaiting_payment' ||
        step === 'settled',
      isActive: step === 'connecting_peer' || step === 'checking_channel',
    },
    {
      id: 'provisioning_channel',
      label: 'Inbound Channel',
      description: 'Scheme B sponsored zero-CKB channel',
      isDone:
        step === 'creating_invoice' ||
        step === 'creating_order' ||
        step === 'awaiting_payment' ||
        step === 'settled',
      isActive: step === 'provisioning_channel',
    },
    {
      id: 'creating_invoice',
      label: 'Swap Invoice',
      description: 'Signing Fiber & Lightning payment hashes',
      isDone: step === 'awaiting_payment' || step === 'settled',
      isActive: step === 'creating_invoice' || step === 'creating_order',
    },
  ];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-dialog progress-dialog">
        <div className="modal-header">
          <div className="modal-title-group">
            <h3 className="modal-title">{isFailed ? 'Setup Interrupted' : progressTitle || 'Preparing Swap'}</h3>
            <span className="modal-kicker">AUTOMATED SETUP PIPELINE</span>
          </div>

          <button
            type="button"
            className="modal-close-button"
            onClick={() => setIsProgressOpen(false)}
            aria-label="Close"
          >
            <CloseIcon width="20" height="20" />
          </button>
        </div>

        {isFailed ? (
          <div className="progress-error-view">
            <div className="error-icon-circle">
              <AlertIcon width="28" height="28" />
            </div>
            <h4 className="error-headline">Could not complete preparation</h4>
            <div className="error-detail-box">
              <p>{error || 'An unexpected error occurred during channel setup.'}</p>
            </div>
            <div className="error-actions-row">
              <button
                type="button"
                className="button primary"
                onClick={() => void initiateSwap()}
              >
                Retry Setup
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setIsProgressOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="progress-content-view">
            <div className="stepper-list">
              {stepsList.map((item, index) => (
                <div
                  key={item.id}
                  className={`stepper-item ${item.isDone ? 'done' : item.isActive ? 'active' : ''}`}
                >
                  <div className="stepper-left">
                    <div className="step-circle">
                      {item.isDone ? (
                        <CheckIcon width="14" height="14" />
                      ) : item.isActive ? (
                        <SpinnerIcon width="14" height="14" />
                      ) : (
                        <span>{index + 1}</span>
                      )}
                    </div>
                    {index < stepsList.length - 1 && <div className="step-connector-line" />}
                  </div>

                  <div className="stepper-right">
                    <div className="step-label">{item.label}</div>
                    <div className="step-description">{item.description}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="progress-footer-box">
              <div className="footer-spinner">
                <SpinnerIcon width="20" height="20" />
              </div>
              <p className="footer-message">
                {progressMessage || 'Preparing your browser node to receive wrapped Bitcoin…'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
