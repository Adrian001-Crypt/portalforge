import { PfError } from './errors';

/**
 * Portaldot V3 testnet units, verified live (docs/network-capabilities.md):
 *  - native: tPOT with 14 decimals (system_properties)
 *  - EVM side (pallet-revive eth-rpc): balances exposed with 18 decimals,
 *    Revive.NativeToEthRatio = 10^4
 * Never mix the two without converting through these helpers.
 */
export interface UnitSpec { symbol: string; decimals: number }

export function formatUnits(value: bigint, decimals: number, maxFraction = decimals): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}

export function parseUnits(text: string, decimals: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new PfError('VALIDATION_FAILED', `not a decimal amount: ${text}`);
  const frac = m[3] ?? '';
  if (frac.length > decimals) throw new PfError('VALIDATION_FAILED', `more than ${decimals} fractional digits`);
  const v = BigInt(m[2]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return m[1] ? -v : v;
}

export const formatAmount = (value: bigint, unit: UnitSpec, maxFraction = 6) =>
  `${formatUnits(value, unit.decimals, maxFraction)} ${unit.symbol}`;

/** Convert an EVM-side (18 dp) balance to native planck (14 dp). Truncates dust below the ratio. */
export const ethToNative = (wei: bigint, ratio: bigint) => wei / ratio;
export const nativeToEth = (planck: bigint, ratio: bigint) => planck * ratio;
