/**
 * Public read-only demo stack. Isolated from `npm run dev` (own ports, own data dir).
 *   npx tsx scripts/public-demo.ts                 # local Anvil data, labelled "Local Anvil · not testnet"
 *   PF_PUBLIC_NETWORK=testnet npx tsx scripts/public-demo.ts   # Portaldot V3 (needs deployments/portaldot-v3-testnet.json)
 *   … --tunnel                                      # also expose ONLY the API port over HTTPS (Cloudflare quick tunnel)
 *
 * Public guarantees (tested in apps/api/test/api.test.ts and scripts/check-public.ts):
 *  dev sign-in off · anonymous read of public_readonly projects only · no connector targets, channels,
 *  audit log or host names for visitors · anonymous POSTs limited to pure validation/simulation and
 *  evidence verification (RPC reads), rate-limited · executor key stays in the worker process ·
 *  demo-service fault endpoints bound to 127.0.0.1 and never proxied.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { startService, tsx, waitFor, rpcUp, httpOk, type Svc } from './lib/proc';

const testnet = process.env.PF_PUBLIC_NETWORK === 'testnet';
const net = testnet ? 'portaldot-v3-testnet' : 'local-anvil';
const dir = process.env.PF_PUBLIC_DATA ?? 'data/public';
const API = Number(process.env.PF_PUBLIC_API_PORT ?? 4400), DEMO = 4410, ANVIL = 8557;
const anvilUrl = `http://127.0.0.1:${ANVIL}`;
const adminToken = randomBytes(24).toString('hex'); // used only by this script, never printed
const svcs: Svc[] = [];
const log = (m: string) => console.log(`[public-demo] ${m}`);

async function main() {
  if (!existsSync('apps/web/dist/index.html')) execSync('npm run -s web:build', { stdio: 'inherit' });
  if (!testnet) { rmSync(dir, { recursive: true, force: true }); }
  mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    // Local data plus read-only observation of Portaldot V3.
    PF_MODE: testnet ? 'testnet' : 'local', PF_NETWORKS: testnet ? net : 'local-anvil,portaldot-v3-testnet', PF_DB: `${dir}/portalforge.db`, PF_API_PORT: String(API), PF_API_HOST: '127.0.0.1',
    PF_DEV_LOGIN: '0', PF_PUBLIC_READONLY: '1', PF_SEED_DEMO: '1', PF_WEB_DIST: 'apps/web/dist',
    PF_PUBLIC_ORIGIN: process.env.PF_PUBLIC_ORIGIN ?? `http://127.0.0.1:${API}`, PF_ALLOW_PRIVATE_CONNECTORS: '1', PF_DEMO_SERVICE_URL: `http://127.0.0.1:${DEMO}`,
    PF_DEPLOYMENTS_DIR: testnet ? 'deployments' : `${dir}/deployments`,
    ...(testnet ? {} : { PF_EVM_RPC_LOCAL_ANVIL: anvilUrl }),
  };
  if (testnet && !existsSync('deployments/portaldot-v3-testnet.json')) log('no testnet manifest yet: the public project will show "Not deployed on Portaldot V3 testnet yet"');
  if (!testnet) {
    svcs.push(startService('anvil', `${process.env.HOME}/.local/toolchains/foundry/anvil`, ['--port', String(ANVIL), '--block-time', '2', '--silent'], {}, `${dir}/logs`));
    await waitFor('anvil', () => rpcUp(anvilUrl), 20_000);
    execSync('node --import tsx scripts/deploy.ts apply local-anvil --profile full --confirm', { env: { ...process.env, PF_EVM_RPC_LOCAL_ANVIL: anvilUrl, PF_DEPLOYMENTS_DIR: `${dir}/deployments` }, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const demo = tsx('examples/demo-service/src/server.ts');
  svcs.push(startService('demo-service', demo.cmd, demo.args, { DEMO_SERVICE_PORT: String(DEMO), DEMO_SERVICE_DB: `${dir}/demo.db`, DEMO_FAULTS: testnet ? '0' : '1', DEMO_ADMIN_TOKEN: adminToken }, `${dir}/logs`));
  const api = tsx('apps/api/src/main.ts');
  svcs.push(startService('api', api.cmd, api.args, env, `${dir}/logs`));
  await waitFor('api', () => httpOk(`http://127.0.0.1:${API}/api/v1/health`), 30_000);
  // On testnet this stack only reads: its own fresh database must never run workflows or sign with the executor key.
  for (const s of testnet ? ['indexer'] : ['indexer', 'worker']) { const t = tsx(`services/${s}/src/main.ts`); svcs.push(startService(s, t.cmd, t.args, env, `${dir}/logs`)); }

  if (!testnet) {
    // Seed real local activity so visitors see a complete flow (all labelled Local Anvil).
    const job = (n: number) => execSync(`node --import tsx scripts/request-job.ts local-anvil ${n} --confirm`, { env: { ...process.env, PF_EVM_RPC_LOCAL_ANVIL: anvilUrl, PF_DEPLOYMENTS_DIR: `${dir}/deployments` }, stdio: 'ignore' });
    job(12);
    await new Promise((r) => setTimeout(r, 4000));
    await fetch(`http://127.0.0.1:${DEMO}/admin/faults`, { method: 'POST', headers: { 'x-admin-token': adminToken }, body: JSON.stringify({ dropNextResponse: 1 }) });
    job(9);
    await new Promise((r) => setTimeout(r, 4000));
    job(21);
    await waitFor('3 executions succeeded', async () => {
      const r = await (await fetch(`http://127.0.0.1:${API}/api/v1/projects/local-demo/executions?state=succeeded`)).json();
      return r.items.length >= 3;
    }, 90_000, 1000);
    log('seeded 3 real local jobs (one recovered from a dropped response)');
  }
  log(`public read-only console: http://127.0.0.1:${API}  (dev sign-in disabled)`);
  if (process.argv.includes('--tunnel')) {
    const bin = `${process.env.HOME}/.local/toolchains/cloudflared`;
    const t = spawn(existsSync(bin) ? bin : 'cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${API}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    svcs.push({ name: 'tunnel', proc: t, logFile: '', stop: async () => { t.kill('SIGTERM'); } });
    const onData = (b: Buffer) => { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(b.toString()); if (m) log(`public URL (temporary, lives only while this process runs): ${m[0]}`); };
    t.stdout!.on('data', onData); t.stderr!.on('data', onData);
  }
}

const stop = async () => { for (const s of [...svcs].reverse()) await s.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
main().catch(async (e) => { console.error(e.message); await stop(); });
