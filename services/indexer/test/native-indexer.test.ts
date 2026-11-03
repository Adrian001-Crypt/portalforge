import { describe, it, expect } from 'vitest';
import { PORTALDOT_V3_TESTNET } from '@portalforge/domain';
import { NativeIndexer, type NativeSource, type NativeBlock } from '../src/native';
import { seed, addContract } from '../../../packages/store/test/fixtures';

const C = '0x1111111111111111111111111111111111111111';
class FakeNative implements NativeSource {
  blocks: NativeBlock[] = [];
  spec = 3002;
  fin = 0;
  constructor(n: number) { for (let i = 0; i < n; i++) this.push(); }
  push(events: NativeBlock['events'] = []) { const n = this.blocks.length; this.blocks.push({ number: n, hash: `0x${'a'.repeat(62)}${n.toString(16).padStart(2, '0')}`, parentHash: '0x', specVersion: this.spec, events, extrinsics: [] }); }
  async heads() { return { best: this.blocks.length - 1, finalized: this.fin }; }
  async blockHash(n: number) { return this.blocks[n]?.hash ?? null; }
  async block(hash: string) { return this.blocks.find((b) => b.hash === hash)!; }
  async reviveEthBlockHash(n: number) { return `0xeth${n}`; }
}
const emitted = (i: number, contract = C) => ({ index: i, phase: 'ApplyExtrinsic', extrinsicIndex: 1, section: 'revive', method: 'ContractEmitted', data: { contract, data: '0x01', topics: ['0xaa'] } });

describe('native indexer', () => {
  it('keeps only watched contracts, tags decoder version, detects runtime upgrades and reorgs', async () => {
    const { db, projectId } = seed({ profile: PORTALDOT_V3_TESTNET });
    addContract(db, projectId, PORTALDOT_V3_TESTNET.id, 'c', C, [], 1);
    const src = new FakeNative(1);
    src.push([emitted(0), emitted(1, '0x2222222222222222222222222222222222222222')]);
    const upgrades: number[][] = [];
    const ix = new NativeIndexer(db, PORTALDOT_V3_TESTNET, src, { onRuntimeUpgrade: (a, b, n) => upgrades.push([a, b, n]) });
    await ix.tick();
    expect(db.all(`SELECT address FROM events`).map((r) => r.address)).toEqual([C]);
    src.spec = 3003; src.push([emitted(0)]);
    await ix.tick();
    expect(upgrades).toEqual([[3002, 3003, 2]]);
    expect(db.get(`SELECT decoder_version d FROM events WHERE block_number = 2`).d).toBe('runtime:spec3003');
    expect(JSON.parse(db.get(`SELECT raw FROM events WHERE block_number = 1`).raw).ethBlockHash).toBe('0xeth1');
    // reorg block 2 (unfinalized)
    src.blocks[2] = { ...src.blocks[2], hash: '0x' + 'b'.repeat(64), events: [] };
    await ix.tick();
    expect(db.get(`SELECT finality FROM events WHERE block_number = 2 AND block_hash LIKE '0xaaa%'`).finality).toBe('orphaned');
    src.fin = 2; await ix.tick();
    expect(db.get(`SELECT finality FROM events WHERE block_number = 1`).finality).toBe('finalized');
  });
});
