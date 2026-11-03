import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import { hashCanonical } from '@portalforge/domain';

/**
 * Example receiver. Contract with PortalForge:
 *  POST /v1/square  {executionId, jobId, input}  Idempotency-Key: <executionId>
 *     computes input² once per executionId and returns the stored result on every repeat.
 *  GET  /v1/square/:executionId  → 200 stored result | 404 never processed
 * Fault injection (DEMO_FAULTS=1 and x-admin-token): drop the response AFTER processing,
 * fail with 500 BEFORE processing, or add latency.
 */
export interface DemoServiceOptions { port?: number; host?: string; dbPath?: string; faults?: boolean; adminToken?: string }

export function startDemoService(opts: DemoServiceOptions = {}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const db = new DatabaseSync(opts.dbPath ?? ':memory:');
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS results (execution_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, result_hash TEXT NOT NULL, processed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT, outcome TEXT NOT NULL, at TEXT NOT NULL);`);
  const faults = { dropNextResponse: 0, failNext: 0, delayMs: 0 };
  const adminToken = opts.adminToken ?? process.env.DEMO_ADMIN_TOKEN ?? '';
  const faultsEnabled = opts.faults ?? process.env.DEMO_FAULTS === '1';

  const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 16_384) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(s)); req.on('error', bad);
  });
  const isAdmin = (req: IncomingMessage) => {
    const t = String(req.headers['x-admin-token'] ?? '');
    return faultsEnabled && adminToken.length >= 16 && t.length === adminToken.length && timingSafeEqual(Buffer.from(t), Buffer.from(adminToken));
  };
  const log = (executionId: string | null, outcome: string) => db.prepare('INSERT INTO requests (execution_id, outcome, at) VALUES (?, ?, ?)').run(executionId, outcome, new Date().toISOString());
  const rowOut = (r: any) => ({ executionId: r.execution_id, jobId: r.job_id, input: r.input, result: r.result, resultHash: r.result_hash, processedAt: r.processed_at });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, service: 'portalforge-demo-service' });
      const m = /^\/v1\/square\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const r = db.prepare('SELECT * FROM results WHERE execution_id = ?').get(m[1].toLowerCase());
        log(m[1].toLowerCase(), r ? 'query_hit' : 'query_miss');
        return r ? send(res, 200, rowOut(r)) : send(res, 404, { error: 'not processed' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/square') {
        const body = JSON.parse(await readBody(req) || '{}');
        const executionId = String(body.executionId ?? '').toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(executionId)) return send(res, 400, { error: 'executionId must be bytes32 hex' });
        if (String(req.headers['idempotency-key'] ?? '').toLowerCase() !== executionId) return send(res, 400, { error: 'Idempotency-Key must equal executionId' });
        const input = String(body.input ?? '');
        const jobId = String(body.jobId ?? '');
        if (!/^\d{1,20}$/.test(input) || BigInt(input) > 2n ** 64n - 1n) return send(res, 422, { error: 'input must be a uint64' });
        if (!/^\d{1,78}$/.test(jobId)) return send(res, 422, { error: 'jobId must be an integer' });
        if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));
        if (faults.failNext > 0) { faults.failNext--; log(executionId, 'injected_500'); return send(res, 500, { error: 'injected failure before processing' }); }
        const existing = db.prepare('SELECT * FROM results WHERE execution_id = ?').get(executionId) as any;
        let row = existing;
        if (!existing) {
          const result = (BigInt(input) * BigInt(input)).toString();
          const resultHash = hashCanonical({ jobId, input, result });
          db.prepare('INSERT INTO results (execution_id, job_id, input, result, result_hash, processed_at) VALUES (?, ?, ?, ?, ?, ?)').run(executionId, jobId, input, result, resultHash, new Date().toISOString());
          row = db.prepare('SELECT * FROM results WHERE execution_id = ?').get(executionId);
          log(executionId, 'processed');
        } else log(executionId, 'replayed_stored_result');
        if (faults.dropNextResponse > 0) { faults.dropNextResponse--; log(executionId, 'injected_response_drop'); req.socket.destroy(); return; }
        return send(res, 200, rowOut(row));
      }
      if (url.pathname === '/admin/faults' && req.method === 'POST') {
        if (!isAdmin(req)) return send(res, 403, { error: 'fault injection disabled or bad token' });
        const b = JSON.parse(await readBody(req) || '{}');
        for (const k of ['dropNextResponse', 'failNext', 'delayMs'] as const) if (Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= 60_000) faults[k] = b[k];
        return send(res, 200, faults);
      }
      if (url.pathname === '/admin/stats' && req.method === 'GET') {
        const processed = (db.prepare(`SELECT COUNT(*) n FROM requests WHERE outcome = 'processed'`).get() as any).n;
        const byOutcome = db.prepare('SELECT outcome, COUNT(*) n FROM requests GROUP BY outcome').all();
        const perExecution = db.prepare(`SELECT execution_id, SUM(outcome = 'processed') processed, COUNT(*) requests FROM requests WHERE execution_id IS NOT NULL GROUP BY execution_id`).all();
        return send(res, 200, { processed, byOutcome, perExecution, faults: faultsEnabled ? faults : 'disabled' });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 400, { error: (e as Error).message }); }
  });
  return new Promise((ok) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
    const a = server.address() as { port: number };
    ok({ server, url: `http://${opts.host ?? '127.0.0.1'}:${a.port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => { db.close(); c(); }); }) });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.DEMO_SERVICE_PORT ?? 4310);
  startDemoService({ port, dbPath: process.env.DEMO_SERVICE_DB ?? 'data/demo-service.db' }).then((s) => console.log(JSON.stringify({ msg: 'demo-service listening', url: s.url, faults: process.env.DEMO_FAULTS === '1' })));
}
