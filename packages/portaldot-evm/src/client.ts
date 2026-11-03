import { PfError, type NetworkProfile } from '@portalforge/domain';
import { keccak256, type Hex } from 'viem';
import { rpc, rpcRaw } from './rpc';

export interface EvmBlockHeader { number: number; hash: Hex; parentHash: Hex; timestamp: number }
export interface EvmLog {
  address: Hex; blockHash: Hex; blockNumber: number; data: Hex; logIndex: number;
  removed: boolean; topics: Hex[]; transactionHash: Hex; transactionIndex: number;
}
export interface EvmReceipt {
  transactionHash: Hex; blockHash: Hex; blockNumber: number; status: 'success' | 'reverted';
  contractAddress: Hex | null; from: Hex; to: Hex | null; gasUsed: bigint; effectiveGasPrice: bigint; logs: EvmLog[];
}

const n = (h: string) => Number.parseInt(h, 16);
const toLog = (l: any): EvmLog => ({
  address: l.address.toLowerCase(), blockHash: l.blockHash, blockNumber: n(l.blockNumber), data: l.data,
  logIndex: n(l.logIndex), removed: !!l.removed, topics: l.topics, transactionHash: l.transactionHash,
  transactionIndex: n(l.transactionIndex ?? '0x0'),
});

/** Thin, explicit EVM reader. Every method either returns data or throws a PfError; never "empty on failure". */
export class EvmReader {
  constructor(readonly url: string, readonly timeoutMs = 12_000, readonly fetchImpl: typeof fetch = fetch) {}
  private call<T>(m: string, p: unknown[] = []) { return rpc<T>(this.url, m, p, this.timeoutMs, this.fetchImpl); }
  raw<T>(m: string, p: unknown[] = []) { return rpcRaw<T>(this.url, m, p, this.timeoutMs, this.fetchImpl); }

  async chainId() { return n(await this.call<string>('eth_chainId')); }
  async clientVersion() { return this.call<string>('web3_clientVersion'); }
  async blockNumber() { return n(await this.call<string>('eth_blockNumber')); }
  async gasPrice() { return BigInt(await this.call<string>('eth_gasPrice')); }
  async balance(addr: Hex) { return BigInt(await this.call<string>('eth_getBalance', [addr, 'latest'])); }
  async nonce(addr: Hex, tag = 'pending') { return n(await this.call<string>('eth_getTransactionCount', [addr, tag])); }

  async block(tag: number | 'latest' | 'finalized' | 'safe'): Promise<EvmBlockHeader | null> {
    const b = await this.call<any>('eth_getBlockByNumber', [typeof tag === 'number' ? `0x${tag.toString(16)}` : tag, false]);
    return b ? { number: n(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: n(b.timestamp) } : null;
  }

  async logs(filter: { fromBlock: number; toBlock: number; address?: Hex | Hex[]; topics?: (Hex | Hex[] | null)[] }): Promise<EvmLog[]> {
    if (filter.toBlock < filter.fromBlock) throw new PfError('BAD_REQUEST', 'toBlock < fromBlock');
    const res = await this.call<any[]>('eth_getLogs', [{
      fromBlock: `0x${filter.fromBlock.toString(16)}`, toBlock: `0x${filter.toBlock.toString(16)}`,
      ...(filter.address ? { address: filter.address } : {}), ...(filter.topics ? { topics: filter.topics } : {}),
    }]);
    if (!Array.isArray(res)) throw new PfError('RPC_ERROR', 'eth_getLogs returned non-array');
    return res.map(toLog);
  }

  async receipt(txHash: Hex): Promise<EvmReceipt | null> {
    const r = await this.call<any>('eth_getTransactionReceipt', [txHash]);
    if (!r) return null;
    return {
      transactionHash: r.transactionHash, blockHash: r.blockHash, blockNumber: n(r.blockNumber),
      status: r.status === '0x1' ? 'success' : 'reverted', contractAddress: r.contractAddress ? r.contractAddress.toLowerCase() : null,
      from: r.from.toLowerCase(), to: r.to ? r.to.toLowerCase() : null, gasUsed: BigInt(r.gasUsed),
      effectiveGasPrice: BigInt(r.effectiveGasPrice ?? '0x0'), logs: (r.logs ?? []).map(toLog),
    };
  }

  async transaction(txHash: Hex) { return this.call<any>('eth_getTransactionByHash', [txHash]); }
  async code(addr: Hex, tag: string = 'latest') { return this.call<Hex>('eth_getCode', [addr, tag]); }
  async codeHash(addr: Hex) { const c = await this.code(addr); return c === '0x' ? null : keccak256(c); }
  async call_(tx: { to?: Hex; data: Hex; from?: Hex }, tag = 'latest') { return this.call<Hex>('eth_call', [tx, tag]); }
  async estimateGas(tx: { to?: Hex; data: Hex; from?: Hex; value?: Hex }) { return BigInt(await this.call<string>('eth_estimateGas', [tx])); }

  /** Fail closed when the endpoint is not the network we were configured for. */
  async assertIdentity(profile: NetworkProfile) {
    const id = await this.chainId();
    if (id !== profile.evm.chainId) throw new PfError('NETWORK_MISMATCH', `expected chainId ${profile.evm.chainId}, endpoint reports ${id}`, { expected: profile.evm.chainId, actual: id });
    return id;
  }
}
