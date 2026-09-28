import {
  Address,
  type Client,
  ClientPublicTestnet,
  SignerCkbPrivateKey,
  Transaction,
  fixedPointFrom,
} from '@ckb-ccc/core';
import {
  CWBTC_SCRIPT,
  type CkbScript,
  normalizeCkbTransactionForCcc,
  normalizeCkbTransactionForRpc,
} from '@ckb-on-ramp/contracts';
import { redactSecret } from '../utils/redact.js';
import { FundingPolicyError } from './errors.js';
import {
  assertFundingTxPolicy,
  parseU128Le,
  type CkbScriptLike,
  DEFAULT_ALLOWED_FUNDING_LOCK_CODE_HASHES,
  MAX_ALLOWED_FEE_SHANNONS,
  MAX_FUNDING_CELL_CAPACITY_SHANNONS,
  MAX_TOTAL_INPUT_CAPACITY_SHANNONS,
} from './fundingPolicy.js';
import type { OperatorInventory } from './fundingAvailability.js';

export {
  DEFAULT_ALLOWED_FUNDING_LOCK_CODE_HASHES,
  MAX_ALLOWED_FEE_SHANNONS,
  MAX_FUNDING_CELL_CAPACITY_SHANNONS,
  MAX_TOTAL_INPUT_CAPACITY_SHANNONS,
};

export interface CapacityGiftResult {
  txHash: string;
}

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
  getInventory?(fnnFundingLock: CkbScript): Promise<OperatorInventory>;
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

  async getInventory(fnnFundingLock: CkbScript): Promise<OperatorInventory> {
    try {
      const operatorLock = (await this.signer.getRecommendedAddressObj()).script;
      const giftCapacityShannons = await this.client.getBalanceSingle(operatorLock);
      const fnnCwbtcCells: OperatorInventory['fnnCwbtcCells'] = [];
      const fnnLock = {
        codeHash: fnnFundingLock.code_hash,
        hashType: fnnFundingLock.hash_type,
        args: fnnFundingLock.args,
      };
      const cwbtcType = {
        codeHash: CWBTC_SCRIPT.code_hash,
        hashType: CWBTC_SCRIPT.hash_type,
        args: CWBTC_SCRIPT.args,
      };
      for await (const cell of this.client.findCellsByLock(fnnLock, cwbtcType, true)) {
        const amount = parseU128Le(cell.outputData);
        if (amount !== null) {
          fnnCwbtcCells.push({ capacityShannons: cell.cellOutput.capacity, amount });
        }
      }
      return { giftCapacityShannons, fnnCwbtcCells };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read operator inventory: ${this.redactKey(msg)}`);
    }
  }

  async signFundingTransaction(unsignedTx: unknown, options?: SignFundingOptions): Promise<unknown> {
    try {
      const cccTxLike = normalizeCkbTransactionForCcc(unsignedTx) as Record<string, unknown>;
      const tx = Transaction.from(cccTxLike);

      // 1. Authenticate all inputs against live chain (force overwrite with verified chain data)
      for (const input of tx.inputs) {
        const liveCell = await this.client.getCell(input.previousOutput);
        if (!liveCell) {
          throw new FundingPolicyError(
            `Input cell not found on chain: ${input.previousOutput.txHash}:${input.previousOutput.index}`,
          );
        }
        input.cellOutput = liveCell.cellOutput;
        input.outputData = liveCell.outputData;
      }

      // 2. Enforce 5-gate pure policy validation
      const operatorLock = (await this.signer.getRecommendedAddressObj()).script;
      assertFundingTxPolicy(tx as any, {
        operatorLock,
        allowedFundingLockCodeHashes: options?.allowedFundingLockCodeHashes,
        allowedAdditionalInputLocks: options?.allowedAdditionalInputLocks,
        expectedExactUdtAmount: options?.expectedExactUdtAmount,
      });

      // 3. Sign operator inputs
      const signedTx = await this.signer.signOnlyTransaction(tx);
      // CCC Transaction holds BigInt/mol Proxy values that JSON.stringify cannot
      // serialize directly; round-trip with a bigint->hex replacer to get a plain
      // JSON value before converting keys back to snake_case RPC shape.
      const plain = JSON.parse(
        JSON.stringify(signedTx, (_key, v) =>
          typeof v === 'bigint' ? `0x${v.toString(16)}` : v,
        ),
      );
      return normalizeCkbTransactionForRpc(plain);
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
