/**
 * Local end-to-end run with real processes and real fault injection (Anvil — plain EVM, not pallet-revive).
 *   deploy JobRegistry + EvidenceRegistry → request jobs → indexer → workflow → demo service → completeJob → evidence
 * Faults: response lost after remote success · worker SIGKILL mid-request · RPC outage (TCP proxy) · replay attempt.
 * Writes docs/test-results/e2e-local-latest.json. Exit 1 on any failed assertion.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseAbiItem, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { JobRegistryAbi } from '@portalforge/domain';
import { startService, tsx, waitFor, rpcUp, httpOk, FaultProxy, type Svc } from './lib/proc';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const run = `data/e2e-${stamp}`;
const logs = `${run}/logs`;
const ANVIL = 18547, PROXY = 18548, API = 14300, DEMO = 14310;
const anvilUrl = `http://127.0.0.1:${ANVIL}`, proxyUrl = `http://127.0.0.1:${PROXY}`, apiUrl = `http://127.0.0.1:${API}`, demoUrl = `http://127.0.0.1:${DEMO}`;
const ADMIN = 'e2e-admin-token-0123456789abcdef';
const svcs: Record<string, Svc> = {};
const results: { id: string; title: string; ok: boolean; detail: string; ms: number }[] = [];
const log = (m: string) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${m}`);

const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [anvilUrl] } } });
const pub = createPublicClient({ chain, transport: http(anvilUrl) });
const user = createWalletClient({ account: mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 2 }), chain, transport: http(anvilUrl) });

const env: Record<string, string> = {
  PF_MODE: 'local', PF_NETWORKS: 'local-anvil', PF_DB: `${run}/portalforge.db`, PF_EVM_RPC_LOCAL_ANVIL: proxyUrl, PF_DEPLOYMENTS_DIR: `${run}/deployments`,
  PF_SEED_DEMO: '1', PF_DEV_LOGIN: '1', PF_PUBLIC_READONLY: '1', PF_API_PORT: String(API), PF_PUBLIC_ORIGIN: apiUrl, PF_ALLOW_PRIVATE_CONNECTORS: '1',
  PF_DEMO_SERVICE_URL: demoUrl, PF_LEASE_MS: '4000', PF_INDEX_INTERVAL_MS: '1000', PF_MONITOR_INTERVAL_MS: '2000', PF_WEB_DIST: 'apps/web/dist',
};

let cookie = '', csrf = '', projectId = '', jobs: Hex = '0x';
const apiGet = async (path: string, key?: string) => { const r = await fetch(`${apiUrl}/api/v1${path}`, { headers: key ? { authorization: `Bearer ${key}` } : { cookie } }); if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`); return r.json() as Promise<any>; };
const apiPost = async (path: string, body: unknown) => { const r = await fetch(`${apiUrl}/api/v1${path}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, origin: apiUrl, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j)}`); return j as any; };
const fault = (f: Record<string, number>) => fetch(`${demoUrl}/admin/faults`, { method: 'POST', headers: { 'x-admin-token': ADMIN }, body: JSON.stringify(f) });
const demoStats = async () => (await (await fetch(`${demoUrl}/admin/stats`)).json()) as any;

async function step(id: string, title: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  log(`▶ ${id} ${title}`);
  try { const detail = await fn(); results.push({ id, title, ok: true, detail, ms: Date.now() - t0 }); log(`✔ ${id} ${detail}`); }
  catch (e) { results.push({ id, title, ok: false, detail: (e as Error).message, ms: Date.now() - t0 }); log(`✖ ${id} ${(e as Error).message}`); }
}
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

async function requestJob(input: bigint) {
  const hash = await user.writeContract({ address: jobs, abi: JobRegistryAbi, functionName: 'requestJob', args: [input] });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { txHash: hash.toLowerCase(), jobId: BigInt(r.logs[0].topics[1]!) };
}
async function executionFor(txHash: string, timeoutMs = 60_000) {
  let x: any = null;
  await waitFor(`execution for ${txHash}`, async () => {
    const ev = await apiGet(`/projects/${projectId}/events?q=${txHash}`);
    if (!ev.items.length) return false;
    const list = await apiGet(`/projects/${projectId}/executions?q=${encodeURIComponent(ev.items[0].id)}`);
    x = list.items.find((i: any) => i.trigger_key === ev.items[0].id && !i.replay_of) ?? null;
    return !!x;
  }, timeoutMs, 500);
  return x.id as string;
}
async function finished(id: string, timeoutMs = 90_000) {
  let x: any;
  await waitFor(`execution ${id.slice(0, 10)} to finish`, async () => { x = await apiGet(`/executions/${id}`); return ['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(x.state); }, timeoutMs, 500);
  return x;
}
const readJob = (jobId: bigint) => pub.readContract({ address: jobs, abi: JobRegistryAbi, functionName: 'getJob', args: [jobId] });
const startWorker = (name = 'worker') => { const t = tsx('services/worker/src/main.ts'); svcs[name] = startService(name, t.cmd, t.args, { ...env, PF_WORKER_ID: `${name}-${Date.now()}` }, logs); };

async function main() {
  mkdirSync(logs, { recursive: true });
  if (!existsSync('apps/web/dist/index.html')) execSync('npm run -s web:build', { stdio: 'inherit' });
  svcs.anvil = startService('anvil', `${process.env.HOME}/.local/toolchains/foundry/anvil`, ['--port', String(ANVIL), '--block-time', '1', '--silent'], {}, logs);
  await waitFor('anvil', () => rpcUp(anvilUrl), 20_000);
  const proxy = new FaultProxy(PROXY, ANVIL); await proxy.start();
  execSync('node --import tsx scripts/deploy.ts apply local-anvil --profile full --confirm', { env: { ...process.env, PF_EVM_RPC_LOCAL_ANVIL: anvilUrl, PF_DEPLOYMENTS_DIR: `${run}/deployments` }, stdio: ['ignore', 'ignore', 'inherit'] });
  const demo = tsx('examples/demo-service/src/server.ts');
  svcs.demo = startService('demo-service', demo.cmd, demo.args, { DEMO_SERVICE_PORT: String(DEMO), DEMO_SERVICE_DB: `${run}/demo.db`, DEMO_FAULTS: '1', DEMO_ADMIN_TOKEN: ADMIN }, logs);
  const api = tsx('apps/api/src/main.ts');
  svcs.api = startService('api', api.cmd, api.args, env, logs);
  await waitFor('api + demo', async () => (await httpOk(`${apiUrl}/api/v1/health`)) && (await httpOk(`${demoUrl}/health`)), 30_000);
  const ix = tsx('services/indexer/src/main.ts');
  svcs.indexer = startService('indexer', ix.cmd, ix.args, env, logs);
  startWorker();

  const lr = await fetch(`${apiUrl}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'demo-owner' }) });
  cookie = lr.headers.get('set-cookie')!.split(';')[0]; csrf = (await lr.json()).csrfToken;
  const p = await apiGet('/projects/local-demo');
  projectId = p.id;
  const cts = await apiGet(`/projects/${projectId}/contracts`);
  jobs = cts.items.find((c: any) => c.alias === 'jobs').address;
  log(`project ${p.slug} · jobs ${jobs} · ${cts.items.length} contracts`);
  const all: { jobId: bigint; exec: string }[] = [];

  await step('A', 'happy path: event → workflow → demo service → completeJob → evidence', async () => {
    const j = await requestJob(12n);
    const id = await executionFor(j.txHash);
    const x = await finished(id);
    assert(x.state === 'succeeded', `state ${x.state}: ${x.error}`);
    const [, , status, eid] = await readJob(j.jobId);
    assert(status === 2 && eid.toLowerCase() === id, 'job not completed by this execution');
    assert(x.evidence[0]?.status === 'registered', 'evidence not registered');
    all.push({ jobId: j.jobId, exec: id });
    return `job ${j.jobId} completed by ${id.slice(0, 10)}…, evidence ${x.evidence[0].evidence_id.slice(0, 10)}… registered`;
  });

  await step('B', 'remote success, response lost → query before retry → processed once', async () => {
    await fault({ dropNextResponse: 1 });
    const j = await requestJob(9n);
    const id = await executionFor(j.txHash);
    const x = await finished(id);
    assert(x.state === 'succeeded', `state ${x.state}: ${x.error}`);
    const compute = x.steps.find((s: any) => s.step_id === 'compute');
    assert(compute.output.reconciled === true, 'compute result was not reconciled from the receiver');
    const st = await demoStats();
    const pe = st.perExecution.find((r: any) => r.execution_id === id);
    assert(pe.processed === 1, `demo service processed ${pe.processed} times`);
    all.push({ jobId: j.jobId, exec: id });
    return `attempts ${compute.attempts}, receiver requests ${pe.requests} (1 processed, rest query/replay), result ${compute.output.result}`;
  });

  await step('C', 'worker SIGKILL while the HTTP request is in flight → lease expiry → new worker reconciles', async () => {
    await fault({ delayMs: 5000 });
    const j = await requestJob(5n);
    const id = await executionFor(j.txHash);
    await waitFor('compute intent sent', async () => (await apiGet(`/executions/${id}`)).intents.some((i: any) => i.step_id === 'compute' && i.state === 'sent'), 30_000, 200);
    await svcs.worker.stop('SIGKILL');
    log('  worker killed (SIGKILL) with request in flight');
    await new Promise((r) => setTimeout(r, 6000)); // receiver finishes processing; lease (4s) expires
    await fault({ delayMs: 0 });
    startWorker('worker2');
    const x = await finished(id);
    assert(x.state === 'succeeded', `state ${x.state}: ${x.error}`);
    const workers = [...new Set(x.attempts.map((a: any) => a.worker_id.split('-')[0]))];
    const pe = (await demoStats()).perExecution.find((r: any) => r.execution_id === id);
    assert(pe.processed === 1, `processed ${pe.processed} times`);
    const [, , status] = await readJob(j.jobId);
    assert(status === 2, 'job not completed');
    all.push({ jobId: j.jobId, exec: id });
    return `attempts by ${workers.join(' → ')}; receiver processed once; job completed once`;
  });

  await step('D', 'RPC outage: cursor holds, incident raised, catches up after recovery', async () => {
    proxy.pause();
    log('  RPC proxy paused');
    const j = await requestJob(7n); // sent straight to Anvil; PortalForge cannot see the chain
    await new Promise((r) => setTimeout(r, 9000));
    const ixs = await apiGet(`/projects/${projectId}/indexer`);
    const evmErr = ixs.streams.filter((s: any) => s.interface === 'evm').some((s: any) => s.last_error && (!s.last_success_at || s.last_error_at >= s.last_success_at));
    const inc = await apiGet(`/projects/${projectId}/incidents`);
    const rpcInc = inc.items.find((i: any) => i.kind === 'rpc_unreachable' && i.state !== 'resolved');
    const evBefore = await apiGet(`/projects/${projectId}/events?q=${j.txHash}`);
    proxy.resume();
    log('  RPC proxy resumed');
    assert(evmErr, 'indexer did not record the read failure');
    assert(evBefore.items.length === 0, 'event indexed during outage?');
    assert(rpcInc, 'no rpc_unreachable incident');
    const id = await executionFor(j.txHash, 60_000);
    const x = await finished(id);
    assert(x.state === 'succeeded', `state ${x.state}: ${x.error}`);
    await waitFor('rpc incident auto-resolved', async () => (await apiGet(`/incidents/${rpcInc.id}?project=${projectId}`)).state === 'resolved', 30_000, 1000);
    all.push({ jobId: j.jobId, exec: id });
    return `indexer error recorded, incident ${rpcInc.id} opened then auto-resolved, job ${j.jobId} completed after recovery`;
  });

  await step('E', 'replay cannot complete a job twice', async () => {
    const r = await apiPost(`/executions/${all[0].exec}/replay`, { mode: 'full' });
    const x = await finished(r.id);
    assert(x.state === 'failed' && /different execution/.test(x.error), `replay state ${x.state}: ${x.error}`);
    return `replay ${r.id.slice(0, 10)}… failed as expected: ${x.error.slice(0, 80)}`;
  });

  await step('F', 'CLI verifies deployment, execution and evidence independently', async () => {
    const pf = (args: string[], extra: Record<string, string> = {}) => execFileSync(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], { env: { ...process.env, ...extra }, encoding: 'utf8' });
    const dv = JSON.parse(pf(['deployment', 'verify', `${run}/deployments/local-anvil.json`, '--rpc', anvilUrl, '--json']));
    assert(dv.ok, 'deployment verify failed');
    const key = (await apiPost(`/projects/${projectId}/api-keys`, { name: 'e2e', scopes: ['read'] })).secret;
    const ex = JSON.parse(pf(['execution', 'inspect', all[0].exec, '--api', apiUrl, '--json'], { PF_API_KEY: key }));
    assert(ex.state === 'succeeded', 'execution inspect');
    const evid = ex.evidence[0].id;
    const ev = JSON.parse(pf(['evidence', 'verify', evid, '--api', apiUrl, '--rpc', anvilUrl, '--json'], { PF_API_KEY: key }));
    assert(ev.ok, `evidence verify: ${JSON.stringify(ev.checks.filter((c: any) => c.status === 'fail'))}`);
    return `deployment ${dv.checks.length} checks, evidence ${ev.checks.length} checks — all pass`;
  });

  await step('G', 'global invariants on-chain and in the receiver', async () => {
    const completed = await pub.getLogs({ address: jobs, event: parseAbiItem('event JobCompleted(uint256 indexed jobId, bytes32 indexed executionId, uint256 result, bytes32 resultHash, address executor)'), fromBlock: 0n });
    const per = new Map<string, number>();
    for (const l of completed) per.set(String(l.args.jobId), (per.get(String(l.args.jobId)) ?? 0) + 1);
    for (const j of all) assert(per.get(String(j.jobId)) === 1, `job ${j.jobId} completed ${per.get(String(j.jobId)) ?? 0} times`);
    const st = await demoStats();
    const dup = st.perExecution.filter((r: any) => r.processed > 1);
    assert(dup.length === 0, `receiver processed some executions more than once: ${JSON.stringify(dup)}`);
    const xs = await apiGet(`/projects/${projectId}/executions?limit=200`);
    const byTrigger = new Map<string, number>();
    for (const x of xs.items.filter((i: any) => !i.replay_of)) byTrigger.set(x.trigger_key, (byTrigger.get(x.trigger_key) ?? 0) + 1);
    assert([...byTrigger.values()].every((n) => n === 1), 'duplicate executions for one event');
    return `${all.length} jobs → ${completed.length} JobCompleted logs (1 each), ${st.processed} receiver computations, ${xs.items.length} executions (incl. 1 replay)`;
  });

  await proxy.close();
}

const report = async (extra: Record<string, unknown> = {}) => {
  mkdirSync('docs/test-results', { recursive: true });
  const out = { schema: 'portalforge.e2e/v1', kind: 'local-anvil', note: 'Local Anvil (plain EVM). Not Portaldot testnet evidence.', startedAt: stamp, finishedAt: new Date().toISOString(), node: process.version, results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, logs, ...extra };
  writeFileSync('docs/test-results/e2e-local-latest.json', JSON.stringify(out, null, 2) + '\n');
  return out;
};

main().then(async () => {
  for (const s of Object.values(svcs).reverse()) await s.stop();
  const r = await report();
  log(`${r.passed} passed, ${r.failed} failed · report docs/test-results/e2e-local-latest.json`);
  process.exit(r.failed ? 1 : 0);
}).catch(async (e) => {
  log(`fatal: ${(e as Error).message}`);
  for (const s of Object.values(svcs).reverse()) await s.stop();
  await report({ fatal: (e as Error).message });
  process.exit(1);
});
