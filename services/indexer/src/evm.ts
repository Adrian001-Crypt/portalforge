import { decodeEventLog, type Abi, type Hex } from 'viem';
import { PfError, type NetworkProfile } from '@portalforge/domain';
import { type Db, json, now, parse } from '@portalforge/store';
import type { EvmBlockHeader, EvmLog } from '@portalforge/portaldot-evm';
import { withOrdinals } from './correlation';

/** The subset of EvmReader the indexer needs; tests inject a scripted chain. */
export interface EvmSource {
  blockNumber(): Promise<number>;
  block(tag: number | 'latest' | 'finalized' | 'safe'): Promise<EvmBlockHeader | null>;
  logs(f: { fromBlock: number; toBlock: number; address?: Hex | Hex[] }): Promise<EvmLog[]>;
}

export interface IndexerOptions { maxChunk?: number; minChunk?: number; reorgCheckLimit?: number; log?: (msg: string, data?: Record<string, unknown>) => void }

interface ContractRow { id: string; address: string; deploy_block: number; abi: string; abi_hash: string; active_abi_version: number }

export const evmStreamId = (networkId: string, address: string) => `evm:${networkId}:${address.toLowerCase()}`;
export const evmEventId = (networkId: string, l: EvmLog) => `${networkId}:evm:${l.blockHash.toLowerCase()}:${l.transactionIndex}:${l.logIndex}`;

export function decodeLog(abi: Abi | null, l: EvmLog): { eventName: string | null; args: Record<string, unknown> | null; error: string | null } {
  if (!abi) return { eventName: null, args: null, error: 'no ABI registered' };
  try {
    const d = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
    return { eventName: d.eventName ?? null, args: JSON.parse(json(d.args) ?? 'null'), error: null };
  } catch (e) {
    return { eventName: null, args: null, error: (e as Error).message.split('\n')[0].slice(0, 300) };
  }
}

/**
 * Per-contract EVM log indexer. Invariants:
 *  - the cursor and the events it covers are committed in ONE transaction (no gap, no double count)
 *  - event ids include the block hash, so a re-included log after a reorg is a new row and the old one is orphaned
 *  - an RPC failure never advances the cursor; it is recorded as last_error (empty result ≠ failed read)
 *  - a log that cannot be decoded is stored with decode_error and does not block the stream
 */
export class EvmIndexer {
  private maxChunk: number; private minChunk: number; private reorgCheckLimit: number;
  constructor(readonly db: Db, readonly profile: NetworkProfile, readonly source: EvmSource, readonly opts: IndexerOptions = {}) {
    this.maxChunk = opts.maxChunk ?? 5_000; this.minChunk = opts.minChunk ?? 1; this.reorgCheckLimit = opts.reorgCheckLimit ?? 64;
  }
  private log(msg: string, data?: Record<string, unknown>) { this.opts.log?.(msg, data); }

  contracts(): ContractRow[] {
    return this.db.all<ContractRow>(
      `SELECT c.id, c.address, c.deploy_block, a.abi, a.abi_hash, c.active_abi_version FROM contracts c
       JOIN contract_abis a ON a.contract_id = c.id AND a.version = c.active_abi_version
       WHERE c.network_id = ? AND c.runtime = 'evm'`, this.profile.id);
  }

  /** Streams are per address; several projects registering the same address share one stream. */
  ensureStreams() {
    const byAddr = new Map<string, number>();
    for (const c of this.contracts()) byAddr.set(c.address.toLowerCase(), Math.min(byAddr.get(c.address.toLowerCase()) ?? Infinity, c.deploy_block));
    for (const [addr, start] of byAddr) {
      const id = evmStreamId(this.profile.id, addr);
      const cur = this.db.get('SELECT start_block, next_block FROM cursors WHERE stream_id = ?', id);
      if (!cur) this.db.run('INSERT INTO cursors (stream_id, network_id, interface, address, start_block, next_block, chunk_size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, this.profile.id, 'evm', addr, start, start, Math.min(2_000, this.maxChunk), now());
      else if (start < cur.start_block) {
        // A contract registered with an earlier deploy block: rewind so history is backfilled (dedup makes the overlap safe).
        this.db.run('UPDATE cursors SET start_block = ?, next_block = MIN(next_block, ?), updated_at = ? WHERE stream_id = ?', start, start, now(), id);
      }
    }
    return [...byAddr.keys()];
  }

  async heads(): Promise<{ head: number; safe: number; finalized: number }> {
    const head = await this.source.blockNumber();
    const conf = this.profile.evm.confirmations;
    let finalized = Math.max(0, head - conf), safe = finalized;
    if (this.profile.evm.finalizedTag) {
      const [f, s] = await Promise.all([this.source.block('finalized'), this.source.block('safe')]);
      if (f) finalized = f.number;
      if (s) safe = s.number;
    }
    return { head, safe: Math.max(safe, finalized), finalized };
  }

  /** One pass over all streams. Returns number of new events. */
  async tick(): Promise<{ inserted: number; head: number | null; errors: number }> {
    const addrs = this.ensureStreams();
    if (!addrs.length) return { inserted: 0, head: null, errors: 0 };
    let h: { head: number; safe: number; finalized: number };
    try { h = await this.heads(); } catch (e) {
      const msg = (e as Error).message;
      this.db.run(`UPDATE cursors SET last_error = ?, last_error_at = ?, updated_at = ? WHERE network_id = ? AND interface = 'evm'`, `heads: ${msg}`, now(), now(), this.profile.id);
      return { inserted: 0, head: null, errors: 1 };
    }
    await this.checkReorg(h.finalized);
    let inserted = 0, errors = 0;
    for (const addr of addrs) {
      try { inserted += await this.syncStream(addr, h); } catch (e) { errors++; this.log('evm stream error', { addr, error: (e as Error).message }); }
    }
    this.promoteFinality(h);
    return { inserted, head: h.head, errors };
  }

  async syncStream(address: string, h: { head: number; safe: number; finalized: number }): Promise<number> {
    const id = evmStreamId(this.profile.id, address);
    const cur = this.db.get('SELECT * FROM cursors WHERE stream_id = ?', id)!;
    const from = cur.next_block as number;
    if (from > h.head) { this.db.run('UPDATE cursors SET head_seen = ?, finalized_seen = ?, last_success_at = ?, updated_at = ? WHERE stream_id = ?', h.head, h.finalized, now(), now(), id); return 0; }
    const chunk = cur.chunk_size as number;
    const to = Math.min(h.head, from + chunk - 1);
    let logs: EvmLog[];
    try {
      logs = await this.source.logs({ fromBlock: from, toBlock: to, address: address as Hex });
    } catch (e) {
      const next = Math.max(this.minChunk, Math.floor(chunk / 2));
      this.db.run('UPDATE cursors SET last_error = ?, last_error_at = ?, chunk_size = ?, updated_at = ? WHERE stream_id = ?', `eth_getLogs ${from}-${to}: ${(e as Error).message}`, now(), next, now(), id);
      throw e;
    }
    // Store every header above finality (Portaldot finality lag is ~2 blocks) so any later fork inside
    // the window is detectable, plus each block that holds a log and the range end as an anchor.
    const window: number[] = [];
    for (let n = Math.max(from, h.finalized + 1); n <= to && window.length < 256; n++) window.push(n);
    const needed = [...new Set([...logs.map((l) => l.blockNumber), ...window, to])];
    const headers = new Map<number, EvmBlockHeader>();
    for (const n of needed) {
      const b = await this.source.block(n);
      if (!b) throw new PfError('RPC_ERROR', `block ${n} missing while indexing`);
      headers.set(n, b);
    }
    for (const l of logs) {
      if (headers.get(l.blockNumber)!.hash.toLowerCase() !== l.blockHash.toLowerCase()) {
        // Chain moved between eth_getLogs and eth_getBlockByNumber; do not commit a mixed view.
        this.db.run('UPDATE cursors SET last_error = ?, last_error_at = ?, updated_at = ? WHERE stream_id = ?', `inconsistent read at #${l.blockNumber} (reorg in progress)`, now(), now(), id);
        return 0;
      }
    }
    const abiRows = this.contracts().filter((c) => c.address.toLowerCase() === address);
    const abi = abiRows[0] ? (parse<Abi>(abiRows[0].abi) ?? null) : null;
    const decoderVersion = abiRows[0] ? `abi:${abiRows[0].abi_hash.slice(0, 10)}@v${abiRows[0].active_abi_version}` : 'none';
    const observed = now();
    let inserted = 0;
    const enriched = withOrdinals(logs.map((l) => ({ ...l, address: l.address.toLowerCase() as Hex })));
    this.db.tx(() => {
      for (const [n, b] of headers) {
        const fin = n <= h.finalized ? 'finalized' : n <= h.safe ? 'safe' : 'unconfirmed';
        this.db.run(`INSERT INTO blocks (network_id, interface, number, hash, parent_hash, timestamp, finality, seen_at) VALUES (?, 'evm', ?, ?, ?, ?, ?, ?)
          ON CONFLICT (network_id, interface, number) DO UPDATE SET hash = excluded.hash, parent_hash = excluded.parent_hash, timestamp = excluded.timestamp, finality = excluded.finality, seen_at = excluded.seen_at`,
          this.profile.id, n, b.hash.toLowerCase(), b.parentHash.toLowerCase(), b.timestamp, fin, observed);
      }
      for (const l of enriched) {
        const d = decodeLog(abi, l);
        const fin = l.blockNumber <= h.finalized ? 'finalized' : l.blockNumber <= h.safe ? 'safe' : 'unconfirmed';
        const r = this.db.run(`INSERT INTO events (id, network_id, interface, block_number, block_hash, tx_hash, extrinsic_index, log_index, address, event_name, decoder_version, args, decode_error, finality, observed_at, raw, correlation_key)
          VALUES (?, ?, 'evm', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET finality = excluded.finality WHERE events.finality = 'orphaned'`, // A→B→A reorg: the original block is canonical again
          evmEventId(this.profile.id, l), this.profile.id, l.blockNumber, l.blockHash.toLowerCase(), l.transactionHash.toLowerCase(), l.logIndex, l.address,
          d.eventName, decoderVersion, json(d.args), d.error, fin, observed, json({ topics: l.topics, data: l.data, transactionIndex: l.transactionIndex, timestamp: headers.get(l.blockNumber)!.timestamp }), l.correlationKey);
        inserted += r.changes;
      }
      const grow = logs.length < 500 ? Math.min(this.maxChunk, chunk * 2) : chunk;
      this.db.run('UPDATE cursors SET next_block = ?, head_seen = ?, finalized_seen = ?, chunk_size = ?, decoder_version = ?, last_success_at = ?, updated_at = ? WHERE stream_id = ? AND next_block = ?',
        to + 1, h.head, h.finalized, grow, decoderVersion, observed, observed, id, from);
    });
    if (inserted) this.log('evm events', { address, from, to, inserted });
    return inserted;
  }

  /** Compare stored, not-yet-final block hashes with the canonical chain; on mismatch orphan and rewind. */
  async checkReorg(finalized: number): Promise<number | null> {
    const rows = this.db.all(`SELECT number, hash FROM blocks WHERE network_id = ? AND interface = 'evm' AND finality != 'finalized' ORDER BY number ASC LIMIT ?`, this.profile.id, this.reorgCheckLimit);
    for (const r of rows) {
      const canon = await this.source.block(r.number);
      if (canon && canon.hash.toLowerCase() === r.hash) continue;
      const fork = r.number as number;
      this.db.tx(() => {
        const o = this.db.run(`UPDATE events SET finality = 'orphaned' WHERE network_id = ? AND interface = 'evm' AND block_number >= ? AND finality != 'orphaned'`, this.profile.id, fork);
        this.db.run(`DELETE FROM blocks WHERE network_id = ? AND interface = 'evm' AND number >= ?`, this.profile.id, fork);
        this.db.run(`UPDATE cursors SET next_block = MIN(next_block, ?), last_error = ?, last_error_at = ?, updated_at = ? WHERE network_id = ? AND interface = 'evm'`, fork, `reorg detected at #${fork}; ${o.changes} events orphaned, cursor rewound`, now(), now(), this.profile.id);
        this.log('reorg', { fork, orphaned: o.changes });
      });
      return fork;
    }
    this.db.run(`UPDATE blocks SET finality = 'finalized' WHERE network_id = ? AND interface = 'evm' AND number <= ? AND finality != 'finalized'`, this.profile.id, finalized);
    return null;
  }

  promoteFinality(h: { safe: number; finalized: number }) {
    this.db.tx(() => {
      // Only blocks whose hash was re-checked by checkReorg reach 'finalized' in the blocks table.
      this.db.run(`UPDATE events SET finality = 'finalized' WHERE network_id = ? AND interface = 'evm' AND finality IN ('unconfirmed','safe') AND block_number <= ?
        AND block_hash IN (SELECT hash FROM blocks WHERE network_id = events.network_id AND interface = 'evm' AND number = events.block_number AND finality = 'finalized')`, this.profile.id, h.finalized);
      this.db.run(`UPDATE events SET finality = 'safe' WHERE network_id = ? AND interface = 'evm' AND finality = 'unconfirmed' AND block_number <= ?`, this.profile.id, h.safe);
    });
  }

  /** Re-decode stored logs after an ABI version switch. Raw evidence is untouched. */
  redecode(contractId: string): number {
    const c = this.db.get(`SELECT c.address, a.abi, a.abi_hash, c.active_abi_version FROM contracts c JOIN contract_abis a ON a.contract_id = c.id AND a.version = c.active_abi_version WHERE c.id = ?`, contractId);
    if (!c) throw new PfError('NOT_FOUND', 'contract not found');
    const abi = parse<Abi>(c.abi);
    const version = `abi:${c.abi_hash.slice(0, 10)}@v${c.active_abi_version}`;
    const rows = this.db.all(`SELECT seq, raw, block_number, block_hash, tx_hash, log_index FROM events WHERE network_id = ? AND interface = 'evm' AND address = ?`, this.profile.id, c.address.toLowerCase());
    return this.db.tx(() => {
      for (const r of rows) {
        const raw = parse<any>(r.raw);
        const d = decodeLog(abi, { address: c.address, blockHash: r.block_hash, blockNumber: r.block_number, data: raw.data, logIndex: r.log_index, removed: false, topics: raw.topics, transactionHash: r.tx_hash, transactionIndex: raw.transactionIndex });
        this.db.run('UPDATE events SET event_name = ?, args = ?, decode_error = ?, decoder_version = ? WHERE seq = ?', d.eventName, json(d.args), d.error, version, r.seq);
      }
      return rows.length;
    });
  }
}
