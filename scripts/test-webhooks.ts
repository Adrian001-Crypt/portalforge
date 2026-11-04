/**
 * Webhook notification delivery against a real HTTP receiver and real worker processes on a throwaway database.
 *   npx tsx scripts/test-webhooks.ts
 * Writes docs/test-results/webhooks-latest.json. Local only; no chain and no external network.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, newId, now, json } from '@portalforge/store';
import { LOCAL_ANVIL } from '@portalforge/domain';
import { raiseIncident, resolveByFingerprint, retryDelivery, type RaiseInput } from '@portalforge/ops';
import { startService, tsx, type Svc } from './lib/proc';

const dir = mkdtempSync(join(tmpdir(), 'pf-webhooks-'));
const results: { id: string; ok: boolean; detail: string }[] = [];
const rec = (id: string, ok: boolean, detail: string) => { results.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what: string, f: () => boolean, ms = 25_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(100); } console.log(`timed out waiting for ${what}`); return false; };

// ---- the receiver: scripted per path, processes each delivery key once, as the contract asks receivers to.
interface Hit { key: string; attempt: number; body: string; processedNow: boolean }
const hits = new Map<string, Hit[]>();
const seen = new Set<string>();
type Script = (n: number, req: IncomingMessage, res: ServerResponse) => boolean | void; // return true = the script answered
const scripts = new Map<string, Script>();
const server = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    const path = req.url ?? '/'; const key = String(req.headers['idempotency-key'] ?? '');
    const list = hits.get(path) ?? []; hits.set(path, list);
    const processedNow = !seen.has(key); seen.add(key);
    list.push({ key, attempt: Number(req.headers['x-portalforge-attempt']), body, processedNow });
    if (scripts.get(path)?.(list.length, req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const fail = (code: number, times = Infinity): Script => (n, _q, res) => { if (n > times) return false; res.writeHead(code); res.end(); return true; };

// ---- database: one project, one channel per scenario
const dbPath = join(dir, 'pf.db');
const db = new Db(dbPath).migrate();
const t0 = now();
db.run('INSERT INTO networks (id, profile, builtin, created_at) VALUES (?, ?, 1, ?)', LOCAL_ANVIL.id, json(LOCAL_ANVIL), t0);
const userId = newId('usr');
db.run('INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)', userId, 'owner', 'Owner', t0);
const newProject = (slug: string, path: string, minSeverity = 'warning', url = `${base}${path}`, allowPrivate = 1) => {
  const projectId = newId('prj');
  db.run(`INSERT INTO projects (id, slug, name, description, environment, network_id, created_by, created_at, updated_at) VALUES (?, ?, ?, '', 'development', ?, ?, ?, ?)`, projectId, slug, slug, LOCAL_ANVIL.id, userId, t0, t0);
  db.run('INSERT INTO connectors (id, project_id, name, url, allow_private_host, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('con'), projectId, 'hook', url, allowPrivate, t0);
  db.run('INSERT INTO notification_channels (id, project_id, kind, connector, min_severity, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('chn'), projectId, 'webhook', 'hook', minSeverity, t0);
  return projectId;
};
const diag = { facts: [{ label: 'x', value: '1' }], inference: { source: 'rule:test', text: 't' }, suggestion: ['s'] };
const inc = (projectId: string, fp: string, severity: RaiseInput['severity'] = 'warning'): RaiseInput => ({ fingerprint: fp, kind: 'test', severity, title: `Test ${fp}`, diagnosis: diag, projectId, cooldownMs: 60_000 });
const rows = (projectId: string) => db.all(`SELECT n.* FROM notifications n JOIN incidents i ON i.id = n.incident_id WHERE i.project_id = ? ORDER BY n.id`, projectId);
const statusOf = (projectId: string) => rows(projectId).map((r) => r.status).join(',');

// ---- real worker processes
const svcs: Svc[] = [];
const workerEnv = { PF_DB: dbPath, PF_MODE: 'local', PF_NETWORKS: 'local-anvil', PF_MONITOR: '0', PF_NOTIFY_BACKOFF_MS: '200', PF_NOTIFY_LEASE_MS: '2500', PF_NOTIFY_TIMEOUT_MS: '1200', PF_NOTIFY_POLL_MS: '150', PF_EXECUTOR_KEY_FILE_LOCAL_ANVIL: '' };
const logs = join(dir, 'logs'); mkdirSync(logs, { recursive: true });
const startWorker = (name: string, id: string) => { const w = tsx('services/worker/src/main.ts'); const s = startService(name, w.cmd, w.args, { ...workerEnv, PF_WORKER_ID: id }, logs); svcs.push(s); return s; };

try {
  let worker = startWorker('worker-a', 'worker-a');
  startWorker('worker-b', 'worker-b'); // two workers on one database throughout

  // A. first try succeeds
  { const p = newProject('success', '/success'); raiseIncident(db, inc(p, 'a'));
    await waitFor('A', () => statusOf(p) === 'delivered');
    await sleep(600); const h = hits.get('/success') ?? [];
    const payload = h[0] ? JSON.parse(h[0].body) : {};
    rec('success.first_attempt', statusOf(p) === 'delivered' && h.length === 1 && rows(p)[0].attempts === 1 && rows(p)[0].response_code === 200, `${h.length} request with two workers running; status ${statusOf(p)}`);
    rec('success.key_and_payload', h[0]?.key === rows(p)[0].delivery_key && payload.deliveryId === h[0]?.key && payload.type === 'portalforge.incident' && payload.occurrence === 1, `key ${h[0]?.key}`); }

  // B. 500, 500, then 200: retried with backoff, same key, identical body
  { scripts.set('/flaky', fail(500, 2)); const p = newProject('flaky', '/flaky'); raiseIncident(db, inc(p, 'b'));
    await waitFor('B', () => statusOf(p) === 'delivered');
    const h = hits.get('/flaky') ?? [];
    rec('retry.until_success', statusOf(p) === 'delivered' && h.length === 3 && rows(p)[0].attempts === 3, `${h.length} requests; attempts header ${h.map((x) => x.attempt).join(',')}`);
    rec('retry.same_key_same_body', new Set(h.map((x) => x.key)).size === 1 && new Set(h.map((x) => x.body)).size === 1, 'every retry reuses key and bytes'); }

  // C. a permanent rejection is not retried
  { scripts.set('/gone', fail(410)); const p = newProject('gone', '/gone'); raiseIncident(db, inc(p, 'c'));
    await waitFor('C', () => statusOf(p) === 'dead'); await sleep(800);
    rec('failure.4xx_final', statusOf(p) === 'dead' && hits.get('/gone')?.length === 1 && rows(p)[0].response_code === 410, `${hits.get('/gone')?.length} request; status ${statusOf(p)}; error ${rows(p)[0].error}`); }

  // D. retries run out, the delivery is marked dead, and an operator retry reuses the key
  { const s = fail(503, 5); scripts.set('/down', s); const p = newProject('down', '/down'); raiseIncident(db, inc(p, 'd'));
    await waitFor('D', () => statusOf(p) === 'dead', 40_000);
    const n = hits.get('/down')?.length ?? 0; const key = rows(p)[0].delivery_key;
    rec('failure.gives_up', statusOf(p) === 'dead' && n === 5 && rows(p)[0].attempts === 5, `${n} requests then status ${statusOf(p)}`);
    retryDelivery(db, rows(p)[0].id);
    await waitFor('D retry', () => statusOf(p) === 'delivered');
    const last = hits.get('/down')!.at(-1)!;
    rec('failure.operator_retry', statusOf(p) === 'delivered' && last.key === key && !last.processedNow, `same key; receiver dropped it as a repeat: ${!last.processedNow}`); }

  // E. the same incident raised repeatedly, also from a second connection at the same moment: one delivery
  { const p = newProject('storm', '/storm'); const other = new Db(dbPath);
    const raises = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => raiseIncident(i % 2 ? db : other, inc(p, 'e')))));
    other.close();
    await waitFor('E', () => statusOf(p) === 'delivered'); await sleep(800);
    const count = db.get('SELECT count FROM incidents WHERE project_id = ?', p).count;
    rec('duplicate.aggregated', hits.get('/storm')?.length === 1 && rows(p).length === 1 && count === 20 && raises.filter((r) => r.isNew).length === 1, `20 raises → count ${count}, ${hits.get('/storm')?.length} delivery`); }

  // F. resolved and re-opened: a new occurrence with a new key
  { const p = newProject('reopen', '/reopen'); raiseIncident(db, inc(p, 'f'));
    await waitFor('F1', () => statusOf(p) === 'delivered');
    resolveByFingerprint(db, 'f', 'test', 'done', 60_000);
    const r = raiseIncident(db, inc(p, 'f'));
    await waitFor('F2', () => statusOf(p) === 'delivered,delivered');
    const h = hits.get('/reopen') ?? [];
    rec('duplicate.reopen_is_new', r.reopened && h.length === 2 && h[0].key !== h[1].key && JSON.parse(h[1].body).occurrence === 2, `keys ${h.map((x) => x.key.split(':')[1]).join(' → ')}`); }

  // G. severity filter, and escalation past the filter while the incident stays open
  { const p = newProject('sev', '/sev', 'critical'); raiseIncident(db, inc(p, 'g', 'warning')); await sleep(800);
    const quiet = (hits.get('/sev')?.length ?? 0) === 0 && rows(p).length === 0;
    raiseIncident(db, inc(p, 'g', 'critical'));
    await waitFor('G', () => statusOf(p) === 'delivered');
    raiseIncident(db, inc(p, 'g', 'critical')); await sleep(600);
    const h = hits.get('/sev') ?? [];
    rec('filter.severity_and_escalation', quiet && h.length === 1 && JSON.parse(h[0].body).severity === 'critical', `warning: 0 deliveries; escalated to critical: ${h.length}`); }

  // H. the receiver processes it and the connection dies before the response: retried, processed once
  { scripts.set('/lost', (n, _q, res) => { if (n === 1) { res.socket?.destroy(); return true; } return false; }); const p = newProject('lost', '/lost'); raiseIncident(db, inc(p, 'h'));
    await waitFor('H', () => statusOf(p) === 'delivered');
    const h = hits.get('/lost') ?? [];
    rec('lost_response.processed_once', h.length === 2 && h[0].key === h[1].key && h.filter((x) => x.processedNow).length === 1, `${h.length} requests, ${h.filter((x) => x.processedNow).length} processed`); }

  // I. a target that points at a private address without permission: never sent, not retried
  { const p = newProject('unsafe', '/unsafe', 'warning', `${base}/unsafe`, 0); raiseIncident(db, inc(p, 'i'));
    await waitFor('I', () => statusOf(p) === 'dead'); await sleep(500);
    rec('unsafe_target.refused', statusOf(p) === 'dead' && !hits.get('/unsafe')?.length && rows(p)[0].attempts === 1, `0 requests; error ${String(rows(p)[0].error).slice(0, 70)}`); }

  // J. every worker is killed while a request is in flight: the restart sends it again under the same key
  await svcs.pop()!.stop(); // stop worker-b so only the worker we kill holds the lease
  { let release: (() => void) | undefined;
    scripts.set('/hang', (n, _q, res) => { if (n === 1) { release = () => res.destroy(); return true; } return false; });
    const p = newProject('hang', '/hang'); raiseIncident(db, inc(p, 'j'));
    await waitFor('J request', () => (hits.get('/hang')?.length ?? 0) === 1);
    const claimedBy = rows(p)[0].claimed_by; const midStatus = statusOf(p);
    worker.proc.kill('SIGKILL'); await sleep(300); release?.();
    const stuck = statusOf(p) === 'sending';
    worker = startWorker('worker-c', 'worker-c');
    await waitFor('J', () => statusOf(p) === 'delivered', 30_000);
    const h = hits.get('/hang') ?? [];
    rec('worker_killed.redelivered', midStatus === 'sending' && stuck && statusOf(p) === 'delivered' && h.length === 2 && h[0].key === h[1].key && h.filter((x) => x.processedNow).length === 1 && rows(p)[0].claimed_by === 'worker-c', `claimed by ${claimedBy}, killed mid-request, finished by ${rows(p)[0].claimed_by}; ${h.length} requests, 1 processed`); }

  // K. a raise while no worker is running is queued, not lost
  { await svcs.pop()!.stop();
    const p = newProject('queued', '/queued'); raiseIncident(db, inc(p, 'k'));
    await sleep(500); const before = statusOf(p);
    startWorker('worker-d', 'worker-d');
    await waitFor('K', () => statusOf(p) === 'delivered');
    rec('no_worker.queued', before === 'pending' && statusOf(p) === 'delivered' && hits.get('/queued')?.length === 1, `${before} → ${statusOf(p)}`); }
} catch (e) {
  rec('harness', false, (e as Error).stack ?? String(e));
} finally {
  for (const s of svcs) await s.stop().catch(() => {});
  server.closeAllConnections(); server.close(); db.close();
  rmSync(dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
mkdirSync('docs/test-results', { recursive: true });
writeFileSync('docs/test-results/webhooks-latest.json', JSON.stringify({ suite: 'webhook delivery', ranAt: new Date().toISOString(), runsAgainst: 'real worker processes, real local HTTP receiver, throwaway SQLite; no chain', passed: results.length - failed.length, failed: failed.length, results }, null, 2) + '\n');
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
