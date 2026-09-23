const readPositiveInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
};

const fnnRpcUrl = process.env.FNN_RPC_URL ?? 'http://127.0.0.1:8227';

export const config = {
  port: readPositiveInt('PORT', 3001),
  mode: 'testnet' as const,
  fnnRpcUrl,
  cchRpcUrl: process.env.CCH_RPC_URL?.trim() || fnnRpcUrl,
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  baseFeeSats: readPositiveInt('CCH_BASE_FEE_SATS', 100),
  feeRatePpm: readPositiveInt('CCH_FEE_RATE_PPM', 3000),
  ckbRpcUrl: process.env.CKB_RPC_URL?.trim() || undefined,
  operatorCkbPrivateKey: process.env.OPERATOR_CKB_PRIVATE_KEY?.trim() || undefined,
  operatorChannelFundingAmount: process.env.OPERATOR_CHANNEL_FUNDING_AMOUNT?.trim() || '100000000',
  skipCapacityGift: process.env.SKIP_CAPACITY_GIFT === '1',
} as const;
