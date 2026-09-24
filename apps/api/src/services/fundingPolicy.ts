import { CWBTC_SCRIPT } from '@ckb-on-ramp/contracts';
import { FundingPolicyError } from './errors.js';

// Dual-funded UDT channel: both sides reserve ~184 CKB into one funding cell (~368 CKB).
export const MAX_FUNDING_CELL_CAPACITY_SHANNONS = 40_000_000_000n; // 400 CKB
// Budget for inputs the API actually signs (operator gift lock). Peer-side inputs are
// self-funded and self-signed by the peer's own node, so they are NOT capped here; the
// gift-side conservation check below is what protects API-signed funds.
export const MAX_TOTAL_INPUT_CAPACITY_SHANNONS = 80_000_000_000n; // 800 CKB
export const MAX_ALLOWED_FEE_SHANNONS = 10_000_000n; // 0.1 CKB
export const DEFAULT_ALLOWED_FUNDING_LOCK_CODE_HASHES = [
  '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', // Fiber FundingLock
];

export function parseU128Le(hex: string): bigint | null {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 32) return null;
  const buf = Buffer.from(clean.slice(0, 32), 'hex');
  let val = 0n;
  for (let i = 0; i < 16; i++) {
    val += BigInt(buf[i] ?? 0) << BigInt(8 * i);
  }
  return val;
}

export interface CkbScriptLike {
  codeHash?: string;
  code_hash?: string;
  hashType?: string;
  hash_type?: string;
  args: string;
}

export interface FundingPolicyContext {
  operatorLock: { codeHash: string; hashType: string; args: string };
  allowedFundingLockCodeHashes?: string[];
  allowedAdditionalInputLocks?: CkbScriptLike[];
  expectedExactUdtAmount?: bigint;
}

export interface ValidatedFundingTxResult {
  totalInputCapacity: bigint;
  totalOutputCapacity: bigint;
  minerFee: bigint;
  totalInputUdt: bigint;
  fundingUdtAmount: bigint;
  totalChangeUdt: bigint;
}

/**
 * Pure policy validation for external funding transactions.
 * Enforces:
 * 1. Input lock verification (operator gift lock or whitelisted peer locks; the 800 CKB
 *    budget caps only API-signed gift inputs — peer inputs are self-funded)
 * 2. Exactly one funding output with authorized Fiber FundingLock code_hash + hash_type: 'type'
 * 3. Funding output capacity limit (<= 400 CKB)
 * 4. Funding output UDT script matching CWBTC_SCRIPT and matching exact negotiated funding amount
 * 5. Change outputs: gift change returns to operator lock; peer change must reuse a lock
 *    present in peer inputs; cWBTC type only for UDT change; plain CKB change has empty data
 * 6. Strict UDT conservation: inputs - change === funding
 * 7. Gift-side CKB conservation: gift inputs - gift change <= funding capacity + fee budget
 * 8. Miner fee upper limit: <= 0.1 CKB
 */
export function assertFundingTxPolicy(
  tx: {
    inputs: Array<{ cellOutput?: { capacity: bigint | string; lock: { codeHash: string; hashType: string; args: string }; type?: { codeHash: string; hashType: string; args: string } | null }; outputData?: string | null }>;
    outputs: Array<{ capacity: bigint | string; lock: { codeHash: string; hashType: string; args: string }; type?: { codeHash: string; hashType: string; args: string } | null }>;
    outputsData: Array<string | null | undefined>;
  },
  ctx: FundingPolicyContext,
): ValidatedFundingTxResult {
  if (tx.inputs.length === 0) {
    throw new FundingPolicyError('Transaction must contain at least one input');
  }
  if (tx.outputs.length === 0) {
    throw new FundingPolicyError('Transaction must contain at least one output');
  }

  const { operatorLock } = ctx;
  const allowedFundingLocks = ctx.allowedFundingLockCodeHashes ?? DEFAULT_ALLOWED_FUNDING_LOCK_CODE_HASHES;
  const additionalLocks = ctx.allowedAdditionalInputLocks ?? [];

  const isAuthorizedLock = (lock: { codeHash: string; hashType: string; args: string }) => {
    if (
      lock.codeHash === operatorLock.codeHash &&
      lock.hashType === operatorLock.hashType &&
      lock.args === operatorLock.args
    ) {
      return true;
    }
    return additionalLocks.some((al) => {
      const ch = al.code_hash ?? al.codeHash;
      const ht = al.hash_type ?? al.hashType;
      const ag = al.args;
      return ch === lock.codeHash && ht === lock.hashType && ag === lock.args;
    });
  };

  // Gate (a): every input must be an authorized lock (operator gift lock or whitelisted peer lock).
  // Peer inputs are self-funded/self-signed; only gift-lock inputs consume the API budget.
  let signedInputCapacity = 0n;
  let totalInputCapacity = 0n;
  let totalInputUdt = 0n;
  const peerInputLocks = new Set<string>();
  const lockKey = (lock: { codeHash: string; hashType: string; args: string }) =>
    `${lock.codeHash}|${lock.hashType}|${lock.args}`;
  const isOperatorLock = (lock: { codeHash: string; hashType: string; args: string }) =>
    lock.codeHash === operatorLock.codeHash &&
    lock.hashType === operatorLock.hashType &&
    lock.args === operatorLock.args;
  for (const input of tx.inputs) {
    if (!input.cellOutput) {
      throw new FundingPolicyError('Input cell output is missing or unverified');
    }

    if (!isAuthorizedLock(input.cellOutput.lock)) {
      throw new FundingPolicyError('Unauthorized input cell: input lock does not match operator funding lock');
    }

    const capacity = BigInt(input.cellOutput.capacity);
    totalInputCapacity += capacity;
    if (isOperatorLock(input.cellOutput.lock)) {
      signedInputCapacity += capacity;
    } else {
      peerInputLocks.add(lockKey(input.cellOutput.lock));
    }

    // Track UDT input if present
    if (
      input.cellOutput.type &&
      input.cellOutput.type.codeHash === CWBTC_SCRIPT.code_hash &&
      input.cellOutput.type.hashType === CWBTC_SCRIPT.hash_type &&
      input.cellOutput.type.args === CWBTC_SCRIPT.args
    ) {
      const udtVal = parseU128Le(String(input.outputData ?? ''));
      if (udtVal !== null) {
        totalInputUdt += udtVal;
      }
    }
  }

  if (signedInputCapacity > MAX_TOTAL_INPUT_CAPACITY_SHANNONS) {
    throw new FundingPolicyError(
      `Total input capacity (${signedInputCapacity}) exceeds maximum allowed budget (${MAX_TOTAL_INPUT_CAPACITY_SHANNONS})`,
    );
  }

  // Gate (b): Validate outputs whitelist
  const fundingOutputs = tx.outputs.filter((o) => {
    return (
      o.type !== null &&
      o.type !== undefined &&
      allowedFundingLocks.includes(o.lock.codeHash) &&
      o.lock.hashType === 'type'
    );
  });
  if (fundingOutputs.length !== 1) {
    throw new FundingPolicyError(
      `Transaction must contain exactly one UDT funding output with an authorized Fiber FundingLock, found ${fundingOutputs.length}`,
    );
  }

  const fundingOutput = fundingOutputs[0]!;
  const fundingIndex = tx.outputs.indexOf(fundingOutput);

  if (
    fundingOutput.type!.codeHash !== CWBTC_SCRIPT.code_hash ||
    fundingOutput.type!.hashType !== CWBTC_SCRIPT.hash_type ||
    fundingOutput.type!.args !== CWBTC_SCRIPT.args
  ) {
    throw new FundingPolicyError('Funding output type script does not match authorized cWBTC script');
  }

  if (BigInt(fundingOutput.capacity) > MAX_FUNDING_CELL_CAPACITY_SHANNONS) {
    throw new FundingPolicyError('Funding output capacity exceeds maximum channel capacity budget');
  }

  const rawFundingData = String(tx.outputsData[fundingIndex] ?? '');
  const fundingUdtAmount = parseU128Le(rawFundingData);
  if (fundingUdtAmount === null || fundingUdtAmount <= 0n) {
    throw new FundingPolicyError('Funding output data does not contain a valid positive 16-byte UDT amount');
  }
  if (ctx.expectedExactUdtAmount !== undefined && fundingUdtAmount !== ctx.expectedExactUdtAmount) {
    throw new FundingPolicyError(
      `Funding output UDT amount (${fundingUdtAmount}) does not match expected amount (${ctx.expectedExactUdtAmount})`,
    );
  }

  // Verify change outputs: gift change returns to the operator lock; peer change must
  // return to a lock that actually appears among peer inputs (cannot be a fresh address
  // that only receives value). UDT change must be cWBTC with valid 16-byte data; plain
  // CKB change must have empty data.
  let totalOutputCapacity = 0n;
  let totalChangeUdt = 0n;
  let giftChangeCapacity = 0n;
  for (const [idx, output] of tx.outputs.entries()) {
    totalOutputCapacity += BigInt(output.capacity);
    if (output === fundingOutput) continue;

    if (!isAuthorizedLock(output.lock)) {
      throw new FundingPolicyError('Change output lock script does not return to operator funding lock');
    }
    if (!isOperatorLock(output.lock) && !peerInputLocks.has(lockKey(output.lock))) {
      throw new FundingPolicyError('Change output lock script does not return to operator funding lock');
    }

    if (output.type !== null && output.type !== undefined) {
      if (
        output.type.codeHash !== CWBTC_SCRIPT.code_hash ||
        output.type.hashType !== CWBTC_SCRIPT.hash_type ||
        output.type.args !== CWBTC_SCRIPT.args
      ) {
        throw new FundingPolicyError('Unauthorized secondary output: non-cWBTC type script is forbidden');
      }
      const changeUdtVal = parseU128Le(String(tx.outputsData[idx] ?? ''));
      if (changeUdtVal === null || changeUdtVal < 0n) {
        throw new FundingPolicyError('UDT change output does not contain valid 16-byte UDT data');
      }
      totalChangeUdt += changeUdtVal;
    } else {
      const data = String(tx.outputsData[idx] ?? '');
      if (data && data !== '0x') {
        throw new FundingPolicyError('Plain CKB change output must have empty cell data');
      }
    }

    if (isOperatorLock(output.lock)) {
      giftChangeCapacity += BigInt(output.capacity);
    }
  }

  // Gift-side CKB conservation: API-signed funds may only flow into the funding cell,
  // back to the operator lock as change, or into the miner fee budget. Anything beyond
  // that means gift money is being siphoned to peer/attacker outputs.
  const giftSpent = signedInputCapacity - giftChangeCapacity;
  const fundingCapacity = BigInt(fundingOutput.capacity);
  if (giftSpent > fundingCapacity + MAX_ALLOWED_FEE_SHANNONS) {
    throw new FundingPolicyError(
      `Gift funds not conserved: signed inputs (${signedInputCapacity}) - gift change (${giftChangeCapacity}) = ${giftSpent} exceeds funding capacity (${fundingCapacity}) plus fee budget (${MAX_ALLOWED_FEE_SHANNONS})`,
    );
  }

  // UDT conservation check
  if (totalInputUdt > 0n) {
    const netUdtContributed = totalInputUdt - totalChangeUdt;
    if (netUdtContributed !== fundingUdtAmount) {
      throw new FundingPolicyError(
        `UDT balance is not conserved: input (${totalInputUdt}) - change (${totalChangeUdt}) = ${netUdtContributed} !== funding amount (${fundingUdtAmount})`,
      );
    }
  }

  // Miner fee check
  const minerFee = totalInputCapacity - totalOutputCapacity;
  if (minerFee < 0n) {
    throw new FundingPolicyError('Invalid transaction: total output capacity exceeds total input capacity');
  }
  if (minerFee > MAX_ALLOWED_FEE_SHANNONS) {
    throw new FundingPolicyError(`Miner fee (${minerFee} shannons) exceeds maximum allowed budget (${MAX_ALLOWED_FEE_SHANNONS} shannons)`);
  }

  return {
    totalInputCapacity,
    totalOutputCapacity,
    minerFee,
    totalInputUdt,
    fundingUdtAmount,
    totalChangeUdt,
  };
}
