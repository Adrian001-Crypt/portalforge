import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Db, createLogger, seedNetworks } from '@portalforge/store';
import { WorkflowEngine } from '@portalforge/workflow-engine';
import { createApp } from '../src/app';
import { startAnvil, deployDemo, userAcct } from '../../../packages/workflow-engine/test/helpers';

const ORIGIN = 'http://localhost:5180';
let anvil: Awaited<ReturnType<typeof startAnvil>>;
let demo: Awaited<ReturnType<typeof deployDemo>>;
let app: ReturnType<typeof createApp>;
let db: Db;

beforeAll(async () => {
  anvil = await startAnvil();
  demo = await deployDemo(anvil.profile);
  db = new Db(':memory:').migrate();
  seedNetworks(db, [anvil.profile]);
  app = createApp({ db, engine: new WorkflowEngine({ db, workerId: 'api' }), networks: [anvil.profile], log: createLogger('test'), devLogin: true, publicReadOnly: true, allowedOrigins: [ORIGIN], allowPrivateConnectors: true, secureCookies: false });
}, 60_000);
afterAll(() => anvil.stop());

type Session = { cookie: string; csrf: string };
async function login(handle: string): Promise<Session> {
  const r = await app.request('/api/v1/auth/dev-login', { method: 'POST', body: JSON.stringify({ handle }), headers: { 'content-type': 'application/json' } });
  const body = await r.json();
  return { cookie: r.headers.get('set-cookie')!.split(';')[0], csrf: body.csrfToken };
}
const call = (s: Session | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(`/api/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN } : {}), ...extra } });

let alice: Session, bob: Session;
let projectId: string;

describe('API security and isolation', () => {
  it('signs in and creates a project', async () => {
    alice = await login('alice'); bob = await login('bob');
    const r = await call(alice, 'POST', '/projects', { name: 'Alice app', slug: 'alice-app', environment: 'development', networkId: anvil.profile.id });
    expect(r.status).toBe(201);
    projectId = (await r.json()).id;
  });

  it('refuses cookie writes without CSRF token or with a foreign Origin', async () => {
    const noCsrf = await app.request('/api/v1/projects', { method: 'POST', body: '{}', headers: { cookie: alice.cookie, origin: ORIGIN, 'content-type': 'application/json' } });
    expect(noCsrf.status).toBe(403);
    const evil = await app.request('/api/v1/projects', { method: 'POST', body: '{}', headers: { cookie: alice.cookie, 'x-csrf-token': alice.csrf, origin: 'https://evil.example', 'content-type': 'application/json' } });
    expect(evil.status).toBe(403);
  });

  it('hides private projects from non-members (404, not 403)', async () => {
    expect((await call(bob, 'GET', `/projects/${projectId}`)).status).toBe(404);
    expect((await call(bob, 'GET', `/projects/${projectId}/events`)).status).toBe(404);
    expect((await call(null, 'GET', `/projects/${projectId}`)).status).toBe(404);
  });

  it('enforces application roles: viewer reads but cannot write', async () => {
    expect((await call(alice, 'POST', `/projects/${projectId}/members`, { handle: 'bob', role: 'viewer' })).status).toBe(200);
    expect((await call(bob, 'GET', `/projects/${projectId}`)).status).toBe(200);
    const w = await call(bob, 'POST', `/projects/${projectId}/workflows`, { name: 'x', definition: JSON.parse(readFileSync('examples/workflows/job-square.json', 'utf8')) });
    expect(w.status).toBe(403);
    expect((await call(bob, 'GET', `/projects/${projectId}/audit`)).status).toBe(200);
  });

  it('registers a contract only if code exists on the project network; rejects malicious ABIs', async () => {
    const abi = JSON.parse(readFileSync('contracts/evm/out/JobRegistry.sol/JobRegistry.json', 'utf8')).abi;
    const bad = await call(alice, 'POST', `/projects/${projectId}/contracts`, { alias: 'jobs', address: '0x000000000000000000000000000000000000dEaD', abi, deployBlock: 0 });
    expect(bad.status).toBe(400);
    const evilAbi = await call(alice, 'POST', `/projects/${projectId}/contracts`, { alias: 'jobs', address: demo.JobRegistry.address, abi: [{ type: 'function', name: '<img src=x onerror=alert(1)>' }], deployBlock: 0 });
    expect(evilAbi.status).toBe(400);
    const ok = await call(alice, 'POST', `/projects/${projectId}/contracts`, { alias: 'jobs', address: demo.JobRegistry.address, abi, deployBlock: demo.JobRegistry.block });
    expect(ok.status).toBe(201);
    const detail = await (await call(bob, 'GET', `/contracts/${(await ok.json()).id}`)).json();
    expect(detail.permissions.chain.reads.find((r: any) => r.fn === 'executor').value).toMatch(/^0x/i);
    expect(detail.permissions.platform.members.length).toBe(2);
  });

  it('blocks SSRF connector targets', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:22/', 'file:///etc/passwd', 'http://user:pw@example.com/']) {
      const r = await call(alice, 'POST', `/projects/${projectId}/connectors`, { name: 'evil', url });
      expect(r.status, url).toBe(403);
    }
  });

  it('limits body size and validates JSON', async () => {
    const big = await call(alice, 'POST', '/workflows/validate', { definition: 'x'.repeat(600_000) });
    expect(big.status).toBe(413);
    const bad = await app.request('/api/v1/workflows/validate', { method: 'POST', body: '{nope', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
  });

  it('API keys are project-scoped and least-privilege', async () => {
    const k = await (await call(alice, 'POST', `/projects/${projectId}/api-keys`, { name: 'ci', scopes: ['read'] })).json();
    const auth = { authorization: `Bearer ${k.secret}` };
    expect((await call(null, 'GET', `/projects/${projectId}/events`, undefined, auth)).status).toBe(200);
    const created = await call(alice, 'POST', `/projects/${projectId}/workflows`, { name: 'job-square', definition: JSON.parse(readFileSync('examples/workflows/job-square.json', 'utf8')) });
    const wid = (await created.json()).id;
    expect((await call(null, 'POST', `/workflows/${wid}/run`, {}, auth)).status).toBe(403);
    expect((await call(null, 'POST', `/projects/${projectId}/api-keys`, { name: 'x', scopes: ['read'] }, auth)).status).toBe(403);
    const other = await (await call(bob, 'POST', '/projects', { name: 'Bob app', slug: 'bob-app', environment: 'development', networkId: anvil.profile.id })).json();
    expect((await call(null, 'GET', `/projects/${other.id}`, undefined, auth)).status).toBe(404);
    await call(alice, 'DELETE', `/projects/${projectId}/api-keys/${k.id}`);
    expect((await call(null, 'GET', `/projects/${projectId}/events`, undefined, auth)).status).toBe(401);
  });

  it('exports configuration without secrets', async () => {
    const r = await (await call(alice, 'GET', `/projects/${projectId}/export`)).text();
    expect(r).not.toMatch(/key_hash|raw_tx|privateKey|csrf|token_hash|pf_[A-Za-z0-9]{4,}_/);
    expect(JSON.parse(r).contentHash).toMatch(/^0x/);
  });

  it('public read-only projects: anyone reads, nobody writes without membership', async () => {
    db.run(`UPDATE projects SET visibility = 'public_readonly' WHERE id = ?`, projectId);
    expect((await call(null, 'GET', `/projects/${projectId}/events`)).status).toBe(200);
    const carol = await login('carol');
    expect((await call(carol, 'POST', `/projects/${projectId}/connectors`, { name: 'x', url: 'https://example.com' })).status).toBe(403);
    expect((await call(null, 'POST', `/projects/${projectId}/policies`, {})).status).toBe(401);
    expect((await call(carol, 'GET', `/projects/${projectId}/audit`)).status).toBe(403);
    db.run(`UPDATE projects SET visibility = 'private' WHERE id = ?`, projectId);
  });

  it('public read-only mode hides internal targets and host names, and refuses anonymous reconciliation', async () => {
    db.run(`UPDATE projects SET visibility = 'public_readonly' WHERE id = ?`, projectId);
    await call(alice, 'POST', `/projects/${projectId}/connectors`, { name: 'internal', url: 'http://127.0.0.1:4310/v1/square' }); // owner may add a private target (deployment allows it)
    expect((await call(null, 'GET', `/projects/${projectId}/connectors`)).status).toBe(403);
    expect((await call(null, 'GET', `/projects/${projectId}/channels`)).status).toBe(403);
    expect((await call(alice, 'GET', `/projects/${projectId}/connectors`)).status).toBe(200);
    expect((await call(null, 'POST', '/wallet-intents/wit_any/refresh')).status).toBe(401);
    db.run(`INSERT INTO heartbeats (service, instance, at, info) VALUES ('worker', 'secret-host.local:123', ?, '{"executors":["local-anvil"],"concurrency":4}') ON CONFLICT DO NOTHING`, Date.now());
    const h = await (await call(null, 'GET', '/health')).text();
    expect(h).not.toContain('secret-host');
    expect(h).toContain('local-anvil');
    const signedIn = await (await call(alice, 'GET', '/health')).text();
    expect(signedIn).toContain('secret-host');
    db.run(`UPDATE projects SET visibility = 'private' WHERE id = ?`, projectId);
  });

  it('simulates a workflow without side effects', async () => {
    const def = JSON.parse(readFileSync('examples/workflows/job-square.json', 'utf8'));
    const r = await (await call(null, 'POST', '/workflows/simulate', { definition: def, trigger: { args: { jobId: '1', input: '12' } }, stubs: { compute: { result: '144', resultHash: '0x' + 'a'.repeat(64) } } })).json();
    expect(r.trace.map((s: any) => s.state)).toEqual(['succeeded', 'stubbed', 'succeeded', 'would_call', 'would_register']);
    expect(r.trace[3].note).toContain('completeJob(["1","0xeeee');
  });

  it('wallet intents: chain must match, one open intent per account, outcomes recorded', async () => {
    const base = { kind: 'call', from: userAcct.address, to: demo.JobRegistry.address, contractAlias: 'jobs', functionName: 'requestJob', args: ['5'], data: '0x1234' };
    expect((await call(alice, 'POST', `/projects/${projectId}/wallet-intents`, { ...base, chainId: 420420777 })).status).toBe(409);
    const notOurs = await call(alice, 'POST', `/projects/${projectId}/wallet-intents`, { ...base, chainId: 31337, to: '0x000000000000000000000000000000000000dEaD' });
    expect(notOurs.status).toBe(403);
    const a = await call(alice, 'POST', `/projects/${projectId}/wallet-intents`, { ...base, chainId: 31337 });
    expect(a.status).toBe(201);
    const id = (await a.json()).id;
    expect((await call(alice, 'POST', `/projects/${projectId}/wallet-intents`, { ...base, chainId: 31337 })).status).toBe(409); // second tab
    expect((await call(alice, 'PATCH', `/wallet-intents/${id}`, { outcome: 'rejected', error: 'User rejected (4001)' })).status).toBe(200);
    expect((await call(alice, 'POST', `/projects/${projectId}/wallet-intents`, { ...base, chainId: 31337 })).status).toBe(201);
  });

  it('serves an OpenAPI document covering every mounted route', async () => {
    const spec = await (await app.request('/api/v1/openapi.json')).json();
    const routes = (app as any).routes.filter((r: any) => r.path.startsWith('/api/v1/') && r.method !== 'ALL').map((r: any) => r.path.replace(/:([a-z]+)/g, '{$1}'));
    const missing = [...new Set(routes)].filter((p) => !spec.paths[p as string] && p !== '/api/v1/openapi.json');
    expect(missing).toEqual([]);
  });
});
