export const CWBTC_DECIMALS = 8;

export function parseCwbtc(value: string): bigint {
  if (!/^\d+(?:\.\d{0,8})?$/.test(value.trim())) throw new Error('Use a positive amount with up to 8 decimal places.');
  const [whole = '0', fraction = ''] = value.trim().split('.');
  const raw = BigInt(whole) * 10n ** 8n + BigInt(fraction.padEnd(8, '0'));
  if (raw <= 0n) throw new Error('Amount must be greater than zero.');
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount is too large for this preview.');
  return raw;
}

export function formatCwbtc(rawValue: string): string {
  const raw = BigInt(rawValue);
  const whole = raw / 10n ** 8n;
  const fraction = (raw % 10n ** 8n).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export const toHex = (value: bigint): `0x${string}` => `0x${value.toString(16)}`;
