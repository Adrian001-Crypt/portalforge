import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { z } from 'zod';
import { PfError } from '@portalforge/domain';
import { newId, now, randomToken, sha256 } from '@portalforge/store';
import { type Env, SESSION_COOKIE, requireUser } from '../context';

export const auth = new Hono<Env>();

/**
 * Development/demo sign-in by handle. Enabled only when PF_DEV_LOGIN=1 (local integration).
 * A production deployment would put an identity provider here; the session/CSRF model is the same.
 */
auth.post('/dev-login', async (c) => {
  const deps = c.get('deps');
  if (!deps.devLogin) throw new PfError('NOT_SUPPORTED', 'dev login is disabled on this deployment');
  const { handle } = z.object({ handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/) }).parse(await c.req.json());
  const db = deps.db;
  let u = db.get('SELECT * FROM users WHERE handle = ?', handle);
  if (!u) { db.run('INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)', newId('usr'), handle, handle, now()); u = db.get('SELECT * FROM users WHERE handle = ?', handle); }
  const token = randomToken();
  const csrf = randomToken(18);
  db.run('INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(token), u!.id, csrf, now(), new Date(Date.now() + 12 * 3_600_000).toISOString());
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: deps.secureCookies, path: '/', maxAge: 12 * 3600 });
  return c.json({ user: { id: u!.id, handle }, csrfToken: csrf });
});

auth.post('/logout', (c) => {
  const tok = getCookie(c, SESSION_COOKIE);
  if (tok) c.get('deps').db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(tok));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

auth.get('/me', (c) => {
  const p = c.get('principal');
  if (p.type === 'anonymous') return c.json({ user: null, devLogin: c.get('deps').devLogin, publicReadOnly: c.get('deps').publicReadOnly });
  if (p.type === 'apikey') return c.json({ apiKey: { id: p.keyId, projectId: p.projectId, scopes: p.scopes } });
  const u = requireUser(c);
  const memberships = c.get('deps').db.all('SELECT m.project_id, m.role, p.name, p.slug FROM members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ?', u.userId);
  return c.json({ user: { id: u.userId, handle: u.handle }, csrfToken: u.csrf, memberships, devLogin: c.get('deps').devLogin });
});
