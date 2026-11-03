import { createHash } from 'node:crypto';

/**
 * Key shared by an EVM log and the native Revive.ContractEmitted event that produced it.
 * Two observations are only linked when (a) keys are equal and (b) the EVM block hash equals
 * reviveApi.ethBlockHash(blockNumber) recorded by the native indexer — both checkable on-chain.
 */
export const correlationKey = (blockNumber: number, address: string, topics: string[], data: string, ordinal: number) =>
  createHash('sha256').update(`${blockNumber}|${address.toLowerCase()}|${topics.map((t) => t.toLowerCase()).join(',')}|${data.toLowerCase()}|${ordinal}`).digest('hex');

/** Assign per-block ordinals so identical logs in one block still pair 1:1 in emission order. */
export function withOrdinals<T extends { blockNumber: number; address: string; topics: string[]; data: string }>(items: T[]): (T & { correlationKey: string })[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const base = `${it.blockNumber}|${it.address.toLowerCase()}|${it.topics.join(',').toLowerCase()}|${it.data.toLowerCase()}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...it, correlationKey: correlationKey(it.blockNumber, it.address, it.topics, it.data, n) };
  });
}
