/** PortalForge worker: event routing, schedules, execution, and (optionally) health monitoring. */
import { randomBytes } from 'node:crypto';
import { Db, createLogger, loadConfig, seedNetworks } from '@portalforge/store';
import { WorkflowEngine } from '@portalforge/workflow-engine';
import { heartbeat, signalToIncident, deliverDue } from '@portalforge/ops';
import { buildExecutors } from './executors';
import { Monitor } from './monitor';

const log = createLogger('worker');
const cfg = loadConfig();
const db = new Db(cfg.dbPath).migrate();
seedNetworks(db, cfg.networks);
// Instance ids are random, never the host name: they appear in traces visible to project members.
const workerId = process.env.PF_WORKER_ID ?? `worker-${randomBytes(3).toString('hex')}`;
const concurrency = Math.max(1, Number(process.env.PF_WORKER_CONCURRENCY ?? 4));
const monitorEnabled = process.env.PF_MONITOR !== '0';
const chains = buildExecutors(cfg.networks, log);
const engine = new WorkflowEngine({
  db, workerId, chains, leaseMs: Number(process.env.PF_LEASE_MS ?? 30_000), log: (m, d) => log(m, d),
  onSignal: (s) => {
    log('signal', s as unknown as Record<string, unknown>, s.kind === 'succeeded' ? 'info' : 'warn');
    try {
      signalToIncident(db, s);
    } catch (e) { log('signal handling failed', { error: (e as Error).message }, 'error'); }
  },
});
const monitor = monitorEnabled ? new Monitor(db, cfg.networks, log) : null;
let stopping = false;
let inflight = 0;

async function execLoop(slot: number) {
  while (!stopping) {
    let worked = false;
    try { inflight++; worked = await engine.runNext(); } catch (e) { log('runNext failed', { slot, error: (e as Error).message }, 'error'); } finally { inflight--; }
    if (!worked) await new Promise((r) => setTimeout(r, 500));
  }
}

// Webhook deliveries live in the database; this loop only sends what is due, so a restart loses nothing.
async function deliveryLoop() {
  const opts = { workerId, baseBackoffMs: Number(process.env.PF_NOTIFY_BACKOFF_MS ?? 15_000), leaseMs: Number(process.env.PF_NOTIFY_LEASE_MS ?? 30_000), timeoutMs: Number(process.env.PF_NOTIFY_TIMEOUT_MS ?? 5_000) };
  while (!stopping) {
    let claimed = 0;
    try { inflight++; const r = await deliverDue(db, opts); claimed = r.claimed; if (r.dead) log('webhook delivery gave up', { dead: r.dead }, 'warn'); } catch (e) { log('webhook delivery failed', { error: (e as Error).message }, 'error'); } finally { inflight--; }
    if (!claimed) await new Promise((r) => setTimeout(r, Number(process.env.PF_NOTIFY_POLL_MS ?? 1_000)));
  }
}

async function controlLoop() {
  let lastMonitor = 0;
  while (!stopping) {
    try { const n = engine.routeEvents(); if (n) log('routed events', { created: n }); } catch (e) { log('routing failed', { error: (e as Error).message }, 'error'); }
    try { engine.scheduleTick(); } catch (e) { log('schedule failed', { error: (e as Error).message }, 'error'); }
    heartbeat(db, 'worker', workerId, { concurrency, executors: [...chains.keys()], monitor: monitorEnabled });
    if (monitor && Date.now() - lastMonitor > Number(process.env.PF_MONITOR_INTERVAL_MS ?? 15_000)) {
      lastMonitor = Date.now();
      try { await monitor.tick(); heartbeat(db, 'monitor', workerId, {}); } catch (e) { log('monitor tick failed', { error: (e as Error).message }, 'error'); }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

const shutdown = (sig: string) => {
  if (stopping) return;
  stopping = true;
  log('shutting down; letting in-flight steps finish', { signal: sig, inflight });
  const t0 = Date.now();
  const wait = setInterval(async () => {
    if (inflight === 0 || Date.now() - t0 > 15_000) { clearInterval(wait); await monitor?.close(); db.close(); process.exit(0); }
  }, 100);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
log('worker started', { workerId, concurrency, networks: cfg.networks.map((n) => n.id), executors: [...chains.keys()], monitor: monitorEnabled });
for (let i = 0; i < concurrency; i++) execLoop(i);
deliveryLoop();
controlLoop();
