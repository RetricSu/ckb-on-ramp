import { ClientPublicTestnet } from '@ckb-ccc/core';
import { UniSat } from '@ckb-ccc/uni-sat';
import { CLOSE_ERRORS, cccScriptToFiberScript, type FiberLockScript } from './closeToWallet';

export function createOnRampCkbClient(): ClientPublicTestnet {
  const origin = typeof window === 'undefined' ? 'http://localhost:5174' : window.location.origin;
  return new ClientPublicTestnet({ url: `${origin}/ckb-rpc` });
}

export type ConnectedCccWallet = {
  lock: FiberLockScript;
  address: string;
};

export async function connectCccWallet(): Promise<ConnectedCccWallet> {
  const client = createOnRampCkbClient();
  const signers = UniSat.getUniSatSigners(client);
  const first = signers[0];
  if (!first) {
    throw new Error(CLOSE_ERRORS.NO_WALLET);
  }
  await first.signer.connect();
  const addrObj = await first.signer.getRecommendedAddressObj();
  return {
    lock: cccScriptToFiberScript(addrObj.script),
    address: addrObj.toString(),
  };
}
