const readPositiveInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
};

export const config = {
  port: readPositiveInt('PORT', 3001),
  mode: process.env.CCH_MODE === 'rpc' ? 'rpc' : 'mock',
  fnnRpcUrl: process.env.FNN_RPC_URL ?? 'http://127.0.0.1:8227',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  baseFeeSats: readPositiveInt('CCH_BASE_FEE_SATS', 100),
  feeRatePpm: readPositiveInt('CCH_FEE_RATE_PPM', 3000),
} as const;
