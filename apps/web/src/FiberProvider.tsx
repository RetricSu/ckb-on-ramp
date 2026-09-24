import type { ReactNode } from 'react';
import { createContext, useContext, useEffect } from 'react';
import { useFiberNode, type UdtAsset, type UseFiberNodeOptions } from '@fiber-pay/react';
import { CWBTC_SCRIPT } from '@ckb-on-ramp/contracts';
import { startChannelAcceptor } from './channels';

export { CWBTC_SCRIPT };
export const CWBTC_ASSET: UdtAsset = { kind: 'udt', name: 'cWBTC', script: CWBTC_SCRIPT };
const UDT_WHITELIST: NonNullable<UseFiberNodeOptions['nodeConfig']>['udtWhitelist'] = [{
  name: 'cWBTC', script: CWBTC_SCRIPT,
  cellDeps: [{ cellDep: { outPoint: {
    txHash: '0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f' as `0x${string}`,
    index: '0x0' as `0x${string}`,
  }, depType: 'code' } }],
  autoAcceptAmount: '0x3b9aca00',
}];

type FiberState = ReturnType<typeof useFiberNode>;
const FiberContext = createContext<FiberState | null>(null);
export function FiberProvider({ children }: { children: ReactNode }) {
  const fiber = useFiberNode({
    network: 'testnet',
    enabled: true,
    // Operator signs funding; omit the browser CKB key (fiber-pay external funding mode).
    externalWallet: true,
    nodeConfig: {
      udtWhitelist: UDT_WHITELIST,
      logLevel: import.meta.env.DEV ? 'debug' : 'info',
      // Same-origin proxy: COEP blocks browser Fiber WASM from public CKB RPCs.
      ckbRpcUrl: `${typeof window === 'undefined' ? 'http://localhost:5174' : window.location.origin}/ckb-rpc`,
    },
  });

  useEffect(() => {
    if (!fiber.isRunning || !fiber.node) return;
    const watcher = startChannelAcceptor({
      node: fiber.node,
      onError: (err) => {
        console.warn('Fiber node channel acceptor poll error:', err);
      },
    });
    return () => {
      watcher.stop();
    };
  }, [fiber.isRunning, fiber.node]);

  return <FiberContext.Provider value={fiber}>{children}</FiberContext.Provider>;
}
export function useFiber() {
  const fiber = useContext(FiberContext);
  if (!fiber) throw new Error('useFiber must be used within FiberProvider');
  return fiber;
}
