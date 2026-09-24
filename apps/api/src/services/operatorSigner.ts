import type { CkbScript } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';
import { CccOperatorCkbSender, type OperatorCkbSender } from './ccc.js';

let cachedSender: CccOperatorCkbSender | null | undefined = undefined;
let initError: Error | null = null;

export function getOperatorSigner(): OperatorCkbSender | undefined {
  if (initError) {
    throw initError;
  }
  if (cachedSender !== undefined) {
    return cachedSender ?? undefined;
  }
  if (!config.operatorCkbPrivateKey) {
    cachedSender = null;
    return undefined;
  }
  try {
    cachedSender = new CccOperatorCkbSender(config.operatorCkbPrivateKey, config.ckbRpcUrl);
    return cachedSender;
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    throw initError;
  }
}

export async function getOperatorFundingLockScript(): Promise<CkbScript | undefined> {
  const signer = getOperatorSigner();
  if (!signer || !signer.getFundingLockScript) {
    return undefined;
  }
  try {
    return await signer.getFundingLockScript();
  } catch {
    return undefined;
  }
}

export function resetOperatorSignerForTest(): void {
  cachedSender = undefined;
  initError = null;
}
