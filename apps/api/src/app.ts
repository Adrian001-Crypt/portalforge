import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { PfError } from '@portalforge/domain';
import { serviceHealth } from '@portalforge/ops';
import { type ApiDeps, type Env, authenticate, csrfGuard, rateLimit, errorResponse } from './context';
import { auth } from './routes/auth';
import { projects } from './routes/projects';
import { contracts } from './routes/contracts';
import { workflows } from './routes/workflows';
import { ops } from './routes/ops';
import { OPENAPI } from './openapi';

export type { ApiDeps } from './context';

export function createApp(deps: ApiDeps, opts: { webDist?: string } = {}) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
  app.use('*', secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", ...deps.networks.map((n) => n.evm.rpcUrl)], frameAncestors: ["'none'"] },
    referrerPolicy: 'no-referrer',
  }));
  app.onError((e, c) => {
    if (!(e instanceof PfError) && (e as any)?.name !== 'ZodError' && !(e instanceof SyntaxError)) deps.log('unhandled error', { path: c.req.path, error: (e as Error).message }, 'error');
    if ((e as any)?.name === 'ZodError') return c.json({ error: { code: 'VALIDATION_FAILED', message: 'invalid request', details: { issues: (e as any).issues.map((i: any) => ({ path: i.path.join('.'), message: i.message })) } } }, 400);
    return errorResponse(e, c);
  });
  const api = new Hono<Env>();
  api.use('*', bodyLimit({ maxSize: 512 * 1024, onError: () => { throw new PfError('PAYLOAD_TOO_LARGE', 'request body exceeds 512 KiB'); } }));
  api.use('*', authenticate);
  api.use('*', rateLimit(Number(process.env.PF_RATE_READ ?? 600), Number(process.env.PF_RATE_WRITE ?? 120)));
  api.use('*', csrfGuard);
  api.get('/health', (c) => {
    const ok = !!deps.db.get('SELECT 1 ok');
    return c.json({ ok, service: 'portalforge-api', mode: process.env.PF_MODE ?? 'local', publicReadOnly: deps.publicReadOnly, networks: deps.networks.map((n) => n.id), services: serviceHealth(deps.db), time: new Date().toISOString() });
  });
  api.get('/openapi.json', (c) => c.json(OPENAPI));
  api.route('/auth', auth);
  api.route('/projects', projects);
  api.route('/', contracts);
  api.route('/', workflows);
  api.route('/', ops);
  app.route('/api/v1', api);
  app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: 'no such endpoint' } }, 404));
  if (opts.webDist && existsSync(opts.webDist)) {
    const index = readFileSync(`${opts.webDist}/index.html`, 'utf8');
    app.use('/assets/*', serveStatic({ root: opts.webDist }));
    app.use('/favicon.svg', serveStatic({ root: opts.webDist }));
    app.get('*', (c) => c.html(index)); // SPA routing
  }
  return app;
}
