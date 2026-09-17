import type { BootstrapRequest, BootstrapSession, Environment, NodeInfo } from '@ckb-on-ramp/contracts';
import { scriptToAddress, type Script } from '@fiber-pay/sdk/browser';

const WSS_REGEX = /(?:^|\/)wss(?:\/|$)/;
const WS_REGEX = /(?:^|\/)ws(?:\/|$)/;

/**
 * Select the best WebSocket multiaddr for a browser node.
 * Browsers cannot dial raw TCP, so this filters for WebSocket transports,
 * preferring secure WebSocket (/wss) over plain WebSocket (/ws).
 */
export function pickPeerAddress(addresses?: readonly string[] | null): string | null {
  if (!addresses || addresses.length === 0) return null;
  const wss = addresses.find((addr) => WSS_REGEX.test(addr));
  if (wss) return wss;
  const ws = addresses.find((addr) => WS_REGEX.test(addr));
  if (ws) return ws;
  return null;
}

/**
 * Returns true if the multiaddr points to a simulated/mock provider domain.
 */
export function isMockPeerAddress(address?: string | null): boolean {
  if (!address) return false;
  return address.includes('mock-provider.test') || address.includes('.test/') || address.endsWith('.test');
}

export interface PrepareRouteOptions {
  nodePubkey: string | undefined;
  defaultFundingLockScript?: Script | null;
  fundingAddress?: string | null;
  connectPeer: ((params: { address: string; save?: boolean }) => Promise<void>) | null | undefined;
  getNodeInfo: () => Promise<NodeInfo>;
  bootstrap: (request: BootstrapRequest) => Promise<BootstrapSession>;
  mode?: Environment;
  onOperatorNode?: (info: NodeInfo) => void;
}

/**
 * Prepares the receive route by:
 * 1. Verifying the browser Fiber node is running.
 * 2. Deriving the funding address from default_funding_lock_script via scriptToAddress.
 * 3. Fetching operator node info and picking a WebSocket multiaddr.
 * 4. Dialing connectPeer with fail-closed semantics on empty or failing addresses.
 * 5. Calling backend bootstrap with node_pubkey and funding_address.
 */
export async function prepareReceiveRoute(options: PrepareRouteOptions): Promise<BootstrapSession> {
  if (!options.nodePubkey || !options.connectPeer) {
    throw new Error('Start the browser Fiber node before preparing a receive route.');
  }

  let fundingAddress = options.fundingAddress;
  if (!fundingAddress && options.defaultFundingLockScript) {
    try {
      fundingAddress = scriptToAddress(options.defaultFundingLockScript, 'testnet');
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      throw new Error(`Failed to derive funding address from lock script: ${detail}`);
    }
  }

  if (!fundingAddress) {
    throw new Error('Browser Fiber node funding lock script is unavailable. Start the node first.');
  }

  const info = await options.getNodeInfo();
  options.onOperatorNode?.(info);

  const peerAddress = pickPeerAddress(info.addresses);
  if (!peerAddress) {
    throw new Error('Operator has no reachable WebSocket address (WSS/WS) advertised.');
  }
  try {
    await options.connectPeer({ address: peerAddress, save: true });
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    throw new Error(`Failed to connect to operator peer (${peerAddress}): ${detail}`);
  }

  const session = await options.bootstrap({
    node_pubkey: options.nodePubkey,
    funding_address: fundingAddress,
  });
  if (session.status !== 'ready' && session.status !== 'provisioning_liquidity') {
    throw new Error(session.message);
  }
  return session;
}
