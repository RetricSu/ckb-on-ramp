import type { CkbScript } from '@ckb-on-ramp/contracts';
import { config } from '../config.js';
import type { OperatorCkbSender } from './ccc.js';
import type { CchGateway } from './cch.js';
import { MAX_ALLOWED_FEE_SHANNONS } from './fundingPolicy.js';

export const CAPACITY_GIFT_SHANNONS = 20_000_000_000n; // 200 CKB
export const CHANNEL_SIDE_CAPACITY_SHANNONS = 18_400_000_000n; // 184 CKB

export interface OperatorInventory {
  giftCapacityShannons: bigint;
  fnnCwbtcCells: Array<{ capacityShannons: bigint; amount: bigint }>;
}

export interface ReceiveReadiness {
  canReceive: boolean;
  reason?: string;
  inventory?: OperatorInventory;
}

export function parseFundingLimit(value = config.operatorChannelFundingAmount): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error('OPERATOR_CHANNEL_FUNDING_AMOUNT must be a positive integer');
  }
  const limit = BigInt(value);
  if (limit <= 0n || limit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('OPERATOR_CHANNEL_FUNDING_AMOUNT is outside the supported range');
  }
  return limit;
}

export function assertWithinFundingLimit(amount: bigint, limit = parseFundingLimit()): void {
  if (amount <= 0n) throw new Error('Funding amount must be positive');
  if (amount > limit) {
    throw new Error(`Amount (${amount}) exceeds operator channel funding limit (${limit})`);
  }
}

export function assertOperatorInventory(
  inventory: OperatorInventory,
  fundingAmount: bigint,
  externalFunding: boolean,
): void {
  const requiredGiftCapacity =
    (externalFunding ? CHANNEL_SIDE_CAPACITY_SHANNONS : CAPACITY_GIFT_SHANNONS) + MAX_ALLOWED_FEE_SHANNONS;
  if (inventory.giftCapacityShannons < requiredGiftCapacity) {
    throw new Error(
      `Operator gift CKB inventory is insufficient: available ${inventory.giftCapacityShannons} shannons, required ${requiredGiftCapacity}`,
    );
  }

  const totalCwbtc = inventory.fnnCwbtcCells.reduce((sum, cell) => sum + cell.amount, 0n);
  if (totalCwbtc < fundingAmount) {
    throw new Error(
      `Operator FNN cWBTC inventory is insufficient: available ${totalCwbtc} raw, required ${fundingAmount}`,
    );
  }

  // Fiber v0.9.0 requires the acceptor's UDT input to equal the channel amount.
  // A larger cell would create a change output in the wrong position and fail verification.
  const exactCell = inventory.fnnCwbtcCells.find((cell) => cell.amount === fundingAmount);
  if (!exactCell) {
    throw new Error(`Operator FNN has no exact ${fundingAmount} raw cWBTC cell available for this channel`);
  }
  if (exactCell.capacityShannons < CHANNEL_SIDE_CAPACITY_SHANNONS) {
    throw new Error(
      `Operator FNN CKB inventory is insufficient: exact cWBTC cell has ${exactCell.capacityShannons} shannons, required ${CHANNEL_SIDE_CAPACITY_SHANNONS}`,
    );
  }
}

export async function getReceiveReadiness(options: {
  gateway: CchGateway;
  sender?: OperatorCkbSender;
  fundingAmount?: string;
  externalFunding?: boolean;
  inventory?: OperatorInventory;
}): Promise<ReceiveReadiness> {
  try {
    const amount = BigInt(options.fundingAmount ?? config.operatorChannelFundingAmount);
    assertWithinFundingLimit(amount);

    let inventory = options.inventory;
    if (!inventory) {
      if (!options.sender?.getInventory) {
        return { canReceive: false, reason: 'Operator inventory reader is not configured' };
      }
      if (!options.gateway.getFnnFundingLockScript) {
        return { canReceive: false, reason: 'FNN funding lock is unavailable; inventory cannot be verified' };
      }
      const fnnLock: CkbScript | undefined = await options.gateway.getFnnFundingLockScript();
      if (!fnnLock) {
        return { canReceive: false, reason: 'FNN funding lock is unavailable; inventory cannot be verified' };
      }
      inventory = await options.sender.getInventory(fnnLock);
    }

    assertOperatorInventory(inventory, amount, options.externalFunding ?? true);
    return { canReceive: true, inventory };
  } catch (error) {
    return { canReceive: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
