import { describe, it, expect } from 'vitest';
import { seed } from '../../store/test/fixtures';
import { deliverDue, retryDelivery, raiseIncident, resolveByFingerprint, transitionIncident, endpointStats, storeSample, evaluateNetworkRules, evaluateIndexerRules, signalToIncident, type RaiseInput } from '../src';

const diag = { facts: [{ label: 'x', value: '1' }], inference: { source: 'rule:test', text: 't' }, suggestion: ['s'] };
const inc = (fp = 'fp1'): RaiseInput => ({ fingerprint: fp, kind: 'test', severity: 'warning', title: 'T', diagnosis: diag, cooldownMs: 60_000 });

describe('incidents', () => {
  it('aggregates repeats, reopens inside cooldown, opens new after cooldown', () => {
    const { db } = seed();
    let t = 1_000_000;
    const a = raiseIncident(db, inc(), () => t);
    const b = raiseIncident(db, inc(), () => t);
    expect(a.isNew).toBe(true); expect(b.isNew).toBe(false); expect(b.id).toBe(a.id);
    expect(db.get('SELECT count FROM incidents WHERE id = ?', a.id).count).toBe(2);
    resolveByFingerprint(db, 'fp1', 'system', 'ok', 60_000, () => t);
    t += 30_000;
    const c = raiseIncident(db, inc(), () => t);
    expect(c.reopened).toBe(true); expect(c.id).toBe(a.id);
    resolveByFingerprint(db, 'fp1', 'system', 'ok', 60_000, () => t);
    t += 120_000;
    const d = raiseIncident(db, inc(), () => t);
    expect(d.isNew).toBe(true); expect(d.id).not.toBe(a.id);
    expect(db.all('SELECT kind FROM incident_events WHERE incident_id = ? ORDER BY id', a.id).map((r) => r.kind)).toEqual(['opened', 'resolved', 'reopened', 'resolved']);
  });

  it('acknowledge then resolve records actors in the timeline; severity only escalates', () => {
    const { db } = seed();
    const a = raiseIncident(db, inc());
    raiseIncident(db, { ...inc(), severity: 'critical' });
    raiseIncident(db, { ...inc(), severity: 'info' });
    expect(db.get('SELECT severity FROM incidents WHERE id = ?', a.id).severity).toBe('critical');
    transitionIncident(db, a.id, 'acknowledge', 'user:op');
    transitionIncident(db, a.id, 'resolve', 'user:op', 'fixed RPC');
    expect(db.get('SELECT state, acknowledged_by, resolved_by FROM incidents WHERE id = ?', a.id)).toMatchObject({ state: 'resolved', acknowledged_by: 'user:op', resolved_by: 'user:op' });
  });
});

describe('health rules', () => {
  const ep = (db: any) => { db.run(`INSERT INTO rpc_endpoints (id, network_id, interface, url, label, builtin, created_at) VALUES ('e1', 'local-anvil', 'evm', 'http://x', 'EP', 1, 'now')`); };

  it('reports insufficient data instead of a score', () => {
    const { db } = seed(); ep(db);
    storeSample(db, { endpointId: 'e1', ok: true, latencyMs: 10, head: 5, finalized: 3, headHash: '0x', specVersion: null, error: null });
    const s = endpointStats(db, 'e1', 60_000);
    expect(s.insufficient).toBe(true); expect(s.availability).toBeNull(); expect(s.p50).toBeNull();
  });

  it('raises rpc_unreachable after N failures and auto-resolves on recovery', () => {
    const { db } = seed(); ep(db);
    const t = Date.now();
    for (let i = 0; i < 3; i++) storeSample(db, { endpointId: 'e1', ok: false, latencyMs: null, head: null, finalized: null, headHash: null, specVersion: null, error: 'ECONNREFUSED' }, t - 3000 + i * 1000);
    evaluateNetworkRules(db, 'local-anvil', (r) => raiseIncident(db, r));
    const i = db.get(`SELECT * FROM incidents WHERE kind = 'rpc_unreachable'`);
    expect(i.state).toBe('open');
    expect(JSON.parse(i.inference).text).toMatch(/does not by itself prove the chain stopped/);
    storeSample(db, { endpointId: 'e1', ok: true, latencyMs: 12, head: 10, finalized: 8, headHash: '0xa', specVersion: null, error: null }, t + 1000);
    evaluateNetworkRules(db, 'local-anvil', (r) => raiseIncident(db, r));
    expect(db.get(`SELECT state FROM incidents WHERE kind = 'rpc_unreachable'`).state).toBe('resolved');
  });

  it('distinguishes chain halt (single endpoint) from finality lag', () => {
    const { db } = seed(); ep(db);
    const t = Date.now();
    for (let i = 0; i < 5; i++) storeSample(db, { endpointId: 'e1', ok: true, latencyMs: 10, head: 100, finalized: 50, headHash: '0xa', specVersion: null, error: null }, t - 85_000 + i * 20_000);
    evaluateNetworkRules(db, 'local-anvil', (r) => raiseIncident(db, r), undefined, t);
    const kinds = db.all('SELECT kind, inference FROM incidents').map((r) => r.kind).sort();
    expect(kinds).toEqual(['block_stalled', 'finality_lag']);
    expect(JSON.parse(db.get(`SELECT inference FROM incidents WHERE kind = 'block_stalled'`).inference).text).toMatch(/cannot be distinguished/);
  });

  it('indexer lag rule reads cursors; workflow failure rule needs consecutive failures', () => {
    const { db, projectId } = seed();
    db.run(`INSERT INTO cursors (stream_id, network_id, interface, start_block, next_block, head_seen, updated_at) VALUES ('s1', 'local-anvil', 'evm', 0, 10, 900, 'now')`);
    evaluateIndexerRules(db, (r) => raiseIncident(db, r));
    expect(db.get(`SELECT kind FROM incidents`).kind).toBe('indexer_lag');
    db.run(`INSERT INTO workflows (id, project_id, name, created_at, updated_at) VALUES ('w1', ?, 'wf', 'now', 'now')`, projectId);
    for (const [i, st] of ['failed', 'dead_letter', 'failed'].entries()) db.run(`INSERT INTO executions (id, project_id, workflow_id, version, network_id, trigger_type, trigger_key, trigger, input_hash, state, next_run_at, created_at, updated_at, finished_at) VALUES (?, ?, 'w1', 1, 'local-anvil', 'manual', ?, '{}', '0x', ?, 0, 'now', 'now', ?)`, `x${i}`, projectId, `k${i}`, st, `2026-01-0${i + 1}`);
    signalToIncident(db, { kind: 'dead_letter', projectId, executionId: 'x2', workflowId: 'w1', detail: 'boom' });
    expect(db.get(`SELECT COUNT(*) n FROM incidents WHERE kind = 'workflow_failures'`).n).toBe(1);
    signalToIncident(db, { kind: 'succeeded', projectId, executionId: 'x3', workflowId: 'w1', detail: 'ok' });
    expect(db.get(`SELECT state FROM incidents WHERE kind = 'workflow_failures'`).state).toBe('resolved');
  });

  it('resolves unknown-outcome incidents once their execution succeeds', () => {
    const { db, projectId } = seed();
    signalToIncident(db, { kind: 'unknown_outcome', projectId, executionId: '0xabc', workflowId: 'w1', stepId: 'compute', detail: 'reset' });
    expect(db.get(`SELECT state FROM incidents WHERE kind = 'unknown_outcome'`).state).toBe('open');
    signalToIncident(db, { kind: 'succeeded', projectId, executionId: '0xabc', workflowId: 'w1', detail: 'ok' });
    expect(db.get(`SELECT state FROM incidents WHERE kind = 'unknown_outcome'`).state).toBe('resolved');
  });
});

describe('webhook delivery outbox', () => {
  const channel = (db: any, projectId: string, minSeverity = 'warning') => {
    db.run(`INSERT INTO connectors (id, project_id, name, url, allow_private_host, created_at) VALUES ('c1', ?, 'hook', 'https://93.184.216.34/x', 0, '2026-01-01')`, projectId);
    db.run(`INSERT INTO notification_channels (id, project_id, kind, connector, min_severity, created_at) VALUES ('ch1', ?, 'webhook', 'hook', ?, '2026-01-01')`, projectId, minSeverity);
  };
  const row = (db: any) => db.get('SELECT * FROM notifications ORDER BY id DESC LIMIT 1');
  const reply = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;

  it('queues atomically with the incident; retries with backoff; gives up after the limit', async () => {
    const { db, projectId } = seed(); channel(db, projectId);
    let t = 1_000_000; const clock = () => t;
    raiseIncident(db, { ...inc(), projectId }, clock);
    expect(row(db)).toMatchObject({ status: 'pending', attempts: 0 });
    const opts = { workerId: 'w', clock, baseBackoffMs: 1000, maxAttempts: 2, fetchImpl: reply(503) };
    expect(await deliverDue(db, opts)).toMatchObject({ claimed: 1, retrying: 1 });
    expect(row(db)).toMatchObject({ status: 'retrying', attempts: 1, response_code: 503 });
    expect((await deliverDue(db, opts)).claimed).toBe(0);                 // not due yet
    t += 2000;
    expect(await deliverDue(db, opts)).toMatchObject({ claimed: 1, dead: 1 });
    expect(row(db)).toMatchObject({ status: 'dead', attempts: 2 });
    expect(retryDelivery(db, row(db).id, clock).changes).toBe(1);
    expect(await deliverDue(db, { ...opts, fetchImpl: reply(200) })).toMatchObject({ delivered: 1 });
    expect(retryDelivery(db, row(db).id, clock).changes).toBe(0);          // nothing to retry once delivered
  });

  it('a stale worker cannot overwrite the attempt that took over its lease', async () => {
    const { db, projectId } = seed(); channel(db, projectId);
    let t = 1_000_000; const clock = () => t;
    raiseIncident(db, { ...inc(), projectId }, clock);
    let releaseSlow: (r: Response) => void = () => {};
    const slow = (() => new Promise<Response>((r) => { releaseSlow = r; })) as unknown as typeof fetch;
    const first = deliverDue(db, { workerId: 'slow', clock, leaseMs: 100, timeoutMs: 60_000, fetchImpl: slow });
    await new Promise((r) => setTimeout(r, 30));
    t += 200;                                                             // lease expired while the request hangs
    expect(await deliverDue(db, { workerId: 'fast', clock, fetchImpl: reply(200) })).toMatchObject({ delivered: 1 });
    releaseSlow(new Response('{}', { status: 500 }));
    await first;
    expect(row(db)).toMatchObject({ status: 'delivered', claimed_by: 'fast', attempts: 2 });
  });

  it('an incident without a matching channel queues nothing; removing the connector ends the delivery', async () => {
    const { db, projectId } = seed(); channel(db, projectId, 'critical');
    raiseIncident(db, { ...inc(), projectId });
    expect(row(db)).toBeUndefined();
    raiseIncident(db, { ...inc('fp2'), projectId, severity: 'critical' });
    db.run('DELETE FROM connectors WHERE id = ?', 'c1');
    expect(await deliverDue(db, { workerId: 'w', fetchImpl: reply(200) })).toMatchObject({ dead: 1 });
    expect(row(db).error).toMatch(/removed/);
  });
});
