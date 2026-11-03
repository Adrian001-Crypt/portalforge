import { BaseError, ContractFunctionRevertedError, decodeErrorResult, decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Hex, type AbiFunction } from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { PfError, type NetworkProfile } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';

/**
 * What the engine needs from a chain. The EVM implementation signs locally with a dedicated
 * low-privilege executor key so the transaction hash is known — and persisted — before broadcast.
 */
export interface ChainExecutor {
  readonly networkId: string;
  readonly address: Hex;
  assertNetwork(): Promise<void>;
  simulate(to: Hex, data: Hex): Promise<{ ok: true; returnData: Hex } | { ok: false; revertData: Hex | null; message: string }>;
  estimate(to: Hex, data: Hex): Promise<{ gas: bigint; gasPrice: bigint; fee: bigint; balance: bigint }>;
  pendingNonce(): Promise<number>;
  latestNonce(): Promise<number>;
  sign(to: Hex, data: Hex, nonce: number, gas: bigint, gasPrice: bigint): Promise<{ raw: Hex; hash: Hex }>;
  broadcast(raw: Hex): Promise<{ accepted: boolean; known?: boolean; error?: string }>;
  receipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: number; blockHash: Hex; gasUsed: bigint; effectiveGasPrice: bigint } | null>;
  txKnown(hash: Hex): Promise<boolean>;
  safeBlock(): Promise<number>;
  read(to: Hex, data: Hex): Promise<Hex>;
}

export class EvmChainExecutor implements ChainExecutor {
  readonly networkId: string;
  readonly address: Hex;
  private evm: EvmReader;
  constructor(readonly profile: NetworkProfile, private account: LocalAccount, rpcUrl = profile.evm.rpcUrl) {
    this.networkId = profile.id;
    this.address = account.address;
    this.evm = new EvmReader(rpcUrl, 20_000);
  }
  async assertNetwork() { await this.evm.assertIdentity(this.profile); }
  async simulate(to: Hex, data: Hex) {
    const r = await this.evm.raw<Hex>('eth_call', [{ from: this.address, to, data }, 'latest']);
    if (r.ok) return { ok: true as const, returnData: r.value };
    if (r.error.kind === 'rpc_error') {
      const m = /0x[0-9a-fA-F]{8,}/.exec(r.error.message);
      return { ok: false as const, revertData: (m?.[0] as Hex) ?? null, message: r.error.message };
    }
    throw new PfError('RPC_UNREACHABLE', `simulate: ${r.error.message}`);
  }
  async estimate(to: Hex, data: Hex) {
    const [gas, gasPrice, balance] = await Promise.all([this.evm.estimateGas({ from: this.address, to, data }), this.evm.gasPrice(), this.evm.balance(this.address)]);
    const g = (gas * 110n) / 100n;
    const p = (gasPrice * 102n) / 100n;
    return { gas: g, gasPrice: p, fee: g * p, balance };
  }
  pendingNonce() { return this.evm.nonce(this.address, 'pending'); }
  latestNonce() { return this.evm.nonce(this.address, 'latest'); }
  async sign(to: Hex, data: Hex, nonce: number, gas: bigint, gasPrice: bigint) {
    const raw = await this.account.signTransaction!({ to, data, nonce, gas, gasPrice, chainId: this.profile.evm.chainId, type: 'legacy', value: 0n });
    return { raw, hash: keccak256(raw) };
  }
  async broadcast(raw: Hex) {
    const r = await this.evm.raw<Hex>('eth_sendRawTransaction', [raw]);
    if (r.ok) return { accepted: true };
    const msg = r.error.message.toLowerCase();
    if (/already known|already imported|nonce too low|known transaction/.test(msg)) return { accepted: false, known: true, error: r.error.message };
    if (r.error.kind === 'rpc_error') return { accepted: false, error: r.error.message };
    throw new PfError('RPC_UNREACHABLE', `broadcast: ${r.error.message}`); // ambiguous: maybe delivered
  }
  async receipt(hash: Hex) {
    const r = await this.evm.receipt(hash);
    return r ? { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice } : null;
  }
  async txKnown(hash: Hex) { return !!(await this.evm.transaction(hash)); }
  async safeBlock() {
    if (this.profile.evm.finalizedTag) { const b = await this.evm.block('safe'); if (b) return b.number; }
    return (await this.evm.blockNumber()) - this.profile.evm.confirmations;
  }
  read(to: Hex, data: Hex) { return this.evm.call_({ to, data }); }
}

export function findFunction(abi: Abi, name: string): AbiFunction {
  const fns = abi.filter((x): x is AbiFunction => x.type === 'function' && x.name === name);
  if (fns.length !== 1) throw new PfError('POLICY_DENIED', fns.length ? `overloaded function ${name} is not allowed` : `function ${name} not in ABI`);
  return fns[0];
}

export function decodeRevert(abi: Abi, data: Hex | null): string | null {
  if (!data) return null;
  try { return decodeErrorResult({ abi, data }).errorName; } catch { return null; }
}

/**
 * Business-level reconciliation for allowlisted functions: after an ambiguous outcome or an
 * "already done" revert, read contract state to decide whether THIS execution's effect is applied.
 */
export type Reconciler = (ctx: { read: (fn: string, args: unknown[]) => Promise<unknown>; args: unknown[]; executor: Hex }) => Promise<'applied' | 'applied_by_other' | 'not_applied'>;

export const RECONCILERS: Partial<Record<string, Reconciler>> = {
  completeJob: async ({ read, args }) => {
    const stored = (await read('executionOf', [args[0]])) as Hex;
    if (/^0x0+$/.test(stored)) return 'not_applied';
    return stored.toLowerCase() === String(args[1]).toLowerCase() ? 'applied' : 'applied_by_other';
  },
  register: async ({ read, args, executor }) => {
    const [id, kind, subject, contentHash] = args;
    const st = Number(await read('status', [id, kind, subject, contentHash, executor]));
    return st === 0 ? 'not_applied' : st === 1 ? 'applied' : 'applied_by_other';
  },
  registerVersion: async ({ read, args }) => {
    const { encodeAbiParameters } = await import('viem');
    const key = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [args[0] as Hex, Number(args[1])]));
    const stored = (await read('definitionOf', [key])) as Hex;
    return /^0x0+$/.test(stored) ? 'not_applied' : stored.toLowerCase() === String(args[2]).toLowerCase() ? 'applied' : 'applied_by_other';
  },
  recordExecution: async ({ read, args }) => (/^0x0+$/.test((await read('executionCommitmentOf', [args[0]])) as string) ? 'not_applied' : 'applied'),
};

export const readFn = (chain: ChainExecutor, abi: Abi, to: Hex) => async (fn: string, args: unknown[]) => {
  const data = encodeFunctionData({ abi, functionName: fn, args } as any);
  return decodeFunctionResult({ abi, functionName: fn, data: await chain.read(to, data) } as any);
};

export const isRevert = (e: unknown) => e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
