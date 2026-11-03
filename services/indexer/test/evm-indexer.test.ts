import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRegistryAbi } from '@portalforge/domain';
import { Db } from '@portalforge/store';
import { EvmIndexer } from '../src/evm';
import { FakeChain } from './fakechain';
import { seed, addContract } from '../../../packages/store/test/fixtures';

const ADDR = '0x5fbdb2315678afecb367f032d93f642f64180aa3' as const;
const count = (db: Db, where = '1=1') => db.get(`SELECT COUNT(*) n FROM events WHERE ${where}`)!.n as number;

function setup(height = 30, deployBlock = 5) {
  const s = seed();
  addContract(s.db, s.projectId, s.profile.id, 'jobs', ADDR, JobRegistryAbi, deployBlock);
  const chain = new FakeChain(height);
  const ix = new EvmIndexer(s.db, { ...s.profile, evm: { ...s.profile.evm, finalizedTag: true } }, chain, { maxChunk: 8 });
  return { ...s, chain, ix };
}

describe('EVM indexer', () => {
  it('starts at the deploy block, decodes events and persists the cursor', async () => {
    const { db, chain, ix } = setup();
    chain.jobRequested(3, ADDR, 0n, 1n); // before deploy block: must not be read
    chain.jobRequested(6, ADDR, 1n, 7n);
    chain.jobRequested(20, ADDR, 2n, 9n);
    for (let i = 0; i < 6; i++) await ix.tick();
    expect(count(db)).toBe(2);
    const e = db.get(`SELECT * FROM events ORDER BY block_number LIMIT 1`)!;
    expect(e.event_name).toBe('JobRequested');
    expect(JSON.parse(e.args).input).toBe('7');
    const cur = db.get('SELECT * FROM cursors')!;
    expect(cur.start_block).toBe(5);
    expect(cur.next_block).toBe(31);
  });

  it('does not double count duplicated or overlapping logs', async () => {
    const { db, chain, ix } = setup();
    chain.jobRequested(10, ADDR, 1n, 2n);
    chain.duplicateLogs = true;
    for (let i = 0; i < 6; i++) await ix.tick();
    expect(count(db)).toBe(1);
    // overlapping backfill: rewind the cursor and replay the same range
    db.run('UPDATE cursors SET next_block = 5');
    for (let i = 0; i < 6; i++) await ix.tick();
    expect(count(db)).toBe(1);
  });

  it('treats an RPC failure as a failure, not as an empty range', async () => {
    const { db, chain, ix } = setup();
    chain.jobRequested(6, ADDR, 1n, 2n);
    chain.failLogs = 1;
    const r = await ix.tick();
    expect(r.errors).toBe(1);
    const cur = db.get('SELECT * FROM cursors')!;
    expect(cur.next_block).toBe(5); // not advanced
    expect(cur.last_error).toMatch(/503/);
    expect(cur.chunk_size).toBeLessThan(8);
    await ix.tick();
    expect(count(db)).toBe(1);
  });

  it('records head failures without moving cursors', async () => {
    const { db, chain, ix } = setup();
    chain.failNext = 1;
    const r = await ix.tick();
    expect(r.head).toBeNull();
    expect(db.get('SELECT next_block, last_error FROM cursors')).toMatchObject({ next_block: 5 });
  });

  it('resumes after restart from the persisted cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-ix-'));
    const path = join(dir, 'pf.db');
    const s = seed({ path });
    addContract(s.db, s.projectId, s.profile.id, 'jobs', ADDR, JobRegistryAbi, 0);
    const chain = new FakeChain(40);
    chain.jobRequested(4, ADDR, 1n, 2n);
    chain.jobRequested(35, ADDR, 2n, 3n);
    const a = new EvmIndexer(s.db, s.profile, chain, { maxChunk: 10 });
    await a.tick(); // only first chunk
    expect(count(s.db)).toBe(1);
    s.db.close();
    const db2 = new Db(path).migrate();
    const b = new EvmIndexer(db2, s.profile, chain, { maxChunk: 10 });
    const before = chain.calls.logs;
    for (let i = 0; i < 5; i++) await b.tick();
    expect(count(db2)).toBe(2);
    expect(db2.get('SELECT next_block FROM cursors')!.next_block).toBe(41);
    expect(chain.calls.logs - before).toBeLessThan(6); // did not rescan from genesis
  });

  it('orphans events on reorg, rewinds, and indexes the new fork', async () => {
    const { db, chain, ix } = setup(30, 0);
    chain.finalizedLag = 5;
    chain.jobRequested(28, ADDR, 1n, 2n);
    for (let i = 0; i < 6; i++) await ix.tick();
    expect(count(db, "finality != 'orphaned'")).toBe(1);
    chain.reorg(27, 1);
    chain.jobRequested(29, ADDR, 1n, 2n); // same job re-included in a different block
    await ix.tick();
    expect(count(db, "finality = 'orphaned'")).toBe(1);
    for (let i = 0; i < 3; i++) await ix.tick();
    expect(count(db, "finality != 'orphaned'")).toBe(1);
    expect(db.get(`SELECT block_number FROM events WHERE finality != 'orphaned'`)!.block_number).toBe(29);
  });

  it('restores the original rows on an A→B→A reorg', async () => {
    const { db, chain, ix } = setup(30, 0);
    chain.finalizedLag = 5;
    const log = chain.jobRequested(28, ADDR, 1n, 2n);
    const snapshot = { blocks: chain.blocks.slice(), logs: new Map(chain.logsByBlock) };
    for (let i = 0; i < 6; i++) await ix.tick();
    chain.reorg(27);
    await ix.tick();
    expect(count(db, "finality = 'orphaned'")).toBe(1);
    chain.blocks = snapshot.blocks; chain.logsByBlock = snapshot.logs;
    for (let i = 0; i < 3; i++) await ix.tick();
    expect(count(db)).toBe(1);
    expect(db.get('SELECT finality, block_hash FROM events')).toMatchObject({ block_hash: log.blockHash.toLowerCase() });
    expect(db.get('SELECT finality FROM events')!.finality).not.toBe('orphaned');
  });

  it('isolates undecodable logs and keeps indexing', async () => {
    const { db, chain, ix } = setup();
    chain.addLog(7, { address: ADDR, topics: ['0x' + 'ab'.repeat(32) as `0x${string}`], data: '0x', logIndex: 0 });
    chain.jobRequested(8, ADDR, 1n, 2n);
    for (let i = 0; i < 6; i++) await ix.tick();
    expect(count(db)).toBe(2);
    expect(count(db, 'decode_error IS NOT NULL')).toBe(1);
    expect(count(db, "event_name = 'JobRequested'")).toBe(1);
  });

  it('promotes finality only after the block hash is re-checked', async () => {
    const { db, chain, ix } = setup(20, 0);
    chain.finalizedLag = 3;
    chain.jobRequested(19, ADDR, 1n, 2n);
    await ix.tick(); await ix.tick(); await ix.tick();
    expect(db.get('SELECT finality FROM events')!.finality).toBe('unconfirmed');
    chain.mine(4);
    await ix.tick();
    expect(db.get('SELECT finality FROM events')!.finality).toBe('finalized');
  });

  it('re-decodes stored logs after an ABI version switch without touching raw evidence', async () => {
    const { db, chain, ix } = setup();
    const cid = db.get('SELECT id FROM contracts')!.id;
    db.run(`UPDATE contract_abis SET abi = '[]' WHERE contract_id = ?`, cid);
    chain.jobRequested(6, ADDR, 1n, 2n);
    for (let i = 0; i < 4; i++) await ix.tick();
    expect(db.get('SELECT decode_error FROM events')!.decode_error).not.toBeNull();
    db.run(`INSERT INTO contract_abis (contract_id, version, abi, abi_hash, created_at) VALUES (?, 2, ?, 'h2', 'now')`, cid, JSON.stringify(JobRegistryAbi));
    db.run('UPDATE contracts SET active_abi_version = 2 WHERE id = ?', cid);
    const raw = db.get('SELECT raw FROM events')!.raw;
    expect(ix.redecode(cid)).toBe(1);
    const e = db.get('SELECT * FROM events')!;
    expect(e.event_name).toBe('JobRequested');
    expect(e.decoder_version).toMatch(/@v2$/);
    expect(e.raw).toBe(raw);
  });
});
