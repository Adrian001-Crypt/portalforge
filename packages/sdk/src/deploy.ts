import { encodeDeployData, keccak256, getContractAddress, type Hex, type Abi } from 'viem';
import { PfError, type NetworkProfile, type DeploymentManifest, type ManifestContract } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';
import type { NativeReader } from '@portalforge/portaldot-native';
import { h160ToFallbackAccountId } from '@portalforge/portaldot-native';
import type { ContractArtifact } from './artifacts';

export interface DepositDryRun { ok: boolean; storageDeposit: bigint | null; origin: Hex; error?: string }

/**
 * Exact storage deposit for a create, from the runtime itself (reviveApi.instantiate dry-run).
 * The EVM gas estimate folds the deposit into gas; this separates it. Read-only — nothing is signed.
 * The origin must hold enough balance or the runtime reports StorageDepositNotEnoughFunds.
 */
export async function dryRunDeposit(native: NativeReader, origin: Hex, initCode: Hex): Promise<DepositDryRun> {
  const fn = (native.api.call as any).reviveApi?.instantiate;
  if (!fn) return { ok: false, storageDeposit: null, origin, error: 'reviveApi.instantiate not exposed' };
  const r = (await fn(h160ToFallbackAccountId(origin), 0, null, null, { Upload: initCode }, '0x', null)).toJSON();
  if (r.result?.err) {
    let error = JSON.stringify(r.result.err);
    const mod = r.result.err.module;
    if (mod) { try { const m = native.api.registry.findMetaError({ index: native.api.createType('u8', mod.index), error: native.api.createType('[u8;4]', mod.error) } as any); error = `${m.section}.${m.name}`; } catch { /* keep raw */ } }
    return { ok: false, storageDeposit: null, origin, error };
  }
  return { ok: true, storageDeposit: BigInt(r.storageDeposit?.charge ?? 0), origin };
}

export interface PlannedContract {
  name: string; artifact: ContractArtifact; args: Hex[]; initCode: Hex;
  simulation: { ok: boolean; runtimeMatches: boolean | null; error?: string };
  gas: bigint | null; fee: bigint | null;
  deposit?: DepositDryRun;
}
export interface DeploymentPlan {
  networkId: string; chainId: number; deployer: Hex; deployerBalance: bigint | null; gasPrice: bigint;
  contracts: PlannedContract[]; totalFee: bigint; blockers: string[]; warnings: string[]; createdAt: string;
}

export const DEPLOY_PROFILES = {
  minimal: ['JobRegistry', 'EvidenceRegistry'],
  full: ['JobRegistry', 'EvidenceRegistry', 'WorkflowExecutionRegistry'],
} as const;

const GAS_MARGIN_BPS = 500n; // +5% over estimate; storage deposit dominates, so keep the margin small.
const PRICE_MARGIN_BPS = 200n; // +2% over eth_gasPrice

/**
 * Build a deployment plan without signing: identity check, eth_call simulation of each create
 * (runtime code compared with the artifact), gas/fee estimates, and a balance check. Any RPC
 * failure becomes a blocker — a plan never silently assumes a fee or balance.
 */
export async function planDeployment(profile: NetworkProfile, opts: { deployer: Hex; executor: Hex; artifacts: ContractArtifact[]; native?: NativeReader | null; depositOrigin?: Hex }): Promise<DeploymentPlan> {
  const evm = new EvmReader(profile.evm.rpcUrl);
  const blockers: string[] = []; const warnings: string[] = [];
  const chainId = await evm.assertIdentity(profile);
  const gasPrice = (await evm.gasPrice()) * (10_000n + PRICE_MARGIN_BPS) / 10_000n;
  let deployerBalance: bigint | null = null;
  try { deployerBalance = await evm.balance(opts.deployer); } catch (e) { blockers.push(`balance read failed: ${(e as Error).message}`); }
  const contracts: PlannedContract[] = [];
  for (const art of opts.artifacts) {
    const args = constructorArgs(art.name, opts.deployer, opts.executor);
    const initCode = encodeDeployData({ abi: art.abi as Abi, bytecode: art.bytecode, args });
    let simulation: PlannedContract['simulation'];
    const sim = await evm.raw<Hex>('eth_call', [{ from: opts.deployer, data: initCode }, 'latest']);
    if (sim.ok) simulation = { ok: true, runtimeMatches: keccak256(sim.value) === art.artifactRuntimeHash };
    else simulation = { ok: false, runtimeMatches: null, error: sim.error.message };
    if (!simulation.ok) blockers.push(`${art.name}: simulation failed (${simulation.error})`);
    else if (!simulation.runtimeMatches) blockers.push(`${art.name}: simulated runtime code differs from artifact`);
    let gas: bigint | null = null;
    const est = await evm.raw<string>('eth_estimateGas', [{ from: opts.deployer, data: initCode }]);
    if (est.ok) gas = BigInt(est.value) * (10_000n + GAS_MARGIN_BPS) / 10_000n; else blockers.push(`${art.name}: estimateGas failed (${est.error.message})`);
    let deposit: DepositDryRun | undefined;
    if (opts.native) {
      deposit = await dryRunDeposit(opts.native, opts.depositOrigin ?? opts.deployer, initCode);
      if (!deposit.ok) warnings.push(`${art.name}: deposit dry-run from ${deposit.origin} failed (${deposit.error})`);
    }
    contracts.push({ name: art.name, artifact: art, args, initCode, simulation, gas, fee: gas === null ? null : gas * gasPrice, deposit });
  }
  const totalFee = contracts.reduce((s, c) => s + (c.fee ?? 0n), 0n);
  if (deployerBalance !== null && deployerBalance < totalFee) blockers.push(`deployer balance ${deployerBalance} < estimated max fee ${totalFee} (wei, 18 dp)`);
  if (profile.kind === 'portaldot-testnet') warnings.push('pallet-revive folds the storage deposit (≈ depositPerByte × code size × 1.3 lockup) into gas; most of the fee is a held deposit, not burned gas (to be confirmed from receipts).');
  return { networkId: profile.id, chainId, deployer: opts.deployer, deployerBalance, gasPrice, contracts, totalFee, blockers, warnings, createdAt: new Date().toISOString() };
}

export function constructorArgs(name: string, owner: Hex, executor: Hex): Hex[] {
  switch (name) {
    case 'JobRegistry': case 'EvidenceRegistry': case 'WorkflowExecutionRegistry': return [owner, executor];
    default: throw new PfError('NOT_SUPPORTED', `no constructor mapping for ${name}`);
  }
}

export interface DeployJournalEntry { name: string; nonce: number; txHash?: Hex; predictedAddress: Hex; state: 'intent' | 'sent' | 'confirmed' | 'failed'; error?: string }

/** Assemble a manifest from confirmed receipts. Called after each contract confirms, so partial progress is never lost. */
export function manifestContract(art: ContractArtifact, args: Hex[], r: { address: Hex; txHash: Hex; blockNumber: number; blockHash: Hex; deployer: Hex; runtimeCodeHash: Hex }): ManifestContract {
  return {
    name: art.name, runtime: 'evm', address: r.address, deployTx: r.txHash, deployBlock: r.blockNumber, deployBlockHash: r.blockHash,
    deployer: r.deployer, runtimeCodeHash: r.runtimeCodeHash, artifactRuntimeHash: art.artifactRuntimeHash, abiHash: art.abiHash,
    constructorArgs: args, version: '1.0.0', owner: r.deployer,
  };
}

export const predictCreateAddress = (from: Hex, nonce: number) => getContractAddress({ from, nonce: BigInt(nonce) });
export type { DeploymentManifest };
