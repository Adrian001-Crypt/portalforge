/**
 * Opens the public site the way a judge does: anonymous, no cookies, desktop and phone width.
 *   npx tsx scripts/check-static-demo.ts                                   # serves docs/ locally the way Pages does
 *   npx tsx scripts/check-static-demo.ts https://<user>.github.io/portalforge/
 * Writes docs/test-results/public-site-latest.json. Exit 1 if any check fails.
 */
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

// Extra terms to refuse (names, domains) come from the environment, so they never appear in this public file.
const PRIVATE = new RegExp(['/Users/', '/home/', '\\.dhcp\\.', ...(process.env.PF_PRIVATE_TERMS?.split(',') ?? [])].join('|'), 'i');
const results: { id: string; ok: boolean; detail: string }[] = [];
const rec = (id: string, ok: boolean, detail: string) => { results.push({ id, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${id.padEnd(34)} ${detail}`); };
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.pdf': 'application/pdf' };

const remote = process.argv[2];
let base = remote ? remote.replace(/\/?$/, '/') : '';
const server = remote ? null : createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
  if (!path.startsWith('/portalforge/')) { res.writeHead(404); return res.end(); }
  let f = normalize(join('docs', path.slice('/portalforge/'.length)));
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  const fallback = !existsSync(f);
  if (fallback) f = path.startsWith('/portalforge/demo/') ? 'docs/demo/404.html' : 'docs/index.html';
  res.writeHead(fallback ? 404 : 200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream', 'accept-ranges': 'bytes' });
  createReadStream(f).pipe(res);
});
if (server) { await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())); base = `http://127.0.0.1:${(server.address() as any).port}/portalforge/`; }

const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 800 }]] as const) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors: string[] = []; const posts: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.method() !== 'GET') posts.push(r.url()); });
  const wide = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await page.goto(base); await page.waitForLoadState('networkidle').catch(() => {});
  rec(`${label}.landing`, (await page.title()) === 'PortalForge' && await page.getByRole('heading', { name: 'PortalForge', level: 1 }).isVisible(), await page.title());
  rec(`${label}.landing_says_not_deployed`, /not deployed/i.test(await page.locator('body').innerText()), 'status is stated on the page');
  rec(`${label}.landing_no_overflow`, (await wide()) <= 1, `horizontal overflow ${await wide()} px`);
  if (label === 'desktop') {
    const v = await page.evaluate(async () => { const el = document.querySelector('video')!; el.muted = true; await el.play().catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); return { t: el.currentTime, d: el.duration, err: el.error?.message ?? null }; });
    rec('video.plays_without_login', v.t > 0 && v.d > 60 && v.d <= 180 && !v.err, `played to ${v.t.toFixed(1)} s of ${v.d.toFixed(0)} s`);
    const pdf = await page.request.get(new URL('pitch/portalforge-pitch.pdf', base).href);
    rec('deck.pdf_public', pdf.ok() && (await pdf.body()).subarray(0, 4).toString() === '%PDF', `HTTP ${pdf.status()}, ${(await pdf.body()).length} bytes`);
  }

  await page.goto(new URL('demo/', base).href); await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('note').first().waitFor({ timeout: 15_000 });
  rec(`${label}.demo_labelled_snapshot`, /Static snapshot captured .*not testnet/.test(await page.getByRole('note').first().innerText()), (await page.getByRole('note').first().innerText()).slice(0, 80));
  for (const [path, expect] of [['p/local-demo/executions', /succeeded/], ['p/local-demo/deployments', /verified|imported/], ['p/local-demo/evidence', /execution|registered|Evidence/], ['p/local-demo/events', /JobRequested/], ['network', /Portaldot V3/]] as const) {
    await page.goto(new URL(`demo/${path}`, base).href); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(600);
    const text = await page.locator('body').innerText();
    rec(`${label}.deep_link.${path.split('/').pop()}`, expect.test(text) && !/was not captured/.test(text.slice(0, 2500)), expect.source);
  }
  rec(`${label}.demo_no_overflow`, (await wide()) <= 1, `horizontal overflow ${await wide()} px`);
  const exec = await page.goto(new URL('demo/p/local-demo/executions', base).href).then(() => page.waitForTimeout(800)).then(() => page.locator('table.t tbody tr').first());
  await exec.click(); await page.waitForTimeout(800);
  rec(`${label}.execution_trace_opens`, /Square via demo service/.test(await page.locator('body').innerText()), page.url().split('/').pop()!.slice(0, 20));
  const text = await page.locator('body').innerText();
  rec(`${label}.no_private_data`, !PRIVATE.test(text), 'page text clean');
  rec(`${label}.no_page_errors`, errors.length === 0, errors[0]?.slice(0, 100) ?? 'none');
  rec(`${label}.nothing_sent`, posts.length === 0, `${posts.length} non-GET requests`);
  await ctx.close();
}
await browser.close();
server?.close();
const failed = results.filter((r) => !r.ok);
mkdirSync('docs/test-results', { recursive: true });
writeFileSync('docs/test-results/public-site-latest.json', JSON.stringify({ suite: 'public site', ranAt: new Date().toISOString(), target: remote ?? 'docs/ served locally the way Pages does', passed: results.length - failed.length, failed: failed.length, results }, null, 2) + '\n');
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
