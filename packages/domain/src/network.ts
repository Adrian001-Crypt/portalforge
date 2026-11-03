import { z } from 'zod';

export const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, 'expected 0x-prefixed hex');
export const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 32-byte hex');
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected 20-byte hex address');

/**
 * Expected identity of a network. Every reader/indexer/executor compares the live RPC against
 * this before doing anything, so a stale or swapped endpoint is rejected instead of trusted.
 */
export const NetworkProfile = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string(),
  kind: z.enum(['portaldot-testnet', 'local-dev', 'custom']),
  evm: z.object({
    rpcUrl: z.string().url(),
    chainId: z.number().int().positive(),
    /** Blocks to wait before treating a log as final when the RPC lacks a finalized tag. */
    confirmations: z.number().int().min(0).default(2),
    finalizedTag: z.boolean().default(true),
    nativeCurrency: z.object({ symbol: z.string(), decimals: z.number().int() }),
  }),
  native: z
    .object({
      wsUrl: z.string().url(),
      genesisHash: hex32,
      specName: z.string(),
      ss58Format: z.number().int(),
      token: z.object({ symbol: z.string(), decimals: z.number().int() }),
      nativeToEthRatio: z.string().regex(/^\d+$/),
    })
    .optional(),
  explorerUrl: z.string().url().optional(),
});
export type NetworkProfile = z.infer<typeof NetworkProfile>;

/** Values verified against the live network on 2026-11-03 (see docs/probe/). */
export const PORTALDOT_V3_TESTNET: NetworkProfile = {
  id: 'portaldot-v3-testnet',
  name: 'Portaldot V3 Testnet',
  kind: 'portaldot-testnet',
  evm: {
    rpcUrl: 'https://test-evm-rpc-v3.portaldot.dev',
    chainId: 420420777,
    confirmations: 2,
    finalizedTag: true,
    nativeCurrency: { symbol: 'tPOT', decimals: 18 },
  },
  native: {
    wsUrl: 'wss://test-node-v3.portaldot.dev',
    genesisHash: '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd',
    specName: 'portaldot-v3',
    ss58Format: 42,
    token: { symbol: 'tPOT', decimals: 14 },
    nativeToEthRatio: '10000',
  },
  explorerUrl: 'https://node-console.portaldot.dev/',
};

export const LOCAL_ANVIL: NetworkProfile = {
  id: 'local-anvil',
  name: 'Local Anvil (EVM only, not pallet-revive)',
  kind: 'local-dev',
  evm: {
    rpcUrl: 'http://127.0.0.1:8547',
    chainId: 31337,
    confirmations: 0,
    finalizedTag: true,
    nativeCurrency: { symbol: 'ETH', decimals: 18 },
  },
};

export const BUILTIN_NETWORKS: Record<string, NetworkProfile> = {
  [PORTALDOT_V3_TESTNET.id]: PORTALDOT_V3_TESTNET,
  [LOCAL_ANVIL.id]: LOCAL_ANVIL,
};
