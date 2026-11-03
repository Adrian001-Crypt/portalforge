import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, type Abi, type Hex } from 'viem';
import { canonicalize, hashCanonical } from '@portalforge/domain';

export interface ContractArtifact {
  name: string; abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  abiHash: Hex; artifactRuntimeHash: Hex; initCodeHash: Hex; runtimeBytes: number;
  compiler: { solc: string; optimizer: boolean; runs: number; evmVersion: string; viaIR: boolean };
}

/** Load a Foundry artifact. Hashes are computed locally so a manifest can be re-derived from source. */
export function loadFoundryArtifact(outDir: string, name: string): ContractArtifact {
  const art = JSON.parse(readFileSync(join(outDir, `${name}.sol`, `${name}.json`), 'utf8'));
  const md = typeof art.rawMetadata === 'string' ? JSON.parse(art.rawMetadata) : art.metadata;
  const settings = md?.settings ?? {};
  return {
    name, abi: art.abi, bytecode: art.bytecode.object, deployedBytecode: art.deployedBytecode.object,
    abiHash: hashCanonical(art.abi), artifactRuntimeHash: keccak256(art.deployedBytecode.object), initCodeHash: keccak256(art.bytecode.object),
    runtimeBytes: (art.deployedBytecode.object.length - 2) / 2,
    compiler: { solc: md?.compiler?.version ?? 'unknown', optimizer: !!settings.optimizer?.enabled, runs: settings.optimizer?.runs ?? 0, evmVersion: settings.evmVersion ?? 'unknown', viaIR: !!settings.viaIR },
  };
}

export const abiHash = (abi: unknown) => keccak256(new TextEncoder().encode(canonicalize(abi)));
