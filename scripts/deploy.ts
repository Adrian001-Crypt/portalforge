/**
 * PortalForge deployment: plan (read-only) and apply (signs + broadcasts, requires --confirm).
 *   npx tsx scripts/deploy.ts plan  <networkId> [--profile minimal|full]
 *   npx tsx scripts/deploy.ts apply <networkId> [--profile minimal|full] --confirm [--fund-executor <amount>]
 * The journal (deployments/<networkId>.journal.json) records each intent BEFORE broadcast and the tx hash
 * right after, so a crash or RPC loss resumes by looking up the hash / nonce instead of redeploying.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createWalletClient, defineChain, http, keccak256, parseEther, type Hex } from 'viem';
import { BUILTIN_NETWORKS, formatUnits, type DeploymentManifest } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';
import { NativeReader } from '@portalforge/portaldot-native';
import { DEPLOY_PROFILES, loadFoundryArtifact, manifestContract, planDeployment, predictCreateAddress, verifyManifest, type DeployJournalEntry } from '@portalforge/sdk';
import { loadAccount } from './lib/keys';

const [mode, id = 'local-anvil'] = process.argv.slice(2);
const flag = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const profileName = (flag('--profile') ?? 'minimal') as keyof typeof DEPLOY_PROFILES;
const base = BUILTIN_NETWORKS[id];
const rpcOverride = process.env[`PF_EVM_RPC_${(id ?? '').toUpperCase().replace(/-/g, '_')}`];
const profile = base && rpcOverride ? { ...base, evm: { ...base.evm, rpcUrl: rpcOverride } } : base;
const depDir = process.env.PF_DEPLOYMENTS_DIR ?? 'deployments';
if (!profile || !['plan', 'apply', 'verify'].includes(mode)) { console.error('usage: deploy.ts plan|apply|verify <networkId> [--profile jobs|minimal|full] [--confirm]'); process.exit(2); }
const sym = profile.evm.nativeCurrency.symbol;
const fmt = (wei: bigint | null) => (wei === null ? 'n/a' : `${formatUnits(wei, 18, 4)} ${sym}`);
const manifestPath = `${depDir}/${id}.json`;
const journalPath = `${depDir}/${id}.journal.json`;
mkdirSync(depDir, { recursive: true });

const deployer = loadAccount(id, 'deployer');
const executor = loadAccount(id, 'executor');
const artifacts = DEPLOY_PROFILES[profileName].map((n) => loadFoundryArtifact('contracts/evm/out', n));

async function nativeGenesis(): Promise<string | null | undefined> {
  if (!profile.native) return undefined;
  const nr = await NativeReader.connect(profile.native.wsUrl).catch(() => null);
  if (!nr) return null;
  try { await nr.assertIdentity(profile); return nr.api.genesisHash.toHex(); } finally { await nr.disconnect(); }
}

if (mode === 'verify') {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const report = await verifyManifest(manifest, profile, { expectedExecutor: executor.address, genesisHash: await nativeGenesis() });
  for (const c of report.checks) console.log(`${c.status.padEnd(4)} ${c.id.padEnd(36)} ${c.detail}`);
  writeFileSync(`${depDir}/${id}.verification.json`, JSON.stringify(report, null, 2) + '\n');
  process.exit(report.ok ? 0 : 1);
}

// Deposit dry-run needs a funded origin; PF_DRYRUN_ORIGIN lets you simulate from any public funded H160 (read-only).
const nativeForPlan = profile.native ? await NativeReader.connect(profile.native.wsUrl).catch(() => null) : null;
const depositOrigin = (process.env.PF_DRYRUN_ORIGIN as Hex | undefined) ?? deployer.address;
const plan = await planDeployment(profile, { deployer: deployer.address, executor: executor.address, artifacts, native: nativeForPlan, depositOrigin });
await nativeForPlan?.disconnect();
const nativeSym = profile.native?.token.symbol ?? sym;
console.log(`network   ${profile.name} (chainId ${plan.chainId})`);
console.log(`deployer  ${plan.deployer}  balance ${fmt(plan.deployerBalance)}`);
console.log(`executor  ${executor.address}`);
console.log(`gasPrice  ${plan.gasPrice} wei/gas`);
for (const c of plan.contracts) console.log(`  ${c.name.padEnd(26)} runtime ${String(c.artifact.runtimeBytes).padStart(5)} B  sim ${c.simulation.ok ? (c.simulation.runtimeMatches ? 'ok, runtime matches' : 'RUNTIME DIFFERS') : 'FAILED'}  max fee ${fmt(c.fee)}${c.deposit ? `  storage deposit ${c.deposit.ok ? `${formatUnits(c.deposit.storageDeposit!, profile.native!.token.decimals, 4)} ${nativeSym}` : 'n/a'}` : ''}`);
console.log(`total max fee ${fmt(plan.totalFee)}`);
if (plan.contracts.some((c) => c.deposit?.ok)) console.log(`total storage deposit ${formatUnits(plan.contracts.reduce((s, c) => s + (c.deposit?.storageDeposit ?? 0n), 0n), profile.native!.token.decimals, 4)} ${nativeSym} (dry-run origin ${depositOrigin}${depositOrigin === deployer.address ? '' : ', public funded account used only for simulation'})`);
plan.warnings.forEach((w) => console.log(`warning: ${w}`));
plan.blockers.forEach((b) => console.log(`BLOCKER: ${b}`));
writeFileSync(`${depDir}/${id}.plan.json`, JSON.stringify(plan, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
if (mode === 'plan') process.exit(plan.blockers.length ? 1 : 0);

// ---------------- apply ----------------
if (!process.argv.includes('--confirm')) { console.error('\nrefusing to broadcast without --confirm'); process.exit(3); }
if (plan.blockers.length) { console.error('\nplan has blockers; not broadcasting'); process.exit(1); }
const chain = defineChain({ id: profile.evm.chainId, name: profile.name, nativeCurrency: { name: sym, symbol: sym, decimals: 18 }, rpcUrls: { default: { http: [profile.evm.rpcUrl] } } });
const wallet = createWalletClient({ account: deployer, chain, transport: http(profile.evm.rpcUrl, { timeout: 60_000 }) });
const evm = new EvmReader(profile.evm.rpcUrl, 30_000);
const journal: DeployJournalEntry[] = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : [];
const saveJournal = () => writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
const commit = (() => { try { return execSync('git rev-parse HEAD').toString().trim(); } catch { return 'unknown'; } })();
const dirty = (() => { try { return execSync('git status --porcelain contracts/evm/src').toString().trim().length > 0; } catch { return true; } })();

/** Test hook: PF_DEPLOY_CRASH=intent:<Name>|sent:<Name> exits abruptly at that point (used by scripts/test-deploy-resume.ts). */
function crashPoint(at: string) {
  if (process.env.PF_DEPLOY_CRASH === at) { console.error(`[test] simulated crash at ${at}`); process.exit(70); }
}

async function waitReceipt(hash: Hex, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evm.receipt(hash).catch(() => undefined); // undefined = read failed, keep polling; null = not yet mined
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2_000));
  }
  return null;
}

const confirmed: DeploymentManifest['contracts'] = existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).network?.chainId === profile.evm.chainId ? JSON.parse(readFileSync(manifestPath, 'utf8')).contracts : [];
for (const pc of plan.contracts) {
  if (confirmed.find((c) => c.name === pc.name && c.artifactRuntimeHash === pc.artifact.artifactRuntimeHash)) { console.log(`${pc.name}: already in manifest, skipping`); continue; }
  let entry = journal.find((j) => j.name === pc.name && j.state !== 'failed');
  if (!entry) {
    const nonce = await evm.nonce(deployer.address, 'pending');
    entry = { name: pc.name, nonce, predictedAddress: predictCreateAddress(deployer.address, nonce), state: 'intent' };
    journal.push(entry); saveJournal(); // intent persisted before the wallet signs
  }
  crashPoint(`intent:${pc.name}`);
  if (entry.state === 'intent') {
    const latestNonce = await evm.nonce(deployer.address, 'latest');
    if (latestNonce > entry.nonce) {
      console.log(`${pc.name}: nonce ${entry.nonce} already used; checking predicted address ${entry.predictedAddress} before any resend`);
      const code = await evm.code(entry.predictedAddress);
      if (code === '0x') { entry.state = 'failed'; entry.error = 'nonce consumed without contract at predicted address; manual review required'; saveJournal(); console.error(entry.error); process.exit(1); }
      console.error(`${pc.name}: contract exists at predicted address but tx hash was not journaled. Find the tx in the block explorer/RPC and add it to the journal; refusing to redeploy.`);
      process.exit(1);
    }
    const hash = await wallet.sendTransaction({ data: pc.initCode, gas: pc.gas!, gasPrice: plan.gasPrice, nonce: entry.nonce, type: 'legacy', chain });
    entry.txHash = hash; entry.state = 'sent'; saveJournal();
    console.log(`${pc.name}: sent ${hash}`);
    crashPoint(`sent:${pc.name}`);
  }
  const r = await waitReceipt(entry.txHash!);
  if (!r) {
    const known = await evm.transaction(entry.txHash!).catch(() => undefined);
    const latest = await evm.nonce(deployer.address, 'latest').catch(() => undefined);
    if (known === null && latest !== undefined && latest <= entry.nonce) {
      // Not mined, not in the pool, nonce unused: the broadcast was dropped. Safe to send a fresh intent next run.
      entry.state = 'failed'; entry.error = 'dropped: not mined, not in pool, nonce unused'; saveJournal();
      console.error(`${pc.name}: ${entry.txHash} was dropped (nonce ${entry.nonce} unused); re-run apply to send it again`);
    } else console.error(`${pc.name}: receipt not found yet for ${entry.txHash}; re-run apply later — it will resume from the journal`);
    process.exit(4);
  }
  if (r.status !== 'success' || !r.contractAddress) { entry.state = 'failed'; entry.error = `status ${r.status}`; saveJournal(); console.error(`${pc.name}: deploy reverted`); process.exit(1); }
  const code = await evm.code(r.contractAddress);
  confirmed.push(manifestContract(pc.artifact, pc.args, { address: r.contractAddress, txHash: r.transactionHash, blockNumber: r.blockNumber, blockHash: r.blockHash, deployer: deployer.address, runtimeCodeHash: keccak256(code) }));
  entry.state = 'confirmed'; saveJournal();
  console.log(`${pc.name}: ${r.contractAddress} at block #${r.blockNumber} (gasUsed ${r.gasUsed}, fee ${fmt(r.gasUsed * r.effectiveGasPrice)}; predicted ${entry.predictedAddress}${entry.predictedAddress.toLowerCase() === r.contractAddress ? ' ✓' : ' ✗ differs'})`);
  writeManifest();
}

function writeManifest() {
  const art0 = artifacts[0];
  const m: DeploymentManifest = {
    schema: 'portalforge.deployment/v1',
    network: { id: profile.id, chainId: profile.evm.chainId, ...(profile.native ? { genesisHash: profile.native.genesisHash, specName: profile.native.specName } : {}) },
    source: { repo: 'portalforge', commit, dirty },
    compiler: art0.compiler,
    contracts: confirmed,
    createdAt: new Date().toISOString(),
    notes: profile.kind === 'local-dev' ? ['Local Anvil deployment: plain EVM, not pallet-revive. Not testnet evidence.'] : [],
  };
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
}

const fund = flag('--fund-executor');
if (fund) {
  const value = parseEther(fund);
  const bal = await evm.balance(executor.address);
  if (bal >= value) console.log(`executor already holds ${fmt(bal)}; not funding`);
  else {
    const hash = await wallet.sendTransaction({ to: executor.address, value: value - bal, gasPrice: plan.gasPrice, type: 'legacy', chain });
    const r = await waitReceipt(hash);
    console.log(`funded executor ${fmt(value - bal)}: ${hash} ${r?.status ?? 'pending'}`);
  }
}
const report = await verifyManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), profile, { expectedExecutor: executor.address, genesisHash: await nativeGenesis() });
for (const c of report.checks) console.log(`${c.status.padEnd(4)} ${c.id.padEnd(36)} ${c.detail}`);
writeFileSync(`${depDir}/${id}.verification.json`, JSON.stringify(report, null, 2) + '\n');
process.exit(report.ok ? 0 : 1);
