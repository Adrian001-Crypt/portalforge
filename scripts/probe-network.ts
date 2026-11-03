/**
 * Live capability probe for Portaldot V3. Read-only: no signing, no funds, no operator RPC calls.
 * Usage: npx tsx scripts/probe-network.ts [networkId] [--out docs/probe/<file>.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BUILTIN_NETWORKS } from '@portalforge/domain';
import { probeNetwork } from '@portalforge/sdk';

const id = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'portaldot-v3-testnet';
const outIdx = process.argv.indexOf('--out');
const profile = BUILTIN_NETWORKS[id];
if (!profile) { console.error(`unknown network ${id}`); process.exit(2); }
const report = await probeNetwork(profile);
for (const c of report.checks) console.log(`${c.status.padEnd(11)} ${c.id.padEnd(34)} ${c.summary}`);
if (outIdx > 0) {
  const out = process.argv[outIdx + 1];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nwrote ${out}`);
}
process.exit(report.checks.some((c) => c.status === 'mismatch' && c.area === 'identity') ? 1 : 0);
