import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '@portalforge/store';
import { startDemoService } from '../../../examples/demo-service/src/server';
import { seed } from '../../store/test/fixtures';
import { WorkflowEngine, NEVER } from '../src/engine';
import { addConnector, createWorkflow, fakeEvent, squareWorkflow } from './helpers';

const ADDR = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const ADMIN = 'test-admin-token-0123456789';
let svc: Awaited<ReturnType<typeof startDemoService>>;
const fault = (f: Record<string, number>) => fetch(`${svc.url}/admin/faults`, { method: 'POST', headers: { 'x-admin-token': ADMIN }, body: JSON.stringify(f) });
const stats = async () => (await (await fetch(`${svc.url}/admin/stats`)).json()) as any;

beforeAll(async () => { svc = await startDemoService({ faults: true, adminToken: ADMIN }); });
afterAll(async () => { await svc.close(); });

function setup(def = squareWorkflow(), opts: { path?: string } = {}) {
  const s = seed({ path: opts.path });
  s.db.run(`INSERT INTO contracts (id, project_id, alias, network_id, runtime, address, deploy_block, created_at, updated_at) VALUES ('c1', ?, 'jobs', ?, 'evm', ?, 0, 'now', 'now')`, s.projectId, s.profile.id, ADDR);
  s.db.run(`INSERT INTO contract_abis (contract_id, version, abi, abi_hash, created_at) VALUES ('c1', 1, '[]', 'h', 'now')`);
  addConnector(s.db, s.projectId, 'demo', `${svc.url}/v1/square`, `${svc.url}/v1/square`);
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const engine = new WorkflowEngine({ db: s.db, workerId: 'w1', clock: clock.now, leaseMs: 10_000, random: () => 1 });
  const wf = createWorkflow(engine, s.projectId, def);
  return { ...s, engine, wf, clock };
}

async function drive(engine: WorkflowEngine, clock: { advance: (ms: number) => void }, rounds = 30) {
  for (let i = 0; i < rounds; i++) { const n = await engine.runUntilIdle(50); if (!n) clock.advance(1_000); }
}

describe('workflow engine', () => {
  it('routes an event once, binds version and input hash, and completes', async () => {
    const { db, engine, wf, clock, profile } = setup();
    fakeEvent(db, profile.id, ADDR, 10, 1, 12);
    expect(engine.routeEvents()).toBe(1);
    expect(engine.routeEvents()).toBe(0); // deduplicated
    await drive(engine, clock);
    const x = db.get('SELECT * FROM executions')!;
    expect(x.state).toBe('succeeded');
    expect(x.version).toBe(wf.version);
    expect(x.input_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(x.id).toMatch(/^0x[0-9a-f]{64}$/);
    const out = JSON.parse(db.get(`SELECT output FROM steps WHERE step_id = 'compute'`)!.output);
    expect(out.result).toBe('144');
  });

  it('keeps running executions on their version when a new version is saved', async () => {
    const { db, engine, wf, clock, profile } = setup();
    fakeEvent(db, profile.id, ADDR, 10, 1, 3);
    engine.routeEvents();
    const def2 = { ...squareWorkflow(), description: 'v2 changed' };
    const v2 = engine.saveVersion(wf.id, def2, 'test');
    db.run('UPDATE workflows SET active_version = ? WHERE id = ?', v2.version, wf.id);
    expect(() => db.run('UPDATE workflow_versions SET definition = ? WHERE workflow_id = ?', '{}', wf.id)).toThrow(/immutable/);
    await drive(engine, clock);
    expect(db.get('SELECT version FROM executions')!.version).toBe(1);
    fakeEvent(db, profile.id, ADDR, 11, 2, 3);
    engine.routeEvents();
    expect(db.get(`SELECT version FROM executions WHERE trigger_key LIKE '%:2'`)!.version).toBe(2);
  });

  it('skips downstream steps when a condition is false', async () => {
    const { db, engine, clock, profile } = setup();
    fakeEvent(db, profile.id, ADDR, 10, 1, 5_000_000_000);
    engine.routeEvents();
    await drive(engine, clock);
    expect(db.get('SELECT state FROM executions')!.state).toBe('succeeded');
    expect(db.all(`SELECT state FROM steps WHERE step_id != 'guard'`).every((s) => s.state === 'skipped')).toBe(true);
  });

  it('remote success with a lost response is reconciled by query, never processed twice', async () => {
    const { db, engine, clock, profile } = setup();
    const before = (await stats()).processed;
    await fault({ dropNextResponse: 1 });
    fakeEvent(db, profile.id, ADDR, 10, 7, 9);
    engine.routeEvents();
    await engine.runUntilIdle(5);
    const s1 = db.get(`SELECT * FROM steps WHERE step_id = 'compute'`)!;
    expect(s1.state).toBe('unknown');
    expect(db.get('SELECT state FROM executions')!.state).toBe('unknown');
    expect(db.get('SELECT state FROM intents')!.state).toBe('unknown');
    await drive(engine, clock);
    const x = db.get('SELECT * FROM executions')!;
    expect(x.state).toBe('succeeded');
    const out = JSON.parse(db.get(`SELECT output FROM steps WHERE step_id = 'compute'`)!.output);
    expect(out.reconciled).toBe(true);
    expect(out.result).toBe('81');
    const st = await stats();
    expect(st.processed - before).toBe(1);
    expect(st.perExecution.find((p: any) => p.execution_id === x.id).processed).toBe(1);
    expect(db.get('SELECT COUNT(*) n FROM step_attempts WHERE step_id = ?', 'compute')!.n).toBe(2);
  });

  it('does not resend when the connector cannot be queried (operator action required)', async () => {
    const { db, engine, clock, profile, projectId } = setup();
    db.run(`UPDATE connectors SET query_url = NULL WHERE project_id = ?`, projectId);
    await fault({ dropNextResponse: 1 });
    fakeEvent(db, profile.id, ADDR, 10, 8, 2);
    engine.routeEvents();
    await drive(engine, clock, 5);
    const s = db.get(`SELECT * FROM steps WHERE step_id = 'compute'`)!;
    expect(s.state).toBe('unknown');
    expect(s.next_attempt_at).toBe(NEVER);
    const x = db.get('SELECT * FROM executions')!;
    engine.resolveUnknown(x.id, 'compute', 'fail', 'op', 'checked receiver logs');
    await drive(engine, clock, 3);
    expect(db.get('SELECT state FROM executions')!.state).toBe('failed');
  });

  it('retries with backoff and dead-letters after the attempt limit', async () => {
    const { db, engine, clock, profile, projectId } = setup();
    db.run(`UPDATE connectors SET url = 'http://127.0.0.1:45678/v1/square' WHERE project_id = ?`, projectId); // ECONNREFUSED: never delivered
    fakeEvent(db, profile.id, ADDR, 10, 9, 2);
    engine.routeEvents();
    await drive(engine, clock, 20);
    const x = db.get('SELECT * FROM executions')!;
    expect(x.state).toBe('dead_letter');
    expect(x.error).toMatch(/exhausted 4 attempts/);
    expect(db.get(`SELECT COUNT(*) n FROM step_attempts WHERE step_id = 'compute' AND state = 'failed'`)!.n).toBe(4);
    // replay from failure reuses guard output and retries compute
    db.run(`UPDATE connectors SET url = ? WHERE project_id = ?`, `${svc.url}/v1/square`, projectId);
    const r = engine.replay(x.id, 'from-failure', 'op');
    await drive(engine, clock);
    const rx = db.get('SELECT * FROM executions WHERE id = ?', r.id)!;
    expect(rx.state).toBe('succeeded');
    expect(rx.replay_of).toBe(x.id);
    expect(db.get(`SELECT reused_from FROM steps WHERE execution_id = ? AND step_id = 'guard'`, r.id)!.reused_from).toBe(x.id);
  });

  it('recovers an execution when the worker holding the lease dies', async () => {
    const { db, engine, clock, profile } = setup();
    fakeEvent(db, profile.id, ADDR, 10, 3, 4);
    engine.routeEvents();
    const claimed = engine.claim();
    expect(claimed.lease_owner).toBe('w1');
    // worker w1 "dies" here. w2 cannot claim until the lease expires.
    const w2 = new WorkflowEngine({ db, workerId: 'w2', clock: clock.now, leaseMs: 10_000, random: () => 1 });
    expect(w2.claim()).toBeNull();
    clock.advance(11_000);
    await drive(w2, clock);
    expect(db.get('SELECT state, lease_owner FROM executions')).toMatchObject({ state: 'succeeded', lease_owner: null });
    expect(db.all('SELECT DISTINCT worker_id FROM step_attempts').map((r) => r.worker_id)).toEqual(['w2']);
  });

  it('two concurrent workers on one database run each execution exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-eng-'));
    const path = join(dir, 'pf.db');
    const { db, profile } = setup(squareWorkflow(), { path });
    for (let i = 1; i <= 12; i++) fakeEvent(db, profile.id, ADDR, 10 + i, i, i);
    const a = new WorkflowEngine({ db, workerId: 'wa' });
    const db2 = new Db(path).migrate();
    const b = new WorkflowEngine({ db: db2, workerId: 'wb' });
    a.routeEvents(); b.routeEvents();
    expect(db.get('SELECT COUNT(*) n FROM executions')!.n).toBe(12);
    await Promise.all([a.runUntilIdle(100), b.runUntilIdle(100), a.runUntilIdle(100), b.runUntilIdle(100)]);
    expect(db.get(`SELECT COUNT(*) n FROM executions WHERE state = 'succeeded'`)!.n).toBe(12);
    expect(db.get(`SELECT COUNT(*) n FROM step_attempts WHERE step_id = 'compute'`)!.n).toBe(12);
    const st = await stats();
    const ids = db.all('SELECT id FROM executions').map((r) => r.id);
    for (const id of ids) expect(st.perExecution.find((p: any) => p.execution_id === id).processed).toBe(1);
    db2.close();
  });

  it('approval: approve continues, expiry fails, cancel voids', async () => {
    const def = squareWorkflow();
    def.steps.splice(1, 0, { id: 'gate', type: 'approval', needs: ['guard'], prompt: 'Run square?', expiresInSec: 60, timeoutMs: 5000 } as any);
    (def.steps[2] as any).needs = ['gate'];
    const { db, engine, clock, profile } = setup(def);
    fakeEvent(db, profile.id, ADDR, 10, 1, 2); fakeEvent(db, profile.id, ADDR, 11, 2, 2); fakeEvent(db, profile.id, ADDR, 12, 3, 2);
    engine.routeEvents();
    await engine.runUntilIdle(10);
    expect(db.all(`SELECT state FROM executions`).every((x) => x.state === 'awaiting_approval')).toBe(true);
    const [a1, a2, a3] = db.all('SELECT a.id, a.execution_id FROM approvals a JOIN executions x ON x.id = a.execution_id ORDER BY x.trigger_key');
    engine.decideApproval(a1.id, 'approved', 'op');
    engine.requestCancel(a3.execution_id, 'op');
    expect(() => engine.decideApproval(a3.id, 'approved', 'op')).toThrow(/void|cancelled/);
    await engine.runUntilIdle(10);
    expect(db.get('SELECT state FROM executions WHERE id = ?', a1.execution_id)!.state).toBe('succeeded');
    clock.advance(61_000);
    expect(() => engine.decideApproval(a2.id, 'approved', 'op')).toThrow(/expired/);
    await drive(engine, clock, 3);
    expect(db.get('SELECT state FROM executions WHERE id = ?', a2.execution_id)!.state).toBe('failed');
    expect(db.get('SELECT state FROM executions WHERE id = ?', a3.execution_id)!.state).toBe('cancelled');
  });

  it('cancels a queued execution whose trigger event is orphaned by a reorg', async () => {
    const { db, engine, profile } = setup();
    const id = fakeEvent(db, profile.id, ADDR, 10, 1, 2);
    engine.routeEvents();
    db.run(`UPDATE events SET finality = 'orphaned' WHERE id = ?`, id);
    engine.routeEvents();
    expect(db.get('SELECT state, error FROM executions')).toMatchObject({ state: 'cancelled', error: 'trigger event orphaned by reorg' });
  });

  it('schedule triggers create one execution per slot', async () => {
    const def = { schema: 'portalforge.workflow/v1', name: 'tick', trigger: { type: 'schedule', everySeconds: 60 }, steps: [{ id: 'sq', type: 'task', task: 'math.square', input: { value: '{{trigger.slot}}' } }] };
    const { db, engine, clock } = setup(def as any);
    expect(engine.scheduleTick()).toBe(1);
    expect(engine.scheduleTick()).toBe(0);
    clock.advance(60_000);
    expect(engine.scheduleTick()).toBe(1);
    await drive(engine, clock, 3);
    expect(db.get(`SELECT COUNT(*) n FROM executions WHERE state = 'succeeded'`)!.n).toBe(2);
  });

  it('a stale worker cannot write after losing its lease', async () => {
    const { db, engine, clock, profile } = setup();
    fakeEvent(db, profile.id, ADDR, 10, 1, 2);
    engine.routeEvents();
    const x = engine.claim();
    clock.advance(11_000);
    const w2 = new WorkflowEngine({ db, workerId: 'w2', clock: clock.now, leaseMs: 10_000 });
    expect(w2.claim().id).toBe(x.id);
    expect(() => (engine as any).release(x.id, 'running', 0)).toThrow(/lease lost/);
  });
});
