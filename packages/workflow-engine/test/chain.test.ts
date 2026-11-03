import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JobRegistryAbi, EvidenceRegistryAbi } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';
import { EvmIndexer } from '../../../services/indexer/src/evm';
import { startDemoService } from '../../../examples/demo-service/src/server';
import { seed } from '../../store/test/fixtures';
import { WorkflowEngine } from '../src/engine';
import { EvmChainExecutor } from '../src/chain';
import { addConnector, createWorkflow, deployDemo, executorAcct, registerDemoContracts, squareWorkflow, startAnvil } from './helpers';

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let svc: Awaited<ReturnType<typeof startDemoService>>;
let demo: Awaited<ReturnType<typeof deployDemo>>;
beforeAll(async () => { anvil = await startAnvil(); svc = await startDemoService({}); demo = await deployDemo(anvil.profile); }, 60_000);
afterAll(async () => { anvil.stop(); await svc.close(); });

async function setup(hook?: (kind: string, key: string) => Promise<void> | void) {
  const s = seed({ profile: anvil.profile });
  registerDemoContracts(s.db, s.projectId, anvil.profile.id, demo.JobRegistry, demo.EvidenceRegistry);
  addConnector(s.db, s.projectId, 'demo', `${svc.url}/v1/square`, `${svc.url}/v1/square`);
  const chain = new EvmChainExecutor(anvil.profile, executorAcct);
  const engine = new WorkflowEngine({ db: s.db, workerId: 'w1', chains: new Map([[anvil.profile.id, chain]]), pollMs: 200, beforeSideEffect: hook });
  const head = await new EvmReader(anvil.url).blockNumber();
  const wf = createWorkflow(engine, s.projectId, squareWorkflow({ write: true, evidence: true }), { startBlock: head + 1 });
  const indexer = new EvmIndexer(s.db, anvil.profile, new EvmReader(anvil.url));
  return { ...s, engine, wf, indexer, chain };
}

async function runToEnd(engine: WorkflowEngine, indexer: EvmIndexer, until: () => boolean, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await indexer.tick();
    engine.routeEvents();
    await engine.runUntilIdle(20);
    if (until()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  const db = engine.db;
  throw new Error('timeout waiting for executions: ' + JSON.stringify({ x: db.all('SELECT state, error, next_run_at FROM executions'), steps: db.all('SELECT step_id, state, attempts, error, next_attempt_at FROM steps'), cur: db.all('SELECT next_block, head_seen, last_error FROM cursors'), ev: db.all('SELECT block_number, event_name, finality FROM events'), intents: db.all('SELECT step_id, state, error FROM intents') }));
}

const readJob = async (jobId: bigint) => demo.pub.readContract({ address: demo.JobRegistry.address, abi: JobRegistryAbi, functionName: 'getJob', args: [jobId] });
const jobIdOf = (r: any) => BigInt(r.logs[0].topics[1]);

describe('on-chain execution (local Anvil)', () => {
  it('indexes JobRequested, completes the job once, and registers execution evidence', async () => {
    const { db, engine, indexer } = await setup();
    const rcpt = await demo.requestJob(11n);
    const jobId = jobIdOf(rcpt);
    await runToEnd(engine, indexer, () => db.get(`SELECT state FROM executions`)?.state === 'succeeded');
    const x = db.get('SELECT * FROM executions')!;
    const [, input, status, executionId] = await readJob(jobId);
    expect(input).toBe(11n);
    expect(status).toBe(2);
    expect(executionId.toLowerCase()).toBe(x.id);
    const ev = db.get('SELECT * FROM evidence')!;
    expect(ev.status).toBe('registered');
    const st = await demo.pub.readContract({ address: demo.EvidenceRegistry.address, abi: EvidenceRegistryAbi, functionName: 'status', args: [ev.evidence_id, ev.kind_hash, x.id, ev.content_hash, executorAcct.address] });
    expect(st).toBe(1);
    expect(db.all(`SELECT state FROM intents WHERE kind = 'chain_tx'`).map((r) => r.state)).toEqual(['confirmed', 'confirmed']);
  });

  it('crash after the signed tx is persisted but before broadcast: resumes with the SAME tx hash', async () => {
    let crashed = false;
    const { db, engine, indexer, chain } = await setup((kind, key) => { if (kind === 'chain_tx' && key.endsWith(':complete') && !crashed) { crashed = true; throw new Error('worker crashed (injected)'); } });
    const nonceBefore = await chain.latestNonce();
    const rcpt = await demo.requestJob(5n);
    await runToEnd(engine, indexer, () => db.get(`SELECT state FROM executions`)?.state === 'succeeded');
    expect(crashed).toBe(true);
    const intent = db.get(`SELECT * FROM intents WHERE step_id = 'complete'`)!;
    const out = JSON.parse(db.get(`SELECT output FROM steps WHERE step_id = 'complete'`)!.output);
    expect(out.txHash).toBe(intent.tx_hash);
    expect(await chain.latestNonce()).toBe(nonceBefore + 2); // completeJob + evidence register, no duplicate
    expect((await readJob(jobIdOf(rcpt)))[2]).toBe(2);
  });

  it('broadcast succeeded but the worker lost the response: finds the receipt, does not resend', async () => {
    let lost = false;
    const { db, engine, indexer, chain } = await setup(async (kind, key) => {
      if (kind === 'chain_tx' && key.endsWith(':complete') && !lost) {
        lost = true;
        const it = db.get('SELECT raw_tx FROM intents WHERE idempotency_key = ?', key)!;
        await chain.broadcast(it.raw_tx); // the network got it...
        throw new Error('connection reset after send (injected)'); // ...but we never saw the answer
      }
    });
    const nonceBefore = await chain.latestNonce();
    await demo.requestJob(6n);
    await runToEnd(engine, indexer, () => db.get(`SELECT state FROM executions`)?.state === 'succeeded');
    expect(lost).toBe(true);
    expect(await chain.latestNonce()).toBe(nonceBefore + 2);
  });

  it('a replay cannot complete the same job twice (contract-level dedup + reconciliation)', async () => {
    const { db, engine, indexer } = await setup();
    await demo.requestJob(3n);
    await runToEnd(engine, indexer, () => db.get(`SELECT state FROM executions`)?.state === 'succeeded');
    const x = db.get('SELECT * FROM executions')!;
    const r = engine.replay(x.id, 'full', 'op');
    await runToEnd(engine, indexer, () => ['failed', 'succeeded'].includes(db.get('SELECT state FROM executions WHERE id = ?', r.id)?.state));
    const rx = db.get('SELECT * FROM executions WHERE id = ?', r.id)!;
    expect(rx.state).toBe('failed');
    expect(rx.error).toMatch(/applied by a different execution/);
  });

  it('refuses calls outside the allowlist, over budget, or on the wrong network', async () => {
    const a = await setup();
    a.db.run(`DELETE FROM contract_policies WHERE function_name = 'completeJob'`);
    await demo.requestJob(2n);
    await runToEnd(a.engine, a.indexer, () => a.db.get(`SELECT state FROM executions`)?.state === 'failed');
    expect(a.db.get('SELECT error FROM executions')!.error).toMatch(/POLICY_DENIED/);

    const b = await setup();
    b.db.run(`UPDATE contract_policies SET max_fee_wei = '1' WHERE function_name = 'completeJob'`);
    await demo.requestJob(2n);
    await runToEnd(b.engine, b.indexer, () => b.db.get(`SELECT state FROM executions`)?.state === 'failed');
    expect(b.db.get('SELECT error FROM executions')!.error).toMatch(/BUDGET_EXCEEDED/);

    const c = await setup();
    (c.engine.deps.chains as Map<string, any>).set(anvil.profile.id, new EvmChainExecutor({ ...anvil.profile, evm: { ...anvil.profile.evm, chainId: 420420777 } }, executorAcct, anvil.url));
    await demo.requestJob(2n);
    await runToEnd(c.engine, c.indexer, () => c.db.get(`SELECT state FROM executions`)?.state === 'failed');
    expect(c.db.get('SELECT error FROM executions')!.error).toMatch(/NETWORK_MISMATCH/);
  });

});
