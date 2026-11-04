/**
 * Builds the static read-only demo in docs/demo for GitHub Pages: starts the public read-only stack, visits every
 * console page as an anonymous visitor, stores the API responses, and builds the console to answer from them.
 *   npx tsx scripts/media/capture-snapshot.ts
 * Data comes from real local jobs on Anvil and is labelled that way. Nothing here touches a public network except the
 * read-only V3 samples the public stack already shows.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { waitFor, httpOk } from '../lib/proc';

const BASE = 'http://127.0.0.1:4400', OUT = 'docs/demo';
// Extra terms to refuse (names, domains) come from the environment, so they never appear in this public file.
const FORBIDDEN = new RegExp(['/Users/', '/home/', '\\.dhcp\\.', 'local-demo-admin-token', '\\.secrets', ...(process.env.PF_PRIVATE_TERMS?.split(',') ?? [])].join('|'), 'i');

const stack = spawn(process.execPath, ['--import', 'tsx', 'scripts/public-demo.ts'], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
const stopped = new Promise((r) => stack.once('exit', r));
const seeded = new Promise<void>((res) => stack.stdout!.on('data', (b) => { process.stdout.write(b); if (/public read-only console/.test(String(b))) res(); }));
try {
  await Promise.race([seeded, new Promise((_, no) => setTimeout(() => no(new Error('public stack did not start')), 240_000))]);
  await waitFor('api', () => httpOk(`${BASE}/api/v1/health`), 30_000);
  const check = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-public.ts', BASE], { stdio: 'inherit' });
  if (check.status !== 0) throw new Error('public visitor checks failed; not building a snapshot');
  // Let the monitor collect real samples so Network Health has something to show.
  await new Promise((r) => setTimeout(r, 70_000));

  const responses: Record<string, unknown> = {};
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const writes: string[] = [];
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (u.origin !== BASE || !u.pathname.startsWith('/api/v1')) return;
    if (r.request().method() !== 'GET') { writes.push(u.pathname); return; }
    if (r.ok()) responses[u.pathname.slice('/api/v1'.length) + u.search] = await r.json().catch(() => null);
  });
  const api = async (p: string) => (await (await fetch(`${BASE}/api/v1${p}`)).json()).items as any[];
  const P = '/p/local-demo';
  const queue = ['/', '/projects', '/network', '/integrations', '/developers', P];
  for (const s of ['deployments', 'contracts', 'events', 'workflows', 'executions', 'incidents', 'evidence', 'settings']) queue.push(`${P}/${s}`);
  for (const [list, route] of [['executions', 'executions'], ['workflows', 'workflows'], ['deployments', 'deployments'], ['incidents', 'incidents'], ['evidence', 'evidence'], ['contracts', 'contracts']]) {
    for (const x of (await api(`/projects/local-demo/${list}`).catch(() => [])).slice(0, 12)) queue.push(`${P}/${route}/${x.id ?? x.alias}`);
  }
  const seen = new Set<string>();
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(700);
    for (const a of await page.locator('a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')!))) if (!seen.has(a) && seen.size + queue.length < 200) queue.push(a);
    // Tabs and project switchers load data on click.
    for (const tab of await page.locator('.tabs button, [role="tab"]').all()) { await tab.click().catch(() => {}); await page.waitForTimeout(350); }
    for (const sel of ['select[aria-label="Network"]']) for (const value of await page.locator(`${sel} option`).evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value)).catch(() => [])) { await page.locator(sel).selectOption(value).catch(() => {}); await page.waitForTimeout(800); }
    for (const row of (await page.locator('table.t tbody tr').all()).slice(0, 2)) { if (path.split('/').length > 3 && !/\/(contracts|evidence|events|workflows)$/.test(path)) break; await row.click({ timeout: 1000 }).catch(() => {}); await page.waitForTimeout(400); if (page.url() !== `${BASE}${path}`) { await page.goBack(); await page.waitForTimeout(300); } }
  }
  await browser.close();
  if (writes.length) console.log(`note: the crawl triggered ${writes.length} anonymous POST(s), none stored`);

  const bundle = JSON.stringify({ capturedAt: new Date().toISOString(), source: 'public read-only stack on local Anvil; V3 samples read live', responses });
  const leak = FORBIDDEN.exec(bundle);
  if (leak) throw new Error(`snapshot contains a forbidden string: ${leak[0]}`);
  rmSync(OUT, { recursive: true, force: true });
  const b = spawnSync('npx', ['vite', 'build', '--base=/portalforge/demo/', `--outDir=../../${OUT}`, '--emptyOutDir'], { cwd: 'apps/web', env: { ...process.env, VITE_SNAPSHOT: '1' }, stdio: 'inherit' });
  if (b.status !== 0) throw new Error('vite build failed');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/snapshot.json`, bundle);
  // Pages serves only the site root's 404.html, so deep demo links boot the console from there; anything else goes home.
  const html = readFileSync(`${OUT}/index.html`, 'utf8');
  writeFileSync('docs/404.html', html.replace('<head>', `<head>\n    <script>if (!location.pathname.startsWith('/portalforge/demo/')) location.replace('/portalforge/');</script>`));
  console.log(`snapshot: ${Object.keys(responses).length} responses, ${seen.size} pages, ${(bundle.length / 1024).toFixed(0)} KB`);
} finally {
  stack.kill('SIGTERM');
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 15_000))]);
}
process.exit(0);
