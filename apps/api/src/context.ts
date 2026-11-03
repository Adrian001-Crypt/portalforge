import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { PfError, can, scopeAllows, httpStatusFor, isPfError, type Permission, type Role, type NetworkProfile } from '@portalforge/domain';
import { type Db, sha256, now, json, type Logger } from '@portalforge/store';
import type { WorkflowEngine } from '@portalforge/workflow-engine';

export type Principal =
  | { type: 'user'; userId: string; handle: string; csrf: string }
  | { type: 'apikey'; keyId: string; projectId: string; scopes: string[] }
  | { type: 'anonymous' };

export interface ApiDeps {
  db: Db;
  engine: WorkflowEngine;
  networks: NetworkProfile[];
  log: Logger;
  devLogin: boolean;
  publicReadOnly: boolean;
  allowedOrigins: string[];
  allowPrivateConnectors: boolean;
  secureCookies: boolean;
  aiExplain?: (prompt: string) => Promise<{ model: string; text: string }>;
}

export type Env = { Variables: { principal: Principal; deps: ApiDeps } };

export const SESSION_COOKIE = 'pf_session';

/** Resolve the caller from session cookie or API key. Never throws for anonymous callers. */
export const authenticate: MiddlewareHandler<Env> = async (c, next) => {
  const { db } = c.get('deps');
  let principal: Principal = { type: 'anonymous' };
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer pf_')) {
    const key = db.get(`SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`, sha256(auth.slice(7)));
    if (!key) throw new PfError('UNAUTHENTICATED', 'invalid API key');
    db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), key.id);
    principal = { type: 'apikey', keyId: key.id, projectId: key.project_id, scopes: JSON.parse(key.scopes) };
  } else {
    const tok = getCookie(c, SESSION_COOKIE);
    if (tok) {
      const s = db.get(`SELECT s.*, u.handle FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(tok), now());
      if (s) principal = { type: 'user', userId: s.user_id, handle: s.handle, csrf: s.csrf_token };
    }
  }
  c.set('principal', principal);
  await next();
};

/** Cookie-authenticated writes require a same-origin Origin header and the session's CSRF token. */
export const csrfGuard: MiddlewareHandler<Env> = async (c, next) => {
  const p = c.get('principal');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && p.type === 'user') {
    const origin = c.req.header('origin');
    const { allowedOrigins } = c.get('deps');
    if (!origin || !allowedOrigins.includes(origin)) throw new PfError('FORBIDDEN', 'cross-origin write refused');
    if (c.req.header('x-csrf-token') !== p.csrf) throw new PfError('FORBIDDEN', 'missing or invalid CSRF token');
  }
  await next();
};

const buckets = new Map<string, { tokens: number; at: number }>();
export const rateLimit = (perMinute: number, writePerMinute: number): MiddlewareHandler<Env> => async (c, next) => {
  const p = c.get('principal');
  const who = p.type === 'user' ? `u:${p.userId}` : p.type === 'apikey' ? `k:${p.keyId}` : `ip:${c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? (c.env as any)?.incoming?.socket?.remoteAddress ?? 'local'}`;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  const limit = write ? writePerMinute : perMinute;
  const key = `${who}:${write ? 'w' : 'r'}`;
  const t = Date.now();
  const b = buckets.get(key) ?? { tokens: limit, at: t };
  b.tokens = Math.min(limit, b.tokens + ((t - b.at) / 60_000) * limit);
  b.at = t;
  if (b.tokens < 1) { c.header('retry-after', '10'); throw new PfError('RATE_LIMITED', 'rate limit exceeded'); }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 50_000) buckets.clear();
  await next();
};

export function requireUser(c: Context<Env>) {
  const p = c.get('principal');
  if (p.type !== 'user') throw new PfError('UNAUTHENTICATED', 'sign in required');
  return p;
}

/**
 * Project-scoped authorization. Non-members of private projects get NOT_FOUND (existence is not leaked).
 * Public read-only projects are readable by anyone but never writable without membership.
 */
export function requireProject(c: Context<Env>, projectId: string, perm: Permission): { project: any; role: Role | 'public' | 'apikey'; actor: string } {
  const { db, publicReadOnly } = c.get('deps');
  const project = db.get('SELECT * FROM projects WHERE id = ? OR slug = ?', projectId, projectId);
  const p = c.get('principal');
  const readPerm = perm === 'project.read';
  if (!project) throw new PfError('NOT_FOUND', 'project not found');
  if (p.type === 'apikey') {
    if (p.projectId !== project.id) throw new PfError('NOT_FOUND', 'project not found');
    if (!scopeAllows(p.scopes, perm)) throw new PfError('FORBIDDEN', `API key lacks scope for ${perm}`);
    return { project, role: 'apikey', actor: `apikey:${p.keyId}` };
  }
  if (p.type === 'user') {
    const m = db.get('SELECT role FROM members WHERE project_id = ? AND user_id = ?', project.id, p.userId);
    if (m) {
      if (!can(m.role, perm)) throw new PfError('FORBIDDEN', `role ${m.role} cannot ${perm}`);
      return { project, role: m.role, actor: `user:${p.handle}` };
    }
  }
  if (readPerm && project.visibility === 'public_readonly' && (publicReadOnly || p.type === 'user')) return { project, role: 'public', actor: p.type === 'user' ? `user:${p.handle}` : 'anonymous' };
  if (project.visibility === 'public_readonly' && !readPerm) throw new PfError(p.type === 'anonymous' ? 'UNAUTHENTICATED' : 'FORBIDDEN', 'public demo projects are read-only');
  throw new PfError('NOT_FOUND', 'project not found');
}

export function audit(db: Db, projectId: string | null, actor: string, action: string, target: string | null, detail?: unknown) {
  db.run('INSERT INTO audit_log (project_id, actor, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)', projectId, actor, action, target, json(detail ?? null), now());
}

export function errorResponse(e: unknown, c: Context) {
  if (isPfError(e)) return c.json({ error: e.toJSON() }, httpStatusFor(e.code) as any);
  const msg = (e as Error)?.message ?? 'internal error';
  if (/Malformed JSON|Unexpected token|JSON/.test(msg)) return c.json({ error: { code: 'BAD_REQUEST', message: 'malformed JSON body' } }, 400);
  return c.json({ error: { code: 'INTERNAL', message: 'internal error' } }, 500);
}

export const page = (q: Record<string, string | undefined>) => {
  const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
  const cursor = q.cursor ? Number(q.cursor) : null;
  return { limit, cursor: cursor !== null && Number.isFinite(cursor) ? cursor : null };
};
