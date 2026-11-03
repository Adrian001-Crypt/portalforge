import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem';
import { JobRegistryAbi } from '@portalforge/domain';
import type { EvmBlockHeader, EvmLog } from '@portalforge/portaldot-evm';
import type { EvmSource } from '../src/evm';

/** Scripted EVM chain with reorg, failure and duplicate-log injection. */
export class FakeChain implements EvmSource {
  blocks: EvmBlockHeader[] = [];
  logsByBlock = new Map<number, EvmLog[]>();
  failNext = 0;
  failLogs = 0;
  duplicateLogs = false;
  finalizedLag = 2;
  calls = { logs: 0 };
  private salt = 0;
  constructor(public height = 0) { for (let i = 0; i <= height; i++) this.pushBlock(); }

  private pushBlock() {
    const n = this.blocks.length;
    const parent = n === 0 ? ('0x' + '0'.repeat(64)) as Hex : this.blocks[n - 1].hash;
    this.blocks.push({ number: n, hash: keccak256(toHex(`b${n}:${this.salt}:${parent}`)), parentHash: parent, timestamp: 1_700_000_000 + n * 6 });
  }
  mine(k = 1) { for (let i = 0; i < k; i++) this.pushBlock(); }

  /** Replace blocks >= n with a new fork of the same length (+extra). Logs in those blocks are dropped unless re-added. */
  reorg(n: number, extra = 0) {
    const len = this.blocks.length;
    this.salt++;
    this.blocks = this.blocks.slice(0, n);
    for (const k of [...this.logsByBlock.keys()]) if (k >= n) this.logsByBlock.delete(k);
    while (this.blocks.length < len + extra) this.pushBlock();
  }

  jobRequested(block: number, address: Hex, jobId: bigint, input: bigint, logIndex = 0, txIndex = 0): EvmLog {
    const topics = encodeEventTopics({ abi: JobRegistryAbi, eventName: 'JobRequested', args: { jobId, requester: '0x00000000000000000000000000000000000000b0' } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }], [input, keccak256(toHex(`${jobId}`))]);
    return this.addLog(block, { address, topics, data, logIndex, txIndex });
  }

  addLog(block: number, l: { address: Hex; topics: Hex[]; data: Hex; logIndex: number; txIndex?: number }): EvmLog {
    const b = this.blocks[block];
    const log: EvmLog = { address: l.address.toLowerCase() as Hex, blockHash: b.hash, blockNumber: block, data: l.data, logIndex: l.logIndex, removed: false, topics: l.topics, transactionHash: keccak256(toHex(`tx${block}:${l.txIndex ?? 0}:${b.hash}`)), transactionIndex: l.txIndex ?? 0 };
    this.logsByBlock.set(block, [...(this.logsByBlock.get(block) ?? []), log]);
    return log;
  }

  private maybeFail() { if (this.failNext > 0) { this.failNext--; throw new Error('ECONNRESET (injected)'); } }
  async blockNumber() { this.maybeFail(); return this.blocks.length - 1; }
  async block(tag: number | 'latest' | 'finalized' | 'safe') {
    this.maybeFail();
    const head = this.blocks.length - 1;
    const n = tag === 'latest' ? head : tag === 'finalized' || tag === 'safe' ? Math.max(0, head - this.finalizedLag) : tag;
    return this.blocks[n] ?? null;
  }
  async logs(f: { fromBlock: number; toBlock: number; address?: Hex | Hex[] }) {
    this.calls.logs++;
    if (this.failLogs > 0) { this.failLogs--; throw new Error('upstream 503 (injected)'); }
    const out: EvmLog[] = [];
    for (let n = f.fromBlock; n <= f.toBlock; n++) for (const l of this.logsByBlock.get(n) ?? []) if (!f.address || l.address === String(f.address).toLowerCase()) out.push(l);
    return this.duplicateLogs ? [...out, ...out] : out;
  }
}
