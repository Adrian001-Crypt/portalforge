/**
 * Local integration stack: Anvil (EVM, not pallet-revive) → contracts deployed → demo service → API (+console)
 * → indexer → worker → Vite dev server. Ctrl+C stops everything.
 *   npm run dev                 # local Anvil
 *   PF_MODE=testnet npm run dev # real Portaldot V3 (needs deployments/portaldot-v3-testnet.json + executor key)
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { startService, tsx, waitFor, rpcUp, httpOk, type Svc } from './lib/proc';

const mode = process.env.PF_MODE ?? 'local';
const dataDir = process.env.PF_DATA_DIR ?? 'data';
const logs = `${dataDir}/logs`;
const net = mode === 'testnet' ? 'portaldot-v3-testnet' : 'local-anvil';
const API_PORT = process.env.PF_API_PORT ?? '4300', WEB_PORT = process.env.PF_WEB_PORT ?? '5180', DEMO_PORT = '4310';
const svcs: Svc[] = [];
const common: Record<string, string> = {
  PF_MODE: mode, PF_NETWORKS: net, PF_DB: `${dataDir}/portalforge.db`, PF_API_PORT: API_PORT, PF_WEB_PORT: WEB_PORT,
  PF_PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`, PF_DEV_LOGIN: '1', PF_PUBLIC_READONLY: '1', PF_SEED_DEMO: '1',
  PF_ALLOW_PRIVATE_CONNECTORS: '1', PF_DEMO_SERVICE_URL: `http://127.0.0.1:${DEMO_PORT}`,
  ...(mode === 'testnet' ? { PF_EXECUTOR_KEY_FILE_PORTALDOT_V3_TESTNET: '.secrets/portaldot-v3-testnet-executor.json' } : {}),
};

async function main() {
  if (mode === 'local') {
    // Anvil starts an empty chain every time, so local state from a previous chain is meaningless.
    if (process.env.PF_KEEP_LOCAL_DATA !== '1') for (const f of ['portalforge.db', 'portalforge.db-wal', 'portalforge.db-shm', 'demo-service.db', 'demo-service.db-wal', 'demo-service.db-shm']) rmSync(`${dataDir}/${f}`, { force: true });
    const anvilBin = `${process.env.HOME}/.local/toolchains/foundry/anvil`;
    svcs.push(startService('anvil', existsSync(anvilBin) ? anvilBin : 'anvil', ['--port', '8547', '--block-time', '2', '--silent'], {}, logs));
    await waitFor('anvil', () => rpcUp('http://127.0.0.1:8547'), 20_000);
    if (!existsSync('contracts/evm/out/JobRegistry.sol/JobRegistry.json')) execSync('npm run -s contracts:build', { stdio: 'inherit' });
    execSync('node --import tsx scripts/deploy.ts apply local-anvil --profile full --confirm', { stdio: ['ignore', 'ignore', 'inherit'] });
    console.log('contracts deployed to local Anvil (deployments/local-anvil.json)');
  } else if (!existsSync(`deployments/${net}.json`)) {
    console.warn(`deployments/${net}.json not found: the demo project will have no contracts until you deploy (docs/deployment.md).`);
  }
  const demo = tsx('examples/demo-service/src/server.ts');
  svcs.push(startService('demo-service', demo.cmd, demo.args, { DEMO_SERVICE_PORT: DEMO_PORT, DEMO_SERVICE_DB: `${dataDir}/demo-service.db`, DEMO_FAULTS: '1', DEMO_ADMIN_TOKEN: process.env.DEMO_ADMIN_TOKEN ?? 'local-demo-admin-token' }, logs));
  const api = tsx('apps/api/src/main.ts');
  svcs.push(startService('api', api.cmd, api.args, common, logs));
  await waitFor('api', () => httpOk(`http://127.0.0.1:${API_PORT}/api/v1/health`), 30_000);
  for (const s of ['indexer', 'worker']) { const t = tsx(`services/${s}/src/main.ts`); svcs.push(startService(s, t.cmd, t.args, common, logs)); }
  if (process.env.PF_NO_WEB !== '1') svcs.push(startService('web', 'npx', ['vite', '--port', WEB_PORT, '--strictPort', '--config', 'apps/web/vite.config.ts', 'apps/web'], { PF_API_PORT: API_PORT }, logs));
  console.log(`\nPortalForge (${mode}) running:\n  console  http://localhost:${WEB_PORT}\n  api      http://127.0.0.1:${API_PORT}/api/v1/health\n  demo svc http://127.0.0.1:${DEMO_PORT}/health\n  logs     ${logs}/*.log\n`);
}

const stop = async () => { console.log('\nstopping…'); for (const s of [...svcs].reverse()) await s.stop(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
main().catch(async (e) => { console.error(e.message); for (const s of svcs) await s.stop(); process.exit(1); });
void readFileSync;
