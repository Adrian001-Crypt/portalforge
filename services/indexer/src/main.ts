/** PortalForge indexer service: EVM log streams + native event stream per configured network. */
import { randomBytes } from 'node:crypto';
import { Db, createLogger, loadConfig, seedNetworks } from '@portalforge/store';
import { EvmReader } from '@portalforge/portaldot-evm';
import { NativeReader } from '@portalforge/portaldot-native';
import { heartbeat, raiseIncident } from '@portalforge/ops';
import { EvmIndexer } from './evm';
import { NativeIndexer } from './native';

const log = createLogger('indexer');
const cfg = loadConfig();
const db = new Db(cfg.dbPath).migrate();
seedNetworks(db, cfg.networks);
const instance = `indexer-${randomBytes(3).toString('hex')}`;
const intervalMs = Number(process.env.PF_INDEX_INTERVAL_MS ?? 3000);
const nativeEnabled = process.env.PF_NATIVE_INDEX !== '0';
let stopping = false;

const evm = cfg.networks.map((p) => new EvmIndexer(db, p, new EvmReader(p.evm.rpcUrl), { log: (m, d) => log(m, { network: p.id, ...d }) }));
const natives: { ix: NativeIndexer | null; profile: (typeof cfg.networks)[number]; reader: NativeReader | null; lastTry: number }[] = cfg.networks.filter((p) => p.native && nativeEnabled).map((profile) => ({ ix: null, profile, reader: null, lastTry: 0 }));

async function ensureNative(n: (typeof natives)[number]) {
  if (n.reader?.connected) return n.ix;
  if (Date.now() - n.lastTry < 15_000) return null;
  n.lastTry = Date.now();
  try {
    n.reader = await NativeReader.connect(n.profile.native!.wsUrl);
    await n.reader.assertIdentity(n.profile); // fail closed on a swapped endpoint
    n.ix = new NativeIndexer(db, n.profile, n.reader, {
      log: (m, d) => log(m, { network: n.profile.id, ...d }),
      onRuntimeUpgrade: (from, to, block) => raiseIncident(db, { fingerprint: `runtime_upgrade:${n.profile.id}:${to}`, kind: 'runtime_upgrade', severity: 'warning', networkId: n.profile.id, title: `Runtime upgraded ${from} → ${to} at #${block}`, diagnosis: { facts: [{ label: 'block', value: String(block) }, { label: 'spec', value: `${from} → ${to}` }], inference: { source: 'rule:runtime_upgrade', text: 'Blocks after the upgrade are decoded with the new metadata (decoder version runtime:spec' + to + ').' }, suggestion: ['Re-run pf network inspect.', 'Review decode errors in the Event Explorer.'] } }),
    });
    log('native connected', { network: n.profile.id });
    return n.ix;
  } catch (e) {
    log('native connect failed', { network: n.profile.id, error: (e as Error).message }, 'warn');
    await n.reader?.disconnect().catch(() => {});
    n.reader = null; n.ix = null;
    return null;
  }
}

async function loop() {
  while (!stopping) {
    const t0 = Date.now();
    for (const ix of evm) {
      try { const r = await ix.tick(); if (r.errors) log('evm tick errors', { network: ix.profile.id, errors: r.errors }, 'warn'); } catch (e) { log('evm tick failed', { network: ix.profile.id, error: (e as Error).message }, 'error'); }
    }
    for (const n of natives) {
      const ix = await ensureNative(n);
      if (ix) try { await ix.tick(); } catch (e) { log('native tick failed', { network: n.profile.id, error: (e as Error).message }, 'error'); }
    }
    heartbeat(db, 'indexer', instance, { networks: cfg.networks.map((n) => n.id), native: natives.map((n) => ({ network: n.profile.id, connected: !!n.reader?.connected })) });
    const wait = Math.max(200, intervalMs - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log('shutting down', { signal: sig });
  setTimeout(async () => { for (const n of natives) await n.reader?.disconnect().catch(() => {}); db.close(); process.exit(0); }, Math.min(intervalMs, 2000));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
log('indexer started', { networks: cfg.networks.map((n) => n.id), db: cfg.dbPath, native: nativeEnabled });
loop();
