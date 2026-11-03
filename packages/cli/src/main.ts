/**
 * pf — PortalForge CLI.
 * Exit codes: 0 ok · 1 check/verification failed · 2 usage error · 3 not configured / not supported · 4 network or RPC error.
 * Never prints secrets: API keys come from PF_API_KEY and are not echoed.
 */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { keccak256, type Hex } from 'viem';
import { BUILTIN_NETWORKS, PfError, isPfError, validateWorkflow, formatUnits, type NetworkProfile } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';
import { NativeReader } from '@portalforge/portaldot-native';
import { probeNetwork, verifyManifest, verifyEvidence, loadFoundryArtifact, planDeployment, DEPLOY_PROFILES, PortalForgeClient } from '@portalforge/sdk';

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) flags.set(k, v); else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(k, argv[++i]); else flags.set(k, true); }
  else pos.push(a);
}
const asJson = flags.has('json');
const flag = (k: string) => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
const cfgPath = flag('config') ?? 'portalforge.config.json';
const cfg: { network?: string; apiUrl?: string; project?: string } = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const timeoutMs = Number(flag('timeout') ?? 20_000);

class Exit extends Error { constructor(readonly code: number, msg: string, readonly data?: unknown) { super(msg); } }
const out = (human: string, data: unknown) => { if (asJson) console.log(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)); else console.log(human); };
const sym = (s: string) => ({ supported: '✔', pass: '✔', unsupported: '·', skip: '·', info: 'i', error: '✖', fail: '✖', mismatch: '≠' })[s] ?? '?';
const table = (rows: { status: string; id: string; summary?: string; detail?: string }[]) => rows.map((r) => `${sym(r.status)} ${r.status.padEnd(11)} ${r.id.padEnd(36)} ${r.summary ?? r.detail ?? ''}`).join('\n');

function network(): NetworkProfile {
  const id = flag('network') ?? cfg.network ?? 'portaldot-v3-testnet';
  const p = BUILTIN_NETWORKS[id];
  if (!p) throw new Exit(2, `unknown network "${id}". Known: ${Object.keys(BUILTIN_NETWORKS).join(', ')}`);
  const rpc = flag('rpc');
  return rpc ? { ...p, evm: { ...p.evm, rpcUrl: rpc } } : p;
}
function client() {
  const baseUrl = flag('api') ?? cfg.apiUrl ?? process.env.PF_API_URL;
  if (!baseUrl) throw new Exit(3, 'no API URL: pass --api, set PF_API_URL, or run `pf project init`');
  return new PortalForgeClient({ baseUrl, apiKey: process.env.PF_API_KEY, timeoutMs });
}
const projectId = () => { const p = flag('project') ?? cfg.project; if (!p) throw new Exit(2, 'pass --project <id|slug> or set it in portalforge.config.json'); return p; };
const readJson = (file: string | undefined, what: string) => {
  if (!file) throw new Exit(2, `missing ${what} file`);
  if (!existsSync(file)) throw new Exit(2, `${file} not found`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Exit(2, `${file}: invalid JSON (${(e as Error).message})`); }
};

const HELP = `pf — PortalForge CLI (build, observe, automate on Portaldot)

Usage: pf <command> [options]

  doctor                               Check toolchain, config, RPC reachability, secrets hygiene
  network inspect                      Live capability probe of the network (read-only)
  project init [--project s] [--api u] Write portalforge.config.json
  deploy plan [--profile minimal|full] [--from 0x…]
                                       Simulate creates on the network, exact fees, balance check
  deployment verify <manifest.json> [--executor 0x…]
                                       Re-read every manifest claim from the chain
  events tail [--contract alias] [--event Name] [--follow]
                                       Stream indexed events from the PortalForge API
  events tail --address 0x… [--from-block n] [--follow]
                                       Stream raw logs straight from RPC (no API)
  workflow validate <file.json>        Structural validation (DAG, references, schema)
  workflow simulate <file.json> --trigger <json|file> [--stubs <json|file>]
                                       Dry-run without side effects (via API)
  execution inspect <executionId>      Step-by-step trace with attempts and intents
  evidence verify <evidenceId> [--api]  Fetch content from the API, verify on-chain independently
  evidence verify --registry 0x… --id 0x… --content <file>
                                       Verify local content against the registry (no API)

Global: --network <id>  --rpc <url>  --api <url>  --project <id>  --json  --timeout <ms>
Env:    PF_API_URL, PF_API_KEY (project-scoped key; never printed)
Exit:   0 ok · 1 failed check · 2 usage · 3 not configured/supported · 4 network error`;

async function main(): Promise<number> {
  const [cmd, sub] = pos;
  if (!cmd || flags.has('help') || cmd === 'help') { console.log(HELP); return 0; }

  if (cmd === 'doctor') {
    const checks: { id: string; status: string; detail: string }[] = [];
    const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, status: ok === null ? 'skip' : ok ? 'pass' : 'fail', detail });
    add('node.version', Number(process.versions.node.split('.')[0]) >= 24, `node ${process.versions.node} (need ≥ 24 for node:sqlite)`);
    const forge = (() => { try { return execSync('forge --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')[0]; } catch { return null; } })();
    add('foundry', forge ? true : null, forge ?? 'forge not on PATH (only needed to rebuild contracts)');
    add('config', existsSync(cfgPath) ? true : null, existsSync(cfgPath) ? cfgPath : 'no portalforge.config.json (run pf project init)');
    const p = network();
    const r = await new EvmReader(p.evm.rpcUrl, timeoutMs).raw<string>('eth_chainId');
    add('evm.rpc', r.ok && Number.parseInt(r.value, 16) === p.evm.chainId, r.ok ? `${p.evm.rpcUrl} chainId ${Number.parseInt(r.value, 16)} in ${Math.round(r.ms)}ms` : `${p.evm.rpcUrl}: ${r.error.message}`);
    if (p.native) {
      try { const n = await NativeReader.connect(p.native.wsUrl, timeoutMs); const g = n.api.genesisHash.toHex(); await n.disconnect(); add('native.ws', g === p.native.genesisHash, `${p.native.wsUrl} genesis ${g.slice(0, 18)}…`); }
      catch (e) { add('native.ws', false, `${p.native.wsUrl}: ${(e as Error).message}`); }
    }
    for (const f of ['.secrets/portaldot-v3-testnet-deployer.json', '.secrets/portaldot-v3-testnet-executor.json']) if (existsSync(f)) add(`secrets.${f.split('-').at(-1)!.replace('.json', '')}`, (statSync(f).mode & 0o077) === 0, `${f} mode ${(statSync(f).mode & 0o777).toString(8)}`);
    const ignored = (() => { try { execSync('git check-ignore -q .secrets/x .env data/x.db', { stdio: 'ignore' }); return true; } catch { return false; } })();
    add('gitignore', ignored, ignored ? '.secrets/, .env and data/*.db are git-ignored' : 'secrets or databases may be committed — check .gitignore');
    const api = flag('api') ?? cfg.apiUrl ?? process.env.PF_API_URL;
    if (api) { try { const h = await client().health(); add('api', h.ok, `${api} mode ${h.mode}, services ${h.services.map((s: any) => `${s.service}:${s.alive ? 'alive' : 'stale'}`).join(' ') || 'none'}`); } catch (e) { add('api', false, (e as Error).message); } }
    out(table(checks), { checks });
    return checks.some((c) => c.status === 'fail') ? 1 : 0;
  }

  if (cmd === 'network' && sub === 'inspect') {
    const p = network();
    const report = await probeNetwork(p, { skipNative: flags.has('evm-only') });
    out(`${p.name} — probed ${report.probedAt} in ${report.durationMs}ms\n${table(report.checks.map((c) => ({ ...c, summary: c.summary })))}`, report);
    if (flag('out')) writeFileSync(flag('out')!, JSON.stringify(report, null, 2) + '\n');
    return report.checks.some((c) => c.area === 'identity' && c.status === 'mismatch') ? 1 : 0;
  }

  if (cmd === 'project' && sub === 'init') {
    if (existsSync(cfgPath) && !flags.has('force')) throw new Exit(1, `${cfgPath} exists (use --force)`);
    const c = { network: flag('network') ?? 'portaldot-v3-testnet', apiUrl: flag('api') ?? 'http://127.0.0.1:4300', project: flag('project') ?? 'local-demo' };
    writeFileSync(cfgPath, JSON.stringify({ $schema: 'portalforge.config/v1', ...c }, null, 2) + '\n');
    out(`wrote ${cfgPath}\nSet PF_API_KEY to a project-scoped key (Developer API page). It is read from the environment only.`, { path: cfgPath, ...c });
    return 0;
  }

  if (cmd === 'deploy' && sub === 'plan') {
    const p = network();
    const profile = (flag('profile') ?? 'minimal') as keyof typeof DEPLOY_PROFILES;
    if (!DEPLOY_PROFILES[profile]) throw new Exit(2, 'profile must be minimal or full');
    const from = (flag('from') ?? (existsSync(`.secrets/${p.id}-deployer.json`) ? JSON.parse(readFileSync(`.secrets/${p.id}-deployer.json`, 'utf8')).address : undefined)) as Hex | undefined;
    if (!from) throw new Exit(2, 'pass --from <deployer address> (or run npm run keygen)');
    const executor = (flag('executor') ?? (existsSync(`.secrets/${p.id}-executor.json`) ? JSON.parse(readFileSync(`.secrets/${p.id}-executor.json`, 'utf8')).address : from)) as Hex;
    const outDir = flag('artifacts') ?? 'contracts/evm/out';
    if (!existsSync(outDir)) throw new Exit(3, `${outDir} missing — run npm run contracts:build`);
    const native = p.native && !flags.has('evm-only') ? await NativeReader.connect(p.native.wsUrl, timeoutMs).catch(() => null) : null;
    const plan = await planDeployment(p, { deployer: from, executor, artifacts: DEPLOY_PROFILES[profile].map((n) => loadFoundryArtifact(outDir, n)), native, depositOrigin: flag('deposit-origin') as Hex | undefined });
    await native?.disconnect();
    const f = (v: bigint | null) => (v === null ? 'n/a' : `${formatUnits(v, 18, 4)} ${p.evm.nativeCurrency.symbol}`);
    const lines = [`${p.name} · deployer ${from} · balance ${f(plan.deployerBalance)} · gasPrice ${plan.gasPrice}`,
      ...plan.contracts.map((c) => `  ${c.name.padEnd(26)} ${String(c.artifact.runtimeBytes).padStart(5)} B  simulation ${c.simulation.ok ? (c.simulation.runtimeMatches ? 'ok (runtime matches artifact)' : 'RUNTIME DIFFERS') : `FAILED ${c.simulation.error}`}  max fee ${f(c.fee)}${c.deposit ? `  deposit ${c.deposit.ok ? formatUnits(c.deposit.storageDeposit!, p.native!.token.decimals, 4) + ' ' + p.native!.token.symbol : `n/a (${c.deposit.error})`}` : ''}`),
      `  total max fee ${f(plan.totalFee)}`, ...plan.warnings.map((w) => `warning: ${w}`), ...plan.blockers.map((b) => `BLOCKER: ${b}`)];
    out(lines.join('\n'), { ...plan, contracts: plan.contracts.map(({ initCode, artifact, ...c }) => ({ ...c, runtimeBytes: artifact.runtimeBytes, artifactRuntimeHash: artifact.artifactRuntimeHash, initCodeHash: keccak256(initCode) })) });
    return plan.blockers.length ? 1 : 0;
  }

  if (cmd === 'deployment' && sub === 'verify') {
    const m = readJson(pos[2], 'manifest');
    const p = BUILTIN_NETWORKS[m?.network?.id] ? { ...BUILTIN_NETWORKS[m.network.id], ...(flag('rpc') ? { evm: { ...BUILTIN_NETWORKS[m.network.id].evm, rpcUrl: flag('rpc')! } } : {}) } : network();
    let genesis: string | null | undefined;
    if (p.native && m.network.genesisHash && !flags.has('evm-only')) { try { const n = await NativeReader.connect(p.native.wsUrl, timeoutMs); genesis = n.api.genesisHash.toHex(); await n.disconnect(); } catch { genesis = null; } }
    const r = await verifyManifest(m, p, { expectedExecutor: flag('executor') as Hex | undefined, genesisHash: genesis });
    out(`${r.ok ? 'VERIFIED' : 'FAILED'} — ${p.name}, ${r.checks.filter((c) => c.status === 'pass').length}/${r.checks.length} checks passed\n${table(r.checks)}`, r);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'events' && sub === 'tail') {
    const follow = flags.has('follow');
    const limit = Number(flag('limit') ?? 20);
    if (flag('address')) {
      const p = network();
      const evm = new EvmReader(p.evm.rpcUrl, timeoutMs);
      let from = flag('from-block') ? Number(flag('from-block')) : Math.max(0, (await evm.blockNumber()) - 1000);
      do {
        const head = await evm.blockNumber();
        if (head >= from) {
          for (let a = from; a <= head; a += 5000) {
            const logs = await evm.logs({ fromBlock: a, toBlock: Math.min(head, a + 4999), address: flag('address') as Hex });
            for (const l of logs) out(`#${l.blockNumber} ${l.transactionHash} log ${l.logIndex} topic0 ${l.topics[0]}`, { source: 'rpc', ...l });
          }
          from = head + 1;
        }
        if (follow) await new Promise((r) => setTimeout(r, 4000));
      } while (follow);
      return 0;
    }
    const api = client();
    const pid = projectId();
    const first = await api.events(pid, { contract: flag('contract'), event: flag('event'), limit, sort: 'desc' });
    const show = (e: any) => out(`#${e.block_number} ${String(e.finality).padEnd(11)} ${String(e.contractAlias ?? e.address).padEnd(10)} ${e.event_name ?? '(undecoded)'} ${e.args ? JSON.stringify(e.args) : e.decode_error ?? ''}`, e);
    [...first.items].reverse().forEach(show);
    let last = first.items[0]?.seq ?? 0;
    while (follow) {
      await new Promise((r) => setTimeout(r, 3000));
      const p = await api.events(pid, { contract: flag('contract'), event: flag('event'), cursor: last, sort: 'asc', limit: 100 });
      p.items.forEach(show);
      if (p.items.length) last = p.items.at(-1).seq;
    }
    return 0;
  }

  if (cmd === 'workflow' && sub === 'validate') {
    const def = readJson(pos[2], 'workflow');
    const r = validateWorkflow(def);
    if (r.ok) out(`valid · ${r.definition.steps.length} steps · order ${r.order.join(' → ')}`, { ok: true, order: r.order });
    else out(`invalid:\n${r.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`, r);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'workflow' && sub === 'simulate') {
    const def = readJson(pos[2], 'workflow');
    const parse = (v: string | undefined) => (v === undefined ? {} : existsSync(v) ? JSON.parse(readFileSync(v, 'utf8')) : JSON.parse(v));
    const r = await client().simulateWorkflow(def, parse(flag('trigger')), parse(flag('stubs')));
    out(r.matched === false ? 'trigger filter did not match' : r.trace.map((s: any) => `${s.step.padEnd(12)} ${s.type.padEnd(14)} ${s.state.padEnd(15)} ${s.note ?? JSON.stringify(s.output ?? null)}`).join('\n'), r);
    return r.trace?.some((s: any) => s.state === 'failed') ? 1 : 0;
  }

  if (cmd === 'execution' && sub === 'inspect') {
    if (!pos[2]) throw new Exit(2, 'pf execution inspect <executionId>');
    const x = await client().execution(pos[2]);
    const lines = [`${x.id}\n  workflow ${x.workflow} v${x.version} (${x.definitionHash.slice(0, 12)}…) · state ${x.state}${x.error ? ` · ${x.error}` : ''}`, `  trigger ${x.trigger_type} ${x.trigger_key} · input ${x.input_hash.slice(0, 14)}…${x.replay_of ? ` · replay of ${x.replay_of}` : ''}`,
      ...x.steps.map((s: any) => `  ${s.state === 'succeeded' ? '✔' : s.state === 'failed' ? '✖' : s.state === 'skipped' ? '·' : '…'} ${s.step_id.padEnd(10)} ${s.type.padEnd(14)} ${s.state.padEnd(17)} attempts ${s.attempts}${s.reused_from ? ' (reused)' : ''}${s.error ? ` · ${s.error}` : ''}`),
      ...x.intents.map((i: any) => `  intent ${i.kind} ${i.state}${i.tx_hash ? ` tx ${i.tx_hash}` : ''} key ${i.idempotency_key}`),
      ...x.evidence.map((e: any) => `  evidence ${e.evidence_id} ${e.status} content ${e.content_hash}`)];
    out(lines.join('\n'), x);
    return ['failed', 'dead_letter'].includes(x.state) ? 1 : 0;
  }

  if (cmd === 'evidence' && sub === 'verify') {
    let input: { registry: Hex; evidenceId: Hex; content: unknown; expectedKind?: Hex };
    let p = network();
    if (pos[2]) {
      const e = await client().evidence(pos[2]); // content comes from the API; the check itself reads the chain directly
      if (!e.registry) throw new Exit(1, 'evidence is local-only (not registered on-chain)');
      p = BUILTIN_NETWORKS[e.network_id] ? { ...BUILTIN_NETWORKS[e.network_id], ...(flag('rpc') ? { evm: { ...BUILTIN_NETWORKS[e.network_id].evm, rpcUrl: flag('rpc')! } } : {}) } : p;
      input = { registry: e.registry, evidenceId: e.evidence_id, content: e.content, expectedKind: e.kind_hash };
    } else {
      if (!flag('registry') || !flag('id')) throw new Exit(2, 'pf evidence verify <evidenceId> | --registry 0x… --id 0x… --content <file>');
      input = { registry: flag('registry') as Hex, evidenceId: flag('id') as Hex, content: readJson(flag('content'), 'content') };
    }
    const r = await verifyEvidence(p, input);
    out(`${r.ok ? 'VERIFIED' : 'FAILED'} — local hash ${r.localHash}\n${table(r.checks)}\nNote: this proves the registry holds this hash from this writer; it does not prove the content is true.`, r);
    return r.ok ? 0 : 1;
  }

  throw new Exit(2, `unknown command: ${pos.join(' ')}\n\n${HELP}`);
}

main().then((code) => process.exit(code)).catch((e) => {
  if (e instanceof Exit) { if (asJson) console.log(JSON.stringify({ error: e.message })); else console.error(e.message); process.exit(e.code); }
  if (isPfError(e)) {
    const code = ['RPC_UNREACHABLE', 'RPC_ERROR', 'RPC_METHOD_MISSING'].includes(e.code) ? 4 : ['NOT_CONFIGURED', 'NOT_SUPPORTED'].includes(e.code) ? 3 : e.code === 'VERIFICATION_FAILED' || e.code === 'NETWORK_MISMATCH' ? 1 : 2;
    if (asJson) console.log(JSON.stringify({ error: e.toJSON() })); else console.error(`${e.code}: ${e.message}`);
    process.exit(code);
  }
  console.error((e as Error).message);
  process.exit(4);
});
void PfError;
