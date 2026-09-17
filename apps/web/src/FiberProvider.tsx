import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { useFiberNode, type UdtAsset, type UseFiberNodeOptions } from '@fiber-pay/react';

export const CWBTC_SCRIPT = {
  code_hash: '0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb' as `0x${string}`,
  hash_type: 'type' as const,
  args: '0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000' as `0x${string}`,
};
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
  const fiber = useFiberNode({ network: 'testnet', enabled: true, nodeConfig: { udtWhitelist: UDT_WHITELIST } });
  return <FiberContext.Provider value={fiber}>{children}</FiberContext.Provider>;
}
export function useFiber() {
  const fiber = useContext(FiberContext);
  if (!fiber) throw new Error('useFiber must be used within FiberProvider');
  return fiber;
}
