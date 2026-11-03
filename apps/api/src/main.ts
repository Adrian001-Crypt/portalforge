/** PortalForge API server (also serves the built web console from apps/web/dist). */
import { serve } from '@hono/node-server';
import { Db, createLogger, loadConfig, seedNetworks } from '@portalforge/store';
import { WorkflowEngine } from '@portalforge/workflow-engine';
import { createApp } from './app';
import { seedDemo } from './seed';

const log = createLogger('api');
const cfg = loadConfig();
const db = new Db(cfg.dbPath).migrate();
seedNetworks(db, cfg.networks);
const port = Number(process.env.PF_API_PORT ?? 4300);
const origin = process.env.PF_PUBLIC_ORIGIN ?? `http://localhost:${process.env.PF_WEB_PORT ?? 5180}`;
// The API process never executes workflows; it only creates and controls them. No chain executors here.
const engine = new WorkflowEngine({ db, workerId: `api:${process.pid}` });
if (process.env.PF_SEED_DEMO === '1') seedDemo(db, engine, cfg, log);
const app = createApp({
  db, engine, networks: cfg.networks, log,
  devLogin: process.env.PF_DEV_LOGIN === '1',
  publicReadOnly: cfg.publicReadOnly,
  allowedOrigins: [...new Set([origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...(process.env.PF_EXTRA_ORIGINS ?? '').split(',').filter(Boolean)])],
  allowPrivateConnectors: process.env.PF_ALLOW_PRIVATE_CONNECTORS === '1',
  secureCookies: origin.startsWith('https://'),
}, { webDist: process.env.PF_WEB_DIST ?? 'apps/web/dist' });
const server = serve({ fetch: app.fetch, port, hostname: process.env.PF_API_HOST ?? '127.0.0.1' }, (i) => log('api listening', { port: i.port, networks: cfg.networks.map((n) => n.id), devLogin: process.env.PF_DEV_LOGIN === '1', publicReadOnly: cfg.publicReadOnly }));
const shutdown = () => { log('shutting down'); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
