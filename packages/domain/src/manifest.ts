import { z } from 'zod';
import { address, hex, hex32 } from './network';

export const ManifestContract = z.object({
  name: z.string(),
  runtime: z.enum(['evm', 'wasm']),
  address,
  deployTx: hex32,
  deployBlock: z.number().int().nonnegative(),
  deployBlockHash: hex32,
  deployer: address,
  /** keccak256 of the deployed runtime bytecode read back from the chain via eth_getCode. */
  runtimeCodeHash: hex32,
  /** keccak256 of the compiler's deployedBytecode (immutables zeroed when present). */
  artifactRuntimeHash: hex32,
  abiHash: hex32,
  constructorArgs: z.array(z.string()).default([]),
  version: z.string(),
  owner: address.optional(),
});

export const DeploymentManifest = z.object({
  schema: z.literal('portalforge.deployment/v1'),
  network: z.object({
    id: z.string(),
    chainId: z.number().int(),
    genesisHash: hex32.optional(),
    specName: z.string().optional(),
    specVersion: z.number().int().optional(),
    evmClientVersion: z.string().optional(),
  }),
  source: z.object({ repo: z.string(), commit: z.string(), dirty: z.boolean() }),
  compiler: z.object({ solc: z.string(), optimizer: z.boolean(), runs: z.number().int(), evmVersion: z.string(), viaIR: z.boolean() }),
  contracts: z.array(ManifestContract).min(1),
  createdAt: z.string(),
  notes: z.array(z.string()).default([]),
});
export type DeploymentManifest = z.infer<typeof DeploymentManifest>;
export type ManifestContract = z.infer<typeof ManifestContract>;

export const hexString = hex;
