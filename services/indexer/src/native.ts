import { type NetworkProfile } from '@portalforge/domain';
import { type Db, json, now } from '@portalforge/store';
import { withOrdinals } from './correlation';

export interface NativeBlock {
  number: number; hash: string; parentHash: string; specVersion: number;
  events: { index: number; phase: string; extrinsicIndex: number | null; section: string; method: string; data: unknown }[];
  extrinsics: { index: number; hash: string; section: string; method: string; signer: string | null; success: boolean | null; dispatchError: string | null }[];
}
export interface NativeSource {
  heads(): Promise<{ best: number; finalized: number }>;
  blockHash(n: number): Promise<string | null>;
  block(hash: string): Promise<NativeBlock>;
  reviveEthBlockHash(n: number): Promise<string | null>;
}

export const nativeStreamId = (networkId: string) => `native:${networkId}`;

const WATCH_SECTIONS = new Set(['revive', 'contracts']);

/**
 * Native (Substrate) indexer: follows blocks sequentially, decodes events with each block's runtime,
 * keeps Revive/Contracts events for watched contracts plus failed revive extrinsics, records spec
 * version per block (runtime upgrade detection) and the EVM-view block hash for correlation.
 */
export class NativeIndexer {
  constructor(readonly db: Db, readonly profile: NetworkProfile, readonly source: NativeSource, readonly opts: { maxBlocksPerTick?: number; startBlock?: number; log?: (m: string, d?: Record<string, unknown>) => void; onRuntimeUpgrade?: (from: number, to: number, block: number) => void } = {}) {}

  watched(): Set<string> {
    return new Set(this.db.all(`SELECT DISTINCT lower(address) a FROM contracts WHERE network_id = ?`, this.profile.id).map((r) => r.a));
  }

  ensureStream(head: number) {
    const id = nativeStreamId(this.profile.id);
    if (this.db.get('SELECT 1 FROM cursors WHERE stream_id = ?', id)) return id;
    const minDeploy = this.db.get(`SELECT MIN(deploy_block) m FROM contracts WHERE network_id = ?`, this.profile.id)?.m as number | null;
    const start = this.opts.startBlock ?? minDeploy ?? Math.max(0, head - 20);
    this.db.run('INSERT INTO cursors (stream_id, network_id, interface, address, start_block, next_block, chunk_size, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 1, ?)', id, this.profile.id, 'native', start, start, now());
    return id;
  }

  async tick(): Promise<{ processed: number; inserted: number; best: number | null }> {
    let heads: { best: number; finalized: number };
    try { heads = await this.source.heads(); } catch (e) {
      this.db.run(`UPDATE cursors SET last_error = ?, last_error_at = ?, updated_at = ? WHERE network_id = ? AND interface = 'native'`, `heads: ${(e as Error).message}`, now(), now(), this.profile.id);
      return { processed: 0, inserted: 0, best: null };
    }
    const id = this.ensureStream(heads.best);
    await this.checkReorg(heads.finalized);
    const watched = this.watched();
    const max = this.opts.maxBlocksPerTick ?? 25;
    let processed = 0, inserted = 0;
    for (; processed < max; processed++) {
      const cur = this.db.get('SELECT next_block FROM cursors WHERE stream_id = ?', id)!;
      const n = cur.next_block as number;
      if (n > heads.best) break;
      try { inserted += await this.indexBlock(id, n, heads, watched); } catch (e) {
        this.db.run('UPDATE cursors SET last_error = ?, last_error_at = ?, updated_at = ? WHERE stream_id = ?', `block #${n}: ${(e as Error).message}`, now(), now(), id);
        break;
      }
    }
    this.db.tx(() => {
      this.db.run(`UPDATE blocks SET finality = 'finalized' WHERE network_id = ? AND interface = 'native' AND number <= ? AND finality != 'finalized'`, this.profile.id, heads.finalized);
      this.db.run(`UPDATE events SET finality = 'finalized' WHERE network_id = ? AND interface = 'native' AND finality = 'unconfirmed' AND block_number <= ?`, this.profile.id, heads.finalized);
      this.db.run('UPDATE cursors SET head_seen = ?, finalized_seen = ?, updated_at = ? WHERE stream_id = ?', heads.best, heads.finalized, now(), id);
    });
    return { processed, inserted, best: heads.best };
  }

  private async indexBlock(streamId: string, n: number, heads: { best: number; finalized: number }, watched: Set<string>): Promise<number> {
    const hash = await this.source.blockHash(n);
    if (!hash) throw new Error('block hash unavailable');
    const b = await this.source.block(hash);
    const prev = this.db.get(`SELECT spec_version FROM blocks WHERE network_id = ? AND interface = 'native' AND number < ? ORDER BY number DESC LIMIT 1`, this.profile.id, n);
    if (prev?.spec_version && prev.spec_version !== b.specVersion) this.opts.onRuntimeUpgrade?.(prev.spec_version, b.specVersion, n);
    type Item = { index: number; extrinsicIndex: number | null; section: string; method: string; data: any; address: string | null; topics: string[]; payload: string };
    const items: Item[] = [];
    for (const e of b.events) {
      if (!WATCH_SECTIONS.has(e.section)) {
        if (e.section === 'system' && e.method === 'CodeUpdated') items.push({ ...e, address: null, topics: [], payload: '' });
        continue;
      }
      const d = e.data as any;
      const address = (Array.isArray(d) ? d[0] : d?.contract ?? d?.deployer)?.toString?.().toLowerCase?.() ?? null;
      if (e.method === 'ContractEmitted') {
        const contract = String(Array.isArray(d) ? d[0] : d.contract).toLowerCase();
        if (!watched.has(contract)) continue;
        const data = String(Array.isArray(d) ? d[1] : d.data);
        const topics = ((Array.isArray(d) ? d[2] : d.topics) ?? []).map(String);
        items.push({ ...e, address: contract, topics, payload: data });
      } else if (address && watched.has(address)) items.push({ ...e, address, topics: [], payload: '' });
    }
    for (const x of b.extrinsics) {
      if (x.section === 'revive' && x.success === false) items.push({ index: 10_000 + x.index, extrinsicIndex: x.index, section: 'system', method: 'ExtrinsicFailed', data: { call: `${x.section}.${x.method}`, dispatchError: x.dispatchError, signer: x.signer }, address: null, topics: [], payload: '' });
    }
    // Only pay for the runtime call when there is something to correlate.
    const ethHash = items.some((i) => i.method === 'ContractEmitted') ? await this.source.reviveEthBlockHash(n) : null;
    const emitted = withOrdinals(items.filter((i) => i.method === 'ContractEmitted').map((i) => ({ ...i, blockNumber: n, address: i.address!, data: i.payload })));
    const corr = new Map(emitted.map((e) => [e.index, e.correlationKey]));
    const fin = n <= heads.finalized ? 'finalized' : 'unconfirmed';
    const observed = now();
    let inserted = 0;
    this.db.tx(() => {
      this.db.run(`INSERT INTO blocks (network_id, interface, number, hash, parent_hash, spec_version, finality, seen_at, timestamp) VALUES (?, 'native', ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT (network_id, interface, number) DO UPDATE SET hash = excluded.hash, parent_hash = excluded.parent_hash, spec_version = excluded.spec_version, finality = excluded.finality, seen_at = excluded.seen_at`,
        this.profile.id, n, hash, b.parentHash, b.specVersion, fin, observed);
      for (const i of items) {
        const xhash = i.extrinsicIndex !== null ? b.extrinsics[i.extrinsicIndex]?.hash ?? null : null;
        const r = this.db.run(`INSERT INTO events (id, network_id, interface, block_number, block_hash, tx_hash, extrinsic_index, log_index, address, event_name, decoder_version, args, decode_error, finality, observed_at, raw, correlation_key)
          VALUES (?, ?, 'native', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET finality = excluded.finality WHERE events.finality = 'orphaned'`,
          `${this.profile.id}:native:${hash}:${i.extrinsicIndex ?? -1}:${i.index}`, this.profile.id, n, hash, xhash, i.extrinsicIndex, i.index, i.address,
          `${i.section}.${i.method}`, `runtime:spec${b.specVersion}`, json(i.data), fin, observed,
          json({ section: i.section, method: i.method, phase: i.extrinsicIndex === null ? 'other' : 'applyExtrinsic', topics: i.topics, data: i.payload, ethBlockHash: ethHash }), corr.get(i.index) ?? null);
        inserted += r.changes;
      }
      this.db.run('UPDATE cursors SET next_block = ?, decoder_version = ?, last_success_at = ?, updated_at = ? WHERE stream_id = ? AND next_block = ?', n + 1, `runtime:spec${b.specVersion}`, observed, observed, streamId, n);
    });
    if (inserted) this.opts.log?.('native events', { block: n, inserted });
    return inserted;
  }

  async checkReorg(finalized: number) {
    const rows = this.db.all(`SELECT number, hash FROM blocks WHERE network_id = ? AND interface = 'native' AND finality != 'finalized' ORDER BY number ASC LIMIT 32`, this.profile.id);
    for (const r of rows) {
      const canon = await this.source.blockHash(r.number);
      if (canon === r.hash) continue;
      this.db.tx(() => {
        const o = this.db.run(`UPDATE events SET finality = 'orphaned' WHERE network_id = ? AND interface = 'native' AND block_number >= ? AND finality != 'orphaned'`, this.profile.id, r.number);
        this.db.run(`DELETE FROM blocks WHERE network_id = ? AND interface = 'native' AND number >= ?`, this.profile.id, r.number);
        this.db.run(`UPDATE cursors SET next_block = MIN(next_block, ?), last_error = ?, last_error_at = ?, updated_at = ? WHERE stream_id = ?`, r.number, `native reorg at #${r.number}; ${o.changes} events orphaned`, now(), now(), nativeStreamId(this.profile.id));
      });
      return r.number as number;
    }
    void finalized;
    return null;
  }
}

/** Link EVM and native observations whose correlation is verifiable (see correlation.ts). */
export function correlatedPairs(db: Db, networkId: string, limit = 100) {
  return db.all(`SELECT e.id evm_id, n.id native_id, e.block_number, e.block_hash evm_block_hash, json_extract(n.raw, '$.ethBlockHash') revive_eth_hash,
      lower(e.block_hash) = lower(json_extract(n.raw, '$.ethBlockHash')) verified
    FROM events e JOIN events n ON n.correlation_key = e.correlation_key AND n.interface = 'native' AND n.network_id = e.network_id
    WHERE e.interface = 'evm' AND e.network_id = ? ORDER BY e.seq DESC LIMIT ?`, networkId, limit);
}
