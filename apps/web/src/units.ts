export function formatUnits(value: bigint, decimals: number, maxFraction = 6): string {
  const neg = value < 0n; const abs = neg ? -value : value; const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  return `${neg ? '-' : ''}${(abs / base).toString()}${frac ? '.' + frac : ''}`;
}
