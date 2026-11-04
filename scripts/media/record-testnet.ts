/**
 * Records the Portaldot V3 part of the demo against a running testnet stack (PF_MODE=testnet npm run dev).
 * The job scene sends one real requestJob, which costs about 11.6 tPOT in all. Requires --confirm.
 * Output: docs/media/raw-testnet/. Run scripts/media/build-final-video.py to join it with the local footage.
 * --retake t1 records only the deployment scene into docs/media/raw-testnet-t1/ and sends nothing.
 */
import { chromium, type Page } from '@playwright/test';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const RETAKE = process.argv.includes('--retake');
if (!RETAKE && !process.argv.includes('--confirm')) { console.error('this sends a real testnet transaction; pass --confirm'); process.exit(3); }
const INPUT = process.argv[process.argv.indexOf('--confirm') + 1] ?? '9';
const BASE = 'http://localhost:5180', API = 'http://127.0.0.1:4300/api/v1', P = '/p/portaldot-testnet-demo';
const OUT = RETAKE ? 'docs/media/raw-testnet-t1' : 'docs/media/raw-testnet', SHOTS = 'docs/media/screenshots';
rmSync(OUT, { recursive: true, force: true }); mkdirSync(`${OUT}/narration`, { recursive: true }); mkdirSync(`${OUT}/screencast`, { recursive: true });

const ALL_SCENES: { id: string; text: string }[] = [
  { id: 't1-deployed', text: 'This is the live Portaldot V3 testnet. The job registry and the evidence registry are deployed, and verified against the chain: chain id, genesis, code hash, owner and executor. The two deploys cost three hundred thirty-seven tPOT, almost all of it storage deposit.' },
  { id: 't2-job', text: 'Now a real job. A requestJob transaction goes to V3. The indexer records the event and its native Revive twin, and the workflow waits for finality. It calls the service, sends completeJob from a low-privilege executor, and registers evidence. Every step keeps its real transaction hash and block.' },
  { id: 't3-evidence', text: 'The console recomputes the evidence hash and compares it with the registry on V3. The pf command line runs the same check on its own, without trusting this server.' },
  { id: 't4-close', text: 'The deployment, the job and the evidence you just saw are on the V3 testnet. The fault recovery was shown on a local chain, to save testnet tokens. PortalForge is open source, built for the Modular Cloud and Middleware track.' },
];
const SCENES = RETAKE ? ALL_SCENES.slice(0, 1) : ALL_SCENES;
const wavSeconds = (f: string) => Number(execSync(`afinfo "${f}" | awk '/estimated duration/ {print $3}'`).toString().trim());
const durations: Record<string, number> = {};
for (const s of SCENES) { const f = `${OUT}/narration/${s.id}.wav`; execFileSync('say', ['-v', 'Samantha', '-r', '172', '--file-format=WAVE', '--data-format=LEI16@22050', '-o', f, s.text]); durations[s.id] = wavSeconds(f); }

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--window-size=1280,807'] });
const ctx = await browser.newContext({ viewport: null });
const page = await ctx.newPage();
const shots: { t: number; file: string }[] = [];
const cdp = await ctx.newCDPSession(page);
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }: any) => {
  const file = `${OUT}/screencast/${String(shots.length).padStart(6, '0')}.jpg`;
  writeFileSync(file, Buffer.from(data, 'base64')); shots.push({ t: metadata.timestamp * 1000, file });
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
const t0 = Date.now();
const timeline: { id: string; start: number; duration: number }[] = [];
const caption = (p: Page, text: string) => p.evaluate((t) => {
  let el = document.getElementById('pf-caption');
  if (!el) { el = document.createElement('div'); el.id = 'pf-caption'; el.setAttribute('style', 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:1100px;background:rgba(15,23,41,.9);color:#fff;padding:8px 14px;border-radius:8px;font:500 17px system-ui;z-index:9999;text-align:center'); document.body.appendChild(el); }
  el.textContent = t;
}, text);
async function scene(id: string, fn: () => Promise<void>) {
  const start = (Date.now() - t0) / 1000; const s = SCENES.find((x) => x.id === id)!;
  const sentences = s.text.split(/(?<=[.:;])\s/); const weights = sentences.map((x) => x.length); const total = weights.reduce((a, b) => a + b, 0);
  const began = Date.now(), ms = durations[id] * 1000;
  const current = () => { const el = Date.now() - began; let acc = 0; for (let i = 0; i < sentences.length; i++) { acc += (weights[i] / total) * ms; if (el < acc) return sentences[i]; } return sentences.at(-1)!; };
  const ticker = setInterval(() => { caption(page, current()).catch(() => {}); }, 400);
  await fn();
  while (Date.now() < began + ms + 700) await page.waitForTimeout(200);
  clearInterval(ticker);
  timeline.push({ id, start, duration: durations[id] });
}
const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const go = async (path: string) => { await page.goto(`${BASE}${path}`); await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(900); };
const get = async (p: string) => (await fetch(`${API}${p}`)).json();
const terminal = (cmd: string, out: string) => page.setContent(`<!doctype html><body style="margin:0;background:#0b1220;color:#d7e0ee;font:15px/1.5 ui-monospace,Menlo,monospace;padding:28px;white-space:pre-wrap;overflow:hidden"><div style="color:#7db3ff">$ ${cmd}</div>${out.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</body>`);

await go(`${P}/deployments`);
let executionId = '', evidenceDbId = '', jobLog = '';
await scene('t1-deployed', async () => {
  await page.waitForTimeout(1500); await shot('17-v3-deployments');
  await page.locator('table.t a').first().click(); await page.waitForTimeout(4000); await shot('18-v3-deployment-verified');
});
if (!RETAKE) await scene('t2-job', async () => {
  const before = new Set((await get(`${P.replace('/p', '/projects')}/executions?limit=50`)).items.map((x: any) => x.id));
  const job = spawn(process.execPath, ['--import', 'tsx', 'scripts/request-job.ts', 'portaldot-v3-testnet', INPUT, '--confirm'], { env: process.env });
  job.stdout.on('data', (b) => { jobLog += b; }); job.stderr.on('data', (b) => { jobLog += b; });
  await new Promise((r) => job.once('exit', r));
  writeFileSync(`${OUT}/request-job.log`, jobLog);
  await go(`${P}/events`); await page.waitForTimeout(2500);
  const deadline = Date.now() + 200_000;
  while (Date.now() < deadline && !executionId) { const x = (await get(`${P.replace('/p', '/projects')}/executions?limit=50`)).items.find((i: any) => !before.has(i.id)); if (x) executionId = x.id; else await page.waitForTimeout(1500); }
  if (!executionId) throw new Error('no execution appeared');
  await shot('19-v3-event-explorer');
  await go(`${P}/executions/${executionId}`);
  while (Date.now() < deadline && (await get(`/executions/${executionId}`)).state !== 'succeeded') await page.waitForTimeout(1500);
  await go(`${P}/executions/${executionId}`); await page.waitForTimeout(800);
  await page.locator('details.step', { hasText: 'completeJob' }).locator('summary').click().catch(() => {}); await page.waitForTimeout(1500); await shot('20-v3-execution-trace');
});
if (!RETAKE) await scene('t3-evidence', async () => {
  const d = await get(`/executions/${executionId}`); evidenceDbId = d.evidence[0].id;
  await go(`${P}/evidence/${evidenceDbId}`); await page.getByRole('button', { name: 'Verify against chain' }).click(); await page.waitForTimeout(3500); await shot('21-v3-evidence-verified');
  const out = execFileSync('npm', ['run', '-s', 'pf', '--', 'evidence', 'verify', evidenceDbId, '--api', 'http://127.0.0.1:4300'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  writeFileSync(`${OUT}/evidence-verify.log`, out);
  await terminal(`pf evidence verify ${evidenceDbId} --api http://127.0.0.1:4300`, out.replace(/(\S{70})\S+/g, '$1…')); await page.waitForTimeout(800); await shot('22-v3-cli-verify');
});
if (!RETAKE) await scene('t4-close', async () => {
  await page.setContent(`<!doctype html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#0f1729;color:#f5f6f8;font:600 44px system-ui"><div>PortalForge</div><div style="font:400 26px system-ui;color:#7db3ff">github.com/Adrian001-Crypt/portalforge</div><div style="font:400 18px system-ui;color:#c9d3e3">Deployed on Portaldot V3 testnet. Fault recovery footage: local Anvil.</div></body>`);
});
await cdp.send('Page.stopScreencast').catch(() => {});
const tEnd = Date.now();
await ctx.close(); await browser.close();
const FPS = 15, from = t0 + Math.max(0, timeline[0].start - 0.4) * 1000;
mkdirSync(`${OUT}/frames`, { recursive: true });
let j = 0, n = 0;
for (let t = from; t <= tEnd; t += 1000 / FPS) { while (j + 1 < shots.length && shots[j + 1].t <= t) j++; linkSync(shots[j].file, `${OUT}/frames/${String(n++).padStart(5, '0')}.jpg`); }
writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ recordedAt: new Date().toISOString(), totalSeconds: (tEnd - t0) / 1000, trimStart: Math.max(0, timeline[0].start - 0.4), fps: FPS, scenes: timeline, executionId, evidenceDbId, frames: n }, null, 2));
console.log(JSON.stringify({ executionId, evidenceDbId, seconds: (tEnd - t0) / 1000, frames: n }));
console.log(jobLog);
process.exit(0);
