import {
  Address,
  type Client,
  ClientPublicTestnet,
  SignerCkbPrivateKey,
  Transaction,
  fixedPointFrom,
} from '@ckb-ccc/core';

export interface CapacityGiftResult {
  txHash: string;
}

export interface OperatorCkbSender {
  sendCapacityGift(fundingAddress: string, amountCkb?: number | bigint): Promise<CapacityGiftResult>;
  waitForTransaction?(txHash: string): Promise<void>;
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
    const noPrefix = this.privateKey.replace(/^0x/, '');
    const withPrefix = this.privateKey.startsWith('0x') ? this.privateKey : `0x${this.privateKey}`;
    return message.replaceAll(withPrefix, '[REDACTED_KEY]').replaceAll(noPrefix, '[REDACTED_KEY]');
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
