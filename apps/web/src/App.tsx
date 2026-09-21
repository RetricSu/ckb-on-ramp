import { FiberProvider } from './FiberProvider';
import { useSwap } from './useSwap';
import { Navbar } from './components/Navbar';
import { SwapCard } from './components/SwapCard';
import { SettlementModal } from './components/SettlementModal';
import { ProgressModal } from './components/ProgressModal';
import { HistoryDrawer } from './components/HistoryDrawer';
import { AccountModal } from './components/AccountModal';

function SwapApp() {
  const swap = useSwap();

  return (
    <div className="app-shell">
      <Navbar swap={swap} />

      <main id="main" className="main-viewport">
        <section className="swap-hero-section">
          <div className="hero-text-block">
            <h1 className="hero-headline">Instant BTC to CKB.</h1>
            <p className="hero-lede">
              Pay via Lightning Network, receive wrapped Bitcoin on CKB Fiber in seconds.
              Non-custodial, zero-gas onboarding.
            </p>
          </div>

          <SwapCard swap={swap} />
        </section>

        <section className="features-strip">
          <div className="feature-item">
            <div className="feature-icon">⚡</div>
            <div className="feature-text">
              <strong>Instant Atomic Settlement</strong>
              <p>Direct cross-chain Lightning ⇄ Fiber hop via CCH without exchange waiting periods.</p>
            </div>
          </div>

          <div className="feature-item">
            <div className="feature-icon">🛡️</div>
            <div className="feature-text">
              <strong>Non-Custodial Passkey</strong>
              <p>Your browser node signs off-chain invoices locally with Face ID or Touch ID.</p>
            </div>
          </div>

          <div className="feature-item">
            <div className="feature-icon">🎁</div>
            <div className="feature-text">
              <strong>Sponsored Inbound Route</strong>
              <p>Scheme B zero-CKB channel setup means you don&apos;t need CKB tokens to get started.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <div className="footer-content">
          <p>CKB On-ramp · Powered by Fiber Network & Lightning CCH · Testnet Edition</p>
          <div className="footer-links">
            <span>Non-custodial</span>
            <span>·</span>
            <span>No seed phrase export needed</span>
          </div>
        </div>
      </footer>

      {/* Modals and Drawers */}
      <SettlementModal swap={swap} />
      <ProgressModal swap={swap} />
      <HistoryDrawer swap={swap} />
      <AccountModal swap={swap} />
    </div>
  );
}

export function App() {
  return (
    <FiberProvider>
      <SwapApp />
    </FiberProvider>
  );
}
