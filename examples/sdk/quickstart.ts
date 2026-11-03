/**
 * SDK quickstart (runs as-is from the repo):  npx tsx examples/sdk/quickstart.ts
 * 1. live, read-only capability probe of Portaldot V3
 * 2. typed API client against a running PortalForge (npm run dev), reading the public demo project
 */
import { PORTALDOT_V3_TESTNET, validateWorkflow } from '@portalforge/domain';
import { probeNetwork, PortalForgeClient } from '@portalforge/sdk';
import { readFileSync } from 'node:fs';

const caps = await probeNetwork(PORTALDOT_V3_TESTNET, { skipNative: process.env.SKIP_NATIVE === '1' });
const pick = (id: string) => caps.checks.find((c) => c.id === id)?.summary;
console.log('V3 chainId:', pick('evm.chain_id'));
console.log('V3 token:', pick('native.token') ?? '(native skipped)');

const def = JSON.parse(readFileSync('examples/workflows/job-square.json', 'utf8'));
const v = validateWorkflow(def);
console.log('workflow job-square valid:', v.ok, v.ok ? v.order.join(' → ') : v.issues);

const pf = new PortalForgeClient({ baseUrl: process.env.PF_API_URL ?? 'http://127.0.0.1:4300', apiKey: process.env.PF_API_KEY });
try {
  let n = 0;
  for await (const e of pf.allEvents('local-demo', { event: 'JobCompleted', limit: 50 })) { if (n++ < 3) console.log('JobCompleted', e.block_number, e.args.jobId, e.args.result); }
  console.log(`${n} JobCompleted events in local-demo`);
} catch (e) { console.log('API not reachable or project not visible:', (e as Error).message); }
