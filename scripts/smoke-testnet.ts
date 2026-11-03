/**
 * Read-only smoke test against the live Portaldot V3 testnet. Nothing is signed or broadcast.
 *  1. capability probe (identity, opcodes, mapping, correlation)
 *  2. deploy plan with exact storage deposits
 *  3. live EVM + native indexing of a recent window holding real logs from a public contract,
 *     and verification of the EVM ⇄ native correlation rule on those observations
 *  4. if deployments/portaldot-v3-testnet.json exists: manifest verification
 * Writes docs/test-results/smoke-testnet-latest.json.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PORTALDOT_V3_TESTNET as P } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';
import { NativeReader } from '@portalforge/portaldot-native';
import { probeNetwork, planDeployment, loadFoundryArtifact, DEPLOY_PROFILES, verifyManifest } from '@portalforge/sdk';
import { Db, json, now } from '@portalforge/store';
import { EvmIndexer, NativeIndexer, correlatedPairs } from '@portalforge/indexer';
import type { Hex } from 'viem';

const results: { id: string; ok: boolean | null; detail: string; data?: unknown }[] = [];
const rec = (id: string, ok: boolean | null, detail: string, data?: unknown) => { results.push({ id, ok, detail, data }); console.log(`${ok === null ? '·' : ok ? '✔' : '✖'} ${id.padEnd(28)} ${detail}`); };

const probe = await probeNetwork(P);
const idOk = !probe.checks.some((c) => c.area === 'identity' && c.status !== 'supported');
rec('probe.identity', idOk, `${probe.checks.filter((c) => c.status === 'supported').length} supported checks, identity ${idOk ? 'matches' : 'MISMATCH'}`);
rec('probe.correlation', probe.checks.find((c) => c.id === 'correlation.block_numbers')?.status === 'supported', probe.checks.find((c) => c.id === 'correlation.block_numbers')?.summary ?? 'n/a');
rec('probe.mapping', probe.checks.filter((c) => c.area === 'mapping').every((c) => c.status === 'supported'), probe.checks.filter((c) => c.area === 'mapping').map((c) => c.status).join(', '));

const native = await NativeReader.connect(P.native!.wsUrl);
try {
  const dep = existsSync(`.secrets/${P.id}-deployer.json`) ? JSON.parse(readFileSync(`.secrets/${P.id}-deployer.json`, 'utf8')).address : '0x0000000000000000000000000000000000000001';
  const plan = await planDeployment(P, { deployer: dep, executor: dep, artifacts: DEPLOY_PROFILES.minimal.map((n) => loadFoundryArtifact('contracts/evm/out', n)), native, depositOrigin: process.env.PF_DRYRUN_ORIGIN as Hex | undefined });
  rec('deploy.simulation', plan.contracts.every((c) => c.simulation.ok && c.simulation.runtimeMatches), plan.contracts.map((c) => `${c.name}: ${c.simulation.ok && c.simulation.runtimeMatches ? 'runtime matches' : c.simulation.error ?? 'differs'}`).join('; '));
  rec('deploy.deposit', plan.contracts.every((c) => c.deposit?.ok) ? true : null, plan.contracts.map((c) => `${c.name}: ${c.deposit?.ok ? `${Number(c.deposit.storageDeposit) / 1e14} tPOT` : c.deposit?.error}`).join('; '));
  rec('deploy.balance', plan.deployerBalance !== null && plan.blockers.length === 0 ? true : null, plan.blockers.join('; ') || 'deployer funded');

  // Live indexing window around the most recent block with logs (public data from any deployed contract).
  const evm = new EvmReader(P.evm.rpcUrl, 30_000);
  const head = await evm.blockNumber();
  const recent = await evm.logs({ fromBlock: head - 3000, toBlock: head });
  if (!recent.length) rec('index.window', null, 'no logs in the last 3000 blocks; skipping live index check');
  else {
    const target = recent.at(-1)!;
    const db = new Db(':memory:').migrate();
    db.run('INSERT INTO networks (id, profile, builtin, created_at) VALUES (?, ?, 1, ?)', P.id, json(P), now());
    db.run(`INSERT INTO users (id, handle, created_at) VALUES ('u', 'smoke', ?)`, now());
    db.run(`INSERT INTO projects (id, slug, name, environment, network_id, created_by, created_at, updated_at) VALUES ('p', 'smoke', 'smoke', 'testnet', ?, 'u', ?, ?)`, P.id, now(), now());
    db.run(`INSERT INTO contracts (id, project_id, alias, network_id, runtime, address, deploy_block, created_at, updated_at) VALUES ('c', 'p', 'observed', ?, 'evm', ?, ?, ?, ?)`, P.id, target.address, target.blockNumber - 1, now(), now());
    db.run(`INSERT INTO contract_abis (contract_id, version, abi, abi_hash, created_at) VALUES ('c', 1, '[]', 'none', ?)`, now());
    const ex = new EvmIndexer(db, P, evm);
    for (let i = 0; i < 3; i++) await ex.tick();
    const evmCount = db.get(`SELECT COUNT(*) n FROM events WHERE interface = 'evm'`).n;
    rec('index.evm', evmCount > 0, `${evmCount} logs from ${target.address} indexed (no ABI registered → stored undecoded, isolated)`);
    const nx = new NativeIndexer(db, P, native, { startBlock: target.blockNumber - 1, maxBlocksPerTick: 4 });
    await nx.tick();
    const nat = db.all(`SELECT event_name, block_number FROM events WHERE interface = 'native'`);
    rec('index.native', nat.length > 0, `${nat.length} native events (${[...new Set(nat.map((r) => r.event_name))].join(', ')}) decoded with runtime spec ${db.get(`SELECT decoder_version d FROM cursors WHERE interface = 'native'`).d}`);
    const pairs = correlatedPairs(db, P.id, 50);
    rec('index.correlation', pairs.length > 0 && pairs.every((p: any) => p.verified === 1), `${pairs.length} EVM logs linked to Revive.ContractEmitted; ${pairs.filter((p: any) => p.verified === 1).length} verified by ethBlockHash`, pairs.slice(0, 3));
    db.close();
  }

  const mpath = `deployments/${P.id}.json`;
  if (existsSync(mpath)) {
    const r = await verifyManifest(JSON.parse(readFileSync(mpath, 'utf8')), P, { genesisHash: native.api.genesisHash.toHex() });
    rec('deployment.verify', r.ok, `${r.checks.filter((c) => c.status === 'pass').length}/${r.checks.length} checks passed`, r.checks.filter((c) => c.status !== 'pass'));
  } else rec('deployment.verify', null, `${mpath} not present — testnet deployment not done yet`);
} finally { await native.disconnect(); }

mkdirSync('docs/test-results', { recursive: true });
writeFileSync('docs/test-results/smoke-testnet-latest.json', JSON.stringify({ schema: 'portalforge.smoke/v1', network: P.id, at: new Date().toISOString(), results, probe: { probedAt: probe.probedAt, checks: probe.checks.map(({ evidence, ...c }) => c) } }, null, 2) + '\n');
const failed = results.filter((r) => r.ok === false).length;
console.log(`\n${results.filter((r) => r.ok).length} passed · ${failed} failed · ${results.filter((r) => r.ok === null).length} skipped/not applicable`);
process.exit(failed ? 1 : 0);
