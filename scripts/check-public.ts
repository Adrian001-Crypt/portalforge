/**
 * Probe a running public read-only deployment as an anonymous visitor.
 *   npx tsx scripts/check-public.ts http://127.0.0.1:4400      (or the https tunnel/host URL)
 * Writes docs/test-results/public-check-latest.json. Exit 1 if any check fails.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://127.0.0.1:4400').replace(/\/$/, '');
const results: { id: string; ok: boolean; detail: string }[] = [];
const rec = (id: string, ok: boolean, detail: string) => { results.push({ id, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${id.padEnd(34)} ${detail}`); };
const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: unknown = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });

const health = await (await get('/api/v1/health')).json();
rec('health.ok', health.ok === true, `mode ${health.mode}, networks ${health.networks}`);
rec('health.dev_login_off', health.devLogin === false, `devLogin=${health.devLogin}`);
rec('health.no_host_names', health.services.every((s: any) => /^[a-z]+#\d+$/.test(s.instance)), health.services.map((s: any) => s.instance).join(', ') || 'no services');
rec('auth.dev_login_refused', (await post('/api/v1/auth/dev-login', { handle: 'judge' })).status === 501, 'POST /auth/dev-login → 501');
const projects = (await (await get('/api/v1/projects')).json()).items;
rec('projects.public_only', projects.length > 0 && projects.every((p: any) => p.role === 'public' && p.visibility === 'public_readonly'), `${projects.length} visible, roles ${[...new Set(projects.map((p: any) => p.role))]}`);
for (const p of projects) {
  rec(`project.${p.slug}.connectors_hidden`, (await get(`/api/v1/projects/${p.id}/connectors`)).status === 403, 'connector targets 403');
  rec(`project.${p.slug}.channels_hidden`, (await get(`/api/v1/projects/${p.id}/channels`)).status === 403, 'channels 403');
  rec(`project.${p.slug}.audit_hidden`, [401, 403].includes((await get(`/api/v1/projects/${p.id}/audit`)).status), 'audit log not public');
  rec(`project.${p.slug}.keys_hidden`, [401, 403].includes((await get(`/api/v1/projects/${p.id}/api-keys`)).status), 'API keys not public');
  const writes = [
    ['POST', `/api/v1/projects/${p.id}/connectors`, { name: 'x', url: 'https://example.com' }], ['POST', `/api/v1/projects/${p.id}/policies`, {}],
    ['POST', `/api/v1/projects/${p.id}/workflows`, { name: 'x', definition: {} }], ['POST', `/api/v1/projects/${p.id}/wallet-intents`, {}],
    ['POST', `/api/v1/projects/${p.id}/api-keys`, { name: 'x', scopes: ['read'] }], ['PATCH', `/api/v1/projects/${p.id}`, { name: 'x' }],
  ] as const;
  const statuses = await Promise.all(writes.map(([m, u, b]) => fetch(`${base}${u}`, { method: m, headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(b) }).then((r) => r.status)));
  rec(`project.${p.slug}.writes_refused`, statuses.every((s) => s === 401 || s === 403), `statuses ${statuses.join(',')}`);
  const ex = (await (await get(`/api/v1/projects/${p.id}/executions?limit=1`)).json()).items[0];
  if (ex) {
    const st = await Promise.all([post(`/api/v1/executions/${ex.id}/replay`, { mode: 'full' }), post(`/api/v1/executions/${ex.id}/cancel`)].map((r) => r.then((x) => x.status)));
    rec(`project.${p.slug}.execution_control_refused`, st.every((s) => s === 401 || s === 403 || s === 409), `replay/cancel → ${st.join(',')}`);
    const detail = await (await get(`/api/v1/executions/${ex.id}`)).text();
    rec(`project.${p.slug}.no_signed_tx_in_trace`, !/raw_tx|"raw":"0x02|0xf8[0-9a-f]{100}/.test(detail), 'execution trace has no raw signed transactions');
  }
}
rec('network.probe_refused', (await post('/api/v1/networks/local-anvil/probe')).status === 401 || (await post('/api/v1/networks/portaldot-v3-testnet/probe')).status === 401, 'anonymous probe → 401');
rec('wallet.refresh_refused', (await post('/api/v1/wallet-intents/x/refresh')).status === 401, 'anonymous reconcile → 401');
const page = await get('/p/local-demo/executions');
const html = await page.text();
rec('spa.route', page.status === 200 && html.includes('<div id="root">'), 'deep link serves the SPA');
const csp = page.headers.get('content-security-policy') ?? '';
rec('headers.csp', /frame-ancestors 'none'/.test(csp) && /script-src 'self'/.test(csp), csp.slice(0, 90));
const js = [...html.matchAll(/src="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
let bundle = '';
for (const s of js) bundle += await (await get(s)).text();
const secrets = existsSync('.secrets') ? readdirSync('.secrets').map((f) => JSON.parse(readFileSync(`.secrets/${f}`, 'utf8')).privateKey?.slice(2, 18)).filter(Boolean) : [];
rec('bundle.no_secrets', bundle.length > 0 && !/PF_EXECUTOR|DEMO_ADMIN|privateKey|PRIVATE KEY/.test(bundle) && secrets.every((k) => !bundle.includes(k)), `${js.length} bundle(s), ${(bundle.length / 1024).toFixed(0)} KB scanned`);
mkdirSync('docs/test-results', { recursive: true });
writeFileSync('docs/test-results/public-check-latest.json', JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2) + '\n');
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
