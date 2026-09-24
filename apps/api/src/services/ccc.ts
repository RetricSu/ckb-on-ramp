import {
  Address,
  type Client,
  ClientPublicTestnet,
  SignerCkbPrivateKey,
  Transaction,
  fixedPointFrom,
} from '@ckb-ccc/core';
import {
  type CkbScript,
  CWBTC_SCRIPT,
  normalizeCkbTransactionForCcc,
  normalizeCkbTransactionForRpc,
} from '@ckb-on-ramp/contracts';
import { redactSecret } from '../utils/redact.js';
import { FundingPolicyError } from './errors.js';

export const MAX_FUNDING_CELL_CAPACITY_SHANNONS = 25_000_000_000n; // 250 CKB
export const MAX_TOTAL_INPUT_CAPACITY_SHANNONS = 50_000_000_000n; // 500 CKB
export const MAX_ALLOWED_FEE_SHANNONS = 10_000_000n; // 0.1 CKB
export const DEFAULT_ALLOWED_FUNDING_LOCK_CODE_HASHES = [
  '0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c', // Fiber FundingLock
];

function parseU128Le(hex: string): bigint | null {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 32) return null;
  const buf = Buffer.from(clean.slice(0, 32), 'hex');
  let val = 0n;
  for (let i = 0; i < 16; i++) {
    val += BigInt(buf[i] ?? 0) << BigInt(8 * i);
  }
  return val;
}

export interface CapacityGiftResult {
  txHash: string;
}

export type CkbScriptLike =
  | CkbScript
  | { codeHash: string; hashType: 'type' | 'data' | 'data1' | 'data2'; args: string };

export interface SignFundingOptions {
  allowedFundingLockCodeHashes?: string[];
  allowedAdditionalInputLocks?: CkbScriptLike[];
  expectedExactUdtAmount?: bigint;
}

export interface OperatorCkbSender {
  sendCapacityGift(fundingAddress: string, amountCkb?: number | bigint): Promise<CapacityGiftResult>;
  waitForTransaction?(txHash: string): Promise<void>;
  getFundingLockScript?(): Promise<CkbScript>;
  signFundingTransaction?(unsignedTx: unknown, options?: SignFundingOptions): Promise<unknown>;
}

export class CccOperatorCkbSender implements OperatorCkbSender {
  private readonly client: Client;
  private readonly signer: SignerCkbPrivateKey;
  private readonly privateKey: string;

  constructor(privateKey: string, rpcUrlOrClient?: string | Client) {
    const trimmedKey = privateKey.trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(trimmedKey)) {
      throw new Error('OPERATOR_CKB_PRIVATE_KEY must be a valid 32-byte hex private key (64 hex characters)');
    }
    this.privateKey = trimmedKey;

    if (typeof rpcUrlOrClient === 'object' && rpcUrlOrClient !== null) {
      this.client = rpcUrlOrClient;
    } else {
      this.client = rpcUrlOrClient
        ? new ClientPublicTestnet({ url: rpcUrlOrClient })
        : new ClientPublicTestnet();
    }

    try {
      this.signer = new SignerCkbPrivateKey(this.client, trimmedKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to initialize operator CKB signer: ${this.redactKey(msg)}`);
    }
  }

  private redactKey(message: string): string {
    return redactSecret(message, this.privateKey);
  }

  async getFundingLockScript(): Promise<CkbScript> {
    try {
      const addrObj = await this.signer.getRecommendedAddressObj();
      return {
        code_hash: addrObj.script.codeHash,
        hash_type: addrObj.script.hashType as 'type' | 'data' | 'data1' | 'data2',
        args: addrObj.script.args,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to get operator funding lock script: ${this.redactKey(msg)}`);
    }
  }

  async signFundingTransaction(unsignedTx: unknown, options?: SignFundingOptions): Promise<unknown> {
    try {
      const cccTxLike = normalizeCkbTransactionForCcc(unsignedTx) as Record<string, unknown>;
      const tx = Transaction.from(cccTxLike);

      if (tx.inputs.length === 0) {
        throw new FundingPolicyError('Transaction must contain at least one input');
      }
      if (tx.outputs.length === 0) {
        throw new FundingPolicyError('Transaction must contain at least one output');
      }

      const operatorLock = (await this.signer.getRecommendedAddressObj()).script;
      const allowedFundingLocks = options?.allowedFundingLockCodeHashes ?? DEFAULT_ALLOWED_FUNDING_LOCK_CODE_HASHES;
      const additionalLocks = options?.allowedAdditionalInputLocks ?? [];

      const isAuthorizedLock = (lock: { codeHash: string; hashType: string; args: string }) => {
        if (
          lock.codeHash === operatorLock.codeHash &&
          lock.hashType === operatorLock.hashType &&
          lock.args === operatorLock.args
        ) {
          return true;
        }
        return additionalLocks.some((al) => {
          const ch = 'code_hash' in al ? al.code_hash : al.codeHash;
          const ht = 'hash_type' in al ? al.hash_type : al.hashType;
          const ag = al.args;
          return ch === lock.codeHash && ht === lock.hashType && ag === lock.args;
        });
      };

      // Gate (a) & (c): Authenticate all inputs against live chain (never trust client-supplied cellOutput)
      let totalInputCapacity = 0n;
      let totalInputUdt = 0n;
      for (const input of tx.inputs) {
        const liveCell = await this.client.getCell(input.previousOutput);
        if (!liveCell) {
          throw new FundingPolicyError(`Input cell not found on chain: ${input.previousOutput.txHash}:${input.previousOutput.index}`);
        }
        // Force overwrite input cell info with verified chain data
        input.cellOutput = liveCell.cellOutput;
        input.outputData = liveCell.outputData;

        if (!isAuthorizedLock(input.cellOutput.lock)) {
          throw new FundingPolicyError('Unauthorized input cell: input lock does not match operator funding lock');
        }

        totalInputCapacity += BigInt(input.cellOutput.capacity);

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

      if (totalInputCapacity > MAX_TOTAL_INPUT_CAPACITY_SHANNONS) {
        throw new FundingPolicyError(
          `Total input capacity (${totalInputCapacity}) exceeds maximum allowed budget (${MAX_TOTAL_INPUT_CAPACITY_SHANNONS})`,
        );
      }

      // Gate (b): Validate outputs whitelist
      // Exactly 1 funding output (lock in allowedFundingLocks, type === CWBTC_SCRIPT, capacity <= 250 CKB, valid u128 data)
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

      // Verify funding output type script is cWBTC
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

      // Verify funding output data contains valid positive UDT amount matching expected amount
      const rawFundingData = String(tx.outputsData[fundingIndex] ?? '');
      const fundingUdtAmount = parseU128Le(rawFundingData);
      if (fundingUdtAmount === null || fundingUdtAmount <= 0n) {
        throw new FundingPolicyError('Funding output data does not contain a valid positive 16-byte UDT amount');
      }
      if (options?.expectedExactUdtAmount !== undefined && fundingUdtAmount !== options.expectedExactUdtAmount) {
        throw new FundingPolicyError(
          `Funding output UDT amount (${fundingUdtAmount}) does not match expected amount (${options.expectedExactUdtAmount})`,
        );
      }

      // Verify all change outputs return to operator lock
      let totalOutputCapacity = 0n;
      let totalChangeUdt = 0n;
      for (const [idx, output] of tx.outputs.entries()) {
        totalOutputCapacity += BigInt(output.capacity);
        if (output === fundingOutput) continue;

        if (!isAuthorizedLock(output.lock)) {
          throw new FundingPolicyError('Change output lock script does not return to operator funding lock');
        }

        // If change output has type script, it must be cWBTC change
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
          // Plain CKB change output: data must be empty
          const data = String(tx.outputsData[idx] ?? '');
          if (data && data !== '0x') {
            throw new FundingPolicyError('Plain CKB change output must have empty cell data');
          }
        }
      }

      // UDT Conservation check: if input contained UDT, net UDT contributed must equal funding amount
      if (totalInputUdt > 0n) {
        const netUdtContributed = totalInputUdt - totalChangeUdt;
        if (netUdtContributed !== fundingUdtAmount) {
          throw new FundingPolicyError(
            `UDT balance is not conserved: input (${totalInputUdt}) - change (${totalChangeUdt}) = ${netUdtContributed} !== funding amount (${fundingUdtAmount})`,
          );
        }
      }

      // Verify miner fee is within safe limits (prevents burning operator capacity as fees)
      const minerFee = totalInputCapacity - totalOutputCapacity;
      if (minerFee < 0n) {
        throw new FundingPolicyError('Invalid transaction: total output capacity exceeds total input capacity');
      }
      if (minerFee > MAX_ALLOWED_FEE_SHANNONS) {
        throw new FundingPolicyError(`Miner fee (${minerFee} shannons) exceeds maximum allowed budget (${MAX_ALLOWED_FEE_SHANNONS} shannons)`);
      }

      const signedTx = await this.signer.signOnlyTransaction(tx);
      return normalizeCkbTransactionForRpc(signedTx);
    } catch (err) {
      if (err instanceof FundingPolicyError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Operator failed to sign funding transaction: ${this.redactKey(msg)}`);
    }
  }

  async sendCapacityGift(fundingAddress: string, amountCkb: number | bigint = 200): Promise<CapacityGiftResult> {
    try {
      const targetAddress = await Address.fromString(fundingAddress, this.client);
      const capacity = fixedPointFrom(amountCkb);

      const tx = Transaction.from({
        outputs: [
          {
            lock: targetAddress.script,
            capacity,
          },
        ],
      });

      await tx.completeInputsByCapacity(this.signer);
      await tx.completeFeeBy(this.signer);
      const txHash = await this.signer.sendTransaction(tx);

      return { txHash };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Operator CKB gift transfer failed: ${this.redactKey(msg)}`);
    }
  }

  async waitForTransaction(txHash: string): Promise<void> {
    try {
      await this.client.waitTransaction(txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Waiting for operator CKB gift transaction failed: ${this.redactKey(msg)}`);
    }
  }
}
