/**
 * Rehearses the testnet flow on a throwaway local Anvil with the same `minimal` profile: one job, then counts who sent
 * what and how many new storage slots each transaction created. Local only; it is a rehearsal, not testnet evidence.
 *   npx tsx scripts/rehearse-minimal.ts
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pf-rehearse-'));
const RPC = 'http://127.0.0.1:8547', API = 'http://127.0.0.1:4300/api/v1';
const rpc = async (method: string, params: unknown[] = []) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stack = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev.ts'], { stdio: 'ignore', env: { ...process.env, PF_LOCAL_PROFILE: 'minimal', PF_DATA_DIR: dir, PF_NO_WEB: '1', PF_MONITOR: '0' } });
let ok = false;
try {
  for (let i = 0; ; i++) { if (await fetch(`${API}/health`).then((r) => r.ok, () => false)) break; if (i > 120) throw new Error('stack did not start'); await sleep(1000); }
  const contracts = (await (await fetch(`${API}/projects/local-demo/contracts`)).json()).items.map((c: any) => c.alias);
  const before = parseInt(await rpc('eth_blockNumber'), 16);
  console.log('contracts', contracts.join(', '));
  execSync('node --import tsx scripts/request-job.ts local-anvil 12 --confirm', { stdio: ['ignore', 'pipe', 'inherit'] });
  let x: any = null;
  for (let i = 0; i < 90 && x?.state !== 'succeeded'; i++) { await sleep(1000); x = (await (await fetch(`${API}/projects/local-demo/executions?limit=5`)).json()).items[0]; }
  console.log('execution', x?.state);
  const after = parseInt(await rpc('eth_blockNumber'), 16);
  const txs: any[] = [];
  for (let n = before + 1; n <= after; n++) txs.push(...(await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, true])).transactions);
  for (const t of txs) {
    const r = await rpc('eth_getTransactionReceipt', [t.hash]);
    const diff = await rpc('debug_traceTransaction', [t.hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
    let slots = 0; for (const [a, post] of Object.entries<any>(diff?.post ?? {})) for (const k of Object.keys(post.storage ?? {})) if (!diff.pre?.[a]?.storage?.[k]) slots++;
    console.log(`tx from ${t.from.slice(0, 8)} to ${t.to?.slice(0, 8)} gas ${parseInt(r.gasUsed, 16)} new slots ${slots} status ${r.status}`);
  }
  ok = x?.state === 'succeeded' && txs.length === 3;
} catch (e) { console.error((e as Error).message); }
stack.kill('SIGTERM'); await sleep(6000); rmSync(dir, { recursive: true, force: true });
console.log(ok ? 'REHEARSAL OK' : 'REHEARSAL FAILED'); process.exit(ok ? 0 : 1);
