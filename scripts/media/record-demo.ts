/**
 * Records the local product walkthrough (real UI, real local chain, real fault) with Playwright + system Chrome,
 * captures screenshots, and synthesises narration per scene with macOS `say`.
 * Starts the local stack if it is not already running. Output: docs/media/raw/ (video.webm, narration/*.wav, timeline.json),
 * docs/media/screenshots/*.png. Then run scripts/media/build-video.sh to produce the MP4.
 * Footage is from Local Anvil and says so on screen; it is not testnet footage.
 */
import { chromium, type Page } from '@playwright/test';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, linkSync } from 'node:fs';

const BASE = 'http://localhost:5180';
const RPC = 'http://127.0.0.1:8547';
const OUT = 'docs/media/raw', SHOTS = 'docs/media/screenshots';
const up = () => fetch(BASE).then((r) => r.ok, () => false);
const stack = (await up()) ? null : spawn(process.execPath, ['--import', 'tsx', 'scripts/dev.ts'], { stdio: 'ignore', env: process.env });
for (let i = 0; !(await up()); i++) { if (i > 180) throw new Error('local stack did not start'); await new Promise((r) => setTimeout(r, 1000)); }
rmSync(OUT, { recursive: true, force: true }); mkdirSync(`${OUT}/narration`, { recursive: true }); mkdirSync(SHOTS, { recursive: true });

export const SCENES: { id: string; text: string }[] = [
  { id: '01-overview', text: 'Building on Portaldot V3 means Solidity contracts running inside a Substrate runtime. Every event has two views, storage costs real deposits, and automation breaks when a response is lost. PortalForge is open-source middleware that deploys, indexes, automates, recovers and verifies.' },
  { id: '02-network', text: 'PortalForge measures the network instead of assuming. The capability probe, recorded on the live V3 testnet, confirms the chain identity, fourteen-decimal tPOT, Cancun opcodes and the account mapping, and shows that each EVM block hash equals the runtime’s own eth block hash. That is the rule we use to link EVM logs with native events.' },
  { id: '03-deploy', text: 'Deployments are planned before anything is signed. Each create is simulated and its runtime code must equal the compiled artifact. On V3 the planner also asks the runtime for the exact storage deposit: one hundred sixty-one tPOT for the job registry. Then the wallet signs, and the record is verified against the chain. This footage runs on a local Anvil chain, and it is labelled that way.' },
  { id: '04-request', text: 'A user requests a job from their wallet. PortalForge saves the signing intent before the wallet opens, and the indexer picks up the JobRequested event with its finality.' },
  { id: '05-workflow', text: 'The job-square workflow is a versioned graph: a guard, an idempotent HTTP call, schema validation, an allow-listed completeJob transaction, and evidence registration. Each execution keeps every attempt and side-effect intent.' },
  { id: '06-fault', text: 'Now we break it. The demo service processes the next job but drops the response. PortalForge marks the outcome unknown, queries the service by execution id, and reuses the stored result. The service computed it once, and the contract completed the job once.' },
  { id: '07-evidence', text: 'Evidence is a canonical hash registered on chain. The console recomputes it locally and compares it with the on-chain commitment and writer. The same check runs from the pf command line, independent of this server.' },
  { id: '08-close', text: 'Failures open incidents with facts and suggested steps, and webhook notifications retry until they are delivered. Testnet deployment is prepared and budgeted, and waits for testnet tokens; until then every testnet page says not deployed. PortalForge is open source, built for the Modular Cloud and Middleware track.' },
];

const wavSeconds = (f: string) => Number(execSync(`afinfo "${f}" | awk '/estimated duration/ {print $3}'`).toString().trim());
const durations: Record<string, number> = {};
for (const s of SCENES) {
  const f = `${OUT}/narration/${s.id}.wav`;
  execFileSync('say', ['-v', 'Samantha', '-r', '172', '--file-format=WAVE', '--data-format=LEI16@22050', '-o', f, s.text]);
  durations[s.id] = wavSeconds(f);
}
const total = Object.values(durations).reduce((a, b) => a + b, 0);
console.log(`narration total ${total.toFixed(1)}s`);
if (total > 170) throw new Error('narration too long for a 3-minute video');

// Headless Chrome's screencast covers the window, not the viewport: size the window so frames are 1280×720.
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--window-size=1280,807'] });
const ctx = await browser.newContext({ viewport: null });
// Injected as a plain string: functions compiled by tsx carry an esbuild __name helper that does not exist in the page.
await ctx.addInitScript({ content: `(() => {
  const rpc = ${JSON.stringify(RPC)};
  const call = async (method, params = []) => { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  window.ethereum = { request: async ({ method, params }) => (method === 'eth_requestAccounts' || method === 'eth_accounts' ? ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'] : call(method, params)), on() {}, removeListener() {} };
})();` });
const page = await ctx.newPage();
// Frames come from Chrome's DevTools screencast (timestamped JPEGs); no ffmpeg needed.
mkdirSync(`${OUT}/screencast`, { recursive: true });
const shots: { t: number; file: string }[] = [];
const cdp = await ctx.newCDPSession(page);
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }: any) => {
  const file = `${OUT}/screencast/${String(shots.length).padStart(6, '0')}.jpg`;
  writeFileSync(file, Buffer.from(data, 'base64'));
  shots.push({ t: metadata.timestamp * 1000, file });
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
const t0 = Date.now();
const timeline: { id: string; start: number; duration: number }[] = [];

async function caption(p: Page, text: string) {
  await p.evaluate((t) => {
    let el = document.getElementById('pf-caption');
    if (!el) { el = document.createElement('div'); el.id = 'pf-caption'; el.setAttribute('style', 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:1100px;background:rgba(15,23,41,.88);color:#F5F6F8;font:500 17px/1.4 -apple-system,Inter,sans-serif;padding:8px 14px;border-radius:8px;z-index:9999;text-align:center;pointer-events:none'); document.body.appendChild(el); }
    el.textContent = t;
  }, text);
}
async function scene(id: string, fn: () => Promise<void>) {
  const start = (Date.now() - t0) / 1000;
  const s = SCENES.find((x) => x.id === id)!;
  const sentences = s.text.split(/(?<=[.:;])\s/);
  const weights = sentences.map((x) => x.length);
  const total = weights.reduce((a, b) => a + b, 0);
  const began = Date.now(), ms = durations[id] * 1000;
  // Re-applied every 400 ms so the caption survives page loads; the sentence follows the narration.
  const current = () => { const el = Date.now() - began; let acc = 0; for (let i = 0; i < sentences.length; i++) { acc += (weights[i] / total) * ms; if (el < acc) return sentences[i]; } return sentences.at(-1)!; };
  const ticker = setInterval(() => { caption(page, current()).catch(() => {}); }, 400);
  await caption(page, current()).catch(() => {});
  try { await fn(); } finally { /* keep captions until the narration ends */ }
  while (Date.now() < began + ms + 700) await page.waitForTimeout(200);
  clearInterval(ticker);
  timeline.push({ id, start, duration: durations[id] });
}
/** The execution triggered by the most recent wallet transaction (public read endpoints only). */
async function executionOfLatestIntent(): Promise<string> {
  const A = 'http://127.0.0.1:4300/api/v1';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const w = (await (await fetch(`${A}/projects/local-demo/wallet-intents`)).json()).items.find((i: any) => i.tx_hash);
    const ev = w ? (await (await fetch(`${A}/projects/local-demo/events?q=${w.tx_hash}`)).json()).items[0] : null;
    const x = ev ? (await (await fetch(`${A}/projects/local-demo/executions?q=${encodeURIComponent(ev.id)}`)).json()).items.find((i: any) => i.trigger_key === ev.id) : null;
    if (x && x.state === 'succeeded') return x.id;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('execution for the latest wallet transaction did not succeed in time');
}
const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const go = async (path: string) => { await page.goto(`${BASE}${path}`); await page.waitForLoadState('networkidle').catch(() => {}); };

// sign in (not narrated; happens before the first scene starts its caption)
await go('/');
await page.getByLabel('Handle').fill('demo-owner');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('banner').getByText('Signed in as').waitFor();

await scene('01-overview', async () => { await page.waitForTimeout(800); await shot('01-overview'); });
await scene('02-network', async () => { await go('/network'); await page.locator('select[aria-label="Network"]').selectOption('portaldot-v3-testnet').catch(() => {}); await page.waitForTimeout(2500); await shot('02-network-health-v3'); await page.mouse.wheel(0, 900); await page.waitForTimeout(2500); await shot('03-capability-probe-v3'); });
await scene('03-deploy', async () => {
  await go('/p/local-demo/deployments'); await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Use wallet' }).click();
  await page.getByLabel(/PortalForge executor/).fill('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  await page.getByRole('button', { name: /^Plan/ }).click();
  await page.getByText('Your balance').waitFor({ timeout: 30_000 }); await page.waitForTimeout(3500); await shot('04-deployment-workbench');
  await page.getByRole('button', { name: 'Sign & deploy with wallet' }).click();
  await page.getByText(/Manifest verified/).waitFor({ timeout: 60_000 }); await page.waitForTimeout(2500);
  await page.locator('table.t a').first().click(); await page.waitForTimeout(3000); await shot('05-deployment-verification');
});
await scene('04-request', async () => {
  await go('/p/local-demo/contracts'); await page.getByRole('cell', { name: /^jobs(?!-)/ }).first().click();
  const form = page.locator('form', { hasText: 'requestJob' });
  await form.getByLabel('input').fill('12'); await shot('06-contract-workspace');
  await form.getByRole('button', { name: 'Sign & send' }).click();
  await form.getByText('confirmed').waitFor({ timeout: 60_000 });
  await go('/p/local-demo/events'); await page.waitForTimeout(2500); await shot('07-event-explorer');
});
await scene('05-workflow', async () => {
  await go('/p/local-demo/workflows'); await page.getByText('job-square', { exact: true }).first().click(); await page.waitForTimeout(2000); await shot('08-workflow-builder');
  await go('/p/local-demo/executions'); await page.waitForTimeout(3000); await page.locator('table.t tbody tr').first().click(); await page.waitForTimeout(2500); await shot('09-execution-trace');
});
await scene('06-fault', async () => {
  await fetch('http://127.0.0.1:4310/admin/faults', { method: 'POST', headers: { 'x-admin-token': 'local-demo-admin-token' }, body: JSON.stringify({ dropNextResponse: 1 }) });
  await go('/p/local-demo/contracts'); await page.getByRole('cell', { name: /^jobs(?!-)/ }).first().click();
  const form = page.locator('form', { hasText: 'requestJob' });
  await form.getByLabel('input').fill('9'); await form.getByRole('button', { name: 'Sign & send' }).click();
  await form.getByText('confirmed').waitFor({ timeout: 60_000 });
  const id = await executionOfLatestIntent();
  await go(`/p/local-demo/executions/${id}`);
  await page.getByText('succeeded').first().waitFor({ timeout: 60_000 }); await page.waitForTimeout(1000);
  await page.locator('details.step', { hasText: 'Square via demo service' }).locator('summary').click(); await page.waitForTimeout(1500); await shot('10-fault-reconciled');
});
await scene('07-evidence', async () => {
  await go('/p/local-demo/evidence'); await page.locator('table.t tbody tr').first().click(); await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Verify against chain' }).click(); await page.waitForTimeout(2500); await shot('11-evidence-verified');
});
await scene('08-close', async () => {
  await go('/p/local-demo/incidents'); await page.waitForTimeout(1500); await shot('12-incidents');
  await go('/developers'); await page.waitForTimeout(1500);
  // Closing card: the repository link stays readable for the last seconds.
  const card = () => page.evaluate(() => { if (document.getElementById('pf-end')) return; const el = document.createElement('div'); el.id = 'pf-end'; el.setAttribute('style', 'position:fixed;inset:0;z-index:9998;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0f1729;color:#f5f6f8;font:600 44px system-ui'); el.innerHTML = '<div>PortalForge</div><div style="font:400 26px system-ui;color:#7db3ff">github.com/Adrian001-Crypt/portalforge</div><div style="font:400 18px system-ui;color:#c9d3e3">Footage: local Anvil. Portaldot V3 testnet deployment pending.</div>'; document.body.appendChild(el); });
  await page.waitForTimeout(Math.max(0, durations['08-close'] * 1000 - 8000)); await card();
});

await cdp.send('Page.stopScreencast').catch(() => {});
const tEnd = Date.now();
await ctx.close(); await browser.close();
stack?.kill('SIGTERM');
// Resample to a constant 15 fps from the first scene onwards (hold the last frame between changes).
const FPS = 15, from = t0 + Math.max(0, timeline[0].start - 0.4) * 1000;
mkdirSync(`${OUT}/frames`, { recursive: true });
let j = 0, n = 0;
for (let t = from; t <= tEnd; t += 1000 / FPS) {
  while (j + 1 < shots.length && shots[j + 1].t <= t) j++;
  linkSync(shots[j].file, `${OUT}/frames/${String(n++).padStart(5, '0')}.jpg`);
}
console.log(`${shots.length} screencast frames → ${n} frames @ ${FPS} fps`);
writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ recordedAt: new Date().toISOString(), totalSeconds: (tEnd - t0) / 1000, trimStart: Math.max(0, timeline[0].start - 0.4), fps: 15, scenes: timeline, source: 'local Anvil + real PortalForge services; testnet probe page shows stored live V3 probe' }, null, 2));
console.log(`video ${(Date.now() - t0) / 1000}s · ${timeline.length} scenes · screenshots in ${SHOTS}`);
process.exit(0);
