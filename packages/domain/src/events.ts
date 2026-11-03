import { z } from 'zod';

export const Finality = z.enum(['unconfirmed', 'safe', 'finalized', 'orphaned']);
export type Finality = z.infer<typeof Finality>;

/**
 * One normalized observation. EVM logs and native events share this envelope but keep their
 * interface tag; PortalForge never merges an EVM log with a native event unless a rule that can
 * be checked on-chain links them (see correlation in docs/architecture.md).
 */
export interface EventEnvelope {
  id: string; // `${networkId}:${interface}:${blockHash}:${txIndex}:${logIndex}`
  networkId: string;
  chainId: number | null;
  genesisHash: string | null;
  interface: 'evm' | 'native';
  blockNumber: number;
  blockHash: string;
  txHash: string | null; // EVM tx hash, or extrinsic hash for native
  extrinsicIndex: number | null;
  logIndex: number;
  contract: string | null;
  eventName: string | null;
  decoderVersion: string | null;
  args: Record<string, unknown> | null;
  decodeError: string | null;
  finality: Finality;
  observedAt: string;
  raw: { topics?: string[]; data?: string; section?: string; method?: string; phase?: string };
}
