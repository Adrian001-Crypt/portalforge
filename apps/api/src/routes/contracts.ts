import { Hono } from 'hono';
import { z } from 'zod';
import { decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Hex } from 'viem';
import { PfError, hashCanonical, address as addressSchema, hex32, DeploymentManifest, JobRegistryAbi, EvidenceRegistryAbi, WorkflowExecutionRegistryAbi, CONTRACT_ARTIFACT_META } from '@portalforge/domain';
import { newId, now, json, parse } from '@portalforge/store';
import { EvmReader } from '@portalforge/portaldot-evm';
import { verifyManifest } from '@portalforge/sdk';
import { EvmIndexer, correlatedPairs } from '@portalforge/indexer';
import { type Env, requireProject, requireUser, audit, page } from '../context';

export const contracts = new Hono<Env>();

const MAX_ABI_ITEMS = 400;
/** ABIs are untrusted input: bounded size, only known item types, identifier-safe names. */
const AbiSchema = z.array(z.object({
  type: z.enum(['function', 'event', 'error', 'constructor', 'fallback', 'receive']),
  name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/).optional(),
}).passthrough()).max(MAX_ABI_ITEMS);

const profileFor = (c: any, networkId: string) => {
  const p = c.get('deps').networks.find((n: any) => n.id === networkId);
  if (!p) throw new PfError('NOT_CONFIGURED', `network ${networkId} not configured on this deployment`);
  return p;
};

function contractWithProject(c: any, cid: string, perm: Parameters<typeof requireProject>[2]) {
  const db = c.get('deps').db;
  const ct = db.get('SELECT * FROM contracts WHERE id = ?', cid);
  if (!ct) throw new PfError('NOT_FOUND', 'contract not found');
  const auth = requireProject(c, ct.project_id, perm);
  return { ct, ...auth };
}

contracts.get('/projects/:pid/contracts', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const { db } = c.get('deps');
  const rows = db.all(`SELECT c.*, a.abi_hash, (SELECT COUNT(*) FROM events e WHERE e.network_id = c.network_id AND e.address = c.address AND e.finality != 'orphaned') events,
      (SELECT COUNT(*) FROM events e WHERE e.network_id = c.network_id AND e.address = c.address AND e.decode_error IS NOT NULL) decode_errors
    FROM contracts c JOIN contract_abis a ON a.contract_id = c.id AND a.version = c.active_abi_version WHERE c.project_id = ? ORDER BY c.created_at`, project.id);
  return c.json({ items: rows.map((r) => ({ ...r, labels: parse(r.labels), compiler: parse(r.compiler), verification: parse(r.verification) })) });
});

const RegisterInput = z.object({
  alias: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/), address: addressSchema, runtime: z.enum(['evm', 'wasm']).default('evm'),
  abi: AbiSchema, deployBlock: z.number().int().nonnegative(), deployTx: hex32.optional(), sourceCommit: z.string().max(64).optional(),
  compiler: z.record(z.any()).optional(), labels: z.array(z.string().max(30)).max(10).default([]), responsible: z.string().max(60).optional(), notes: z.string().max(1000).default(''),
});

/** Register an existing contract. The address must hold code on the project network (checked live). */
contracts.post('/projects/:pid/contracts', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'resource.write');
  const b = RegisterInput.parse(await c.req.json());
  if (b.runtime === 'wasm') throw new PfError('NOT_SUPPORTED', 'WASM (pallet-contracts) registration is not implemented yet; see docs/network-capabilities.md');
  const profile = profileFor(c, project.network_id);
  const code = await new EvmReader(profile.evm.rpcUrl).code(b.address as Hex);
  if (code === '0x') throw new PfError('VALIDATION_FAILED', `no code at ${b.address} on ${profile.name}`);
  const { db } = c.get('deps');
  const id = newId('ctr');
  db.tx(() => {
    db.run(`INSERT INTO contracts (id, project_id, alias, network_id, runtime, address, deploy_block, deploy_tx, source_commit, compiler, labels, responsible, notes, verification, created_at, updated_at) VALUES (?, ?, ?, ?, 'evm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, project.id, b.alias, project.network_id, b.address.toLowerCase(), b.deployBlock, b.deployTx ?? null, b.sourceCommit ?? null, json(b.compiler ?? null), json(b.labels), b.responsible ?? null, b.notes, json({ runtimeCodeHash: keccak256(code), checkedAt: now(), source: 'registration' }), now(), now());
    db.run('INSERT INTO contract_abis (contract_id, version, abi, abi_hash, note, created_at) VALUES (?, 1, ?, ?, ?, ?)', id, json(b.abi), hashCanonical(b.abi), 'initial', now());
    audit(db, project.id, actor, 'contract.register', id, { alias: b.alias, address: b.address, deployBlock: b.deployBlock });
  });
  return c.json(db.get('SELECT * FROM contracts WHERE id = ?', id), 201);
});

const ROLE_READS: Record<string, { fn: string; args?: (exec: string) => unknown[] }[]> = {
  JobRegistry: [{ fn: 'owner' }, { fn: 'pendingOwner' }, { fn: 'executor' }, { fn: 'VERSION' }, { fn: 'jobCount' }],
  EvidenceRegistry: [{ fn: 'owner' }, { fn: 'pendingOwner' }, { fn: 'VERSION' }],
  WorkflowExecutionRegistry: [{ fn: 'owner' }, { fn: 'pendingOwner' }, { fn: 'VERSION' }],
};

/** Contract detail with live on-chain permission reads (separate from platform roles). */
contracts.get('/contracts/:cid', async (c) => {
  const { ct, role } = contractWithProject(c, c.req.param('cid'), 'project.read');
  const { db } = c.get('deps');
  const abis = db.all('SELECT version, abi, abi_hash, note, created_at FROM contract_abis WHERE contract_id = ? ORDER BY version', ct.id).map((a) => ({ ...a, abi: parse(a.abi) }));
  const abi = abis.find((a) => a.version === ct.active_abi_version)!.abi as Abi;
  const fnNames = new Set(abi.filter((x: any) => x.type === 'function').map((x: any) => x.name));
  const profile = profileFor(c, ct.network_id);
  const evm = new EvmReader(profile.evm.rpcUrl);
  const reads: { fn: string; value: unknown; error?: string }[] = [];
  const kind = Object.keys(ROLE_READS).find((k) => ROLE_READS[k].every((r) => fnNames.has(r.fn)));
  for (const r of kind ? ROLE_READS[kind] : [{ fn: 'owner' }].filter((x) => fnNames.has(x.fn))) {
    try {
      const data = encodeFunctionData({ abi, functionName: r.fn } as any);
      const ret = await evm.call_({ to: ct.address as Hex, data });
      reads.push({ fn: r.fn, value: JSON.parse(json(decodeFunctionResult({ abi, functionName: r.fn, data: ret } as any))!) });
    } catch (e) { reads.push({ fn: r.fn, value: null, error: (e as Error).message.slice(0, 200) }); }
  }
  const policies = db.all('SELECT function_name, max_calls_per_hour, max_fee_wei, enabled FROM contract_policies WHERE project_id = ? AND contract_alias = ?', ct.project_id, ct.alias);
  const members = role === 'public' ? [] : db.all('SELECT u.handle, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?', ct.project_id);
  const workerHb = db.all(`SELECT info FROM heartbeats WHERE service = 'worker'`).map((h) => parse<any>(h.info));
  return c.json({
    ...ct, labels: parse(ct.labels), compiler: parse(ct.compiler), verification: parse(ct.verification), abis, templateKind: kind ?? null,
    onchain: { reads, readAt: now(), source: `eth_call on ${profile.evm.rpcUrl}` },
    permissions: {
      platform: { note: 'Who can operate PortalForge for this project (application roles).', members },
      chain: { note: 'Who the contract itself authorises (read live from chain).', reads: reads.filter((r) => ['owner', 'pendingOwner', 'executor'].includes(r.fn)), executorPolicies: policies, executorsConfigured: workerHb.flatMap((h) => h?.executors ?? []) },
    },
  });
});

contracts.post('/contracts/:cid/abi', async (c) => {
  const { ct, actor } = contractWithProject(c, c.req.param('cid'), 'resource.write');
  const b = z.object({ abi: AbiSchema, note: z.string().max(200).default(''), activate: z.boolean().default(false) }).parse(await c.req.json());
  const { db, networks } = c.get('deps');
  const v = db.tx(() => {
    const version = (db.get('SELECT MAX(version) v FROM contract_abis WHERE contract_id = ?', ct.id)!.v ?? 0) + 1;
    db.run('INSERT INTO contract_abis (contract_id, version, abi, abi_hash, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', ct.id, version, json(b.abi), hashCanonical(b.abi), b.note, now());
    if (b.activate) db.run('UPDATE contracts SET active_abi_version = ?, updated_at = ? WHERE id = ?', version, now(), ct.id);
    audit(db, ct.project_id, actor, 'contract.abi.add', ct.id, { version, activate: b.activate });
    return version;
  });
  let redecoded = 0;
  if (b.activate) redecoded = new EvmIndexer(db, networks.find((n) => n.id === ct.network_id)!, null as any).redecode(ct.id);
  return c.json({ version: v, redecoded }, 201);
});

contracts.post('/contracts/:cid/abi/activate', async (c) => {
  const { ct, actor } = contractWithProject(c, c.req.param('cid'), 'resource.write');
  const { version } = z.object({ version: z.number().int().min(1) }).parse(await c.req.json());
  const { db, networks } = c.get('deps');
  if (!db.get('SELECT 1 FROM contract_abis WHERE contract_id = ? AND version = ?', ct.id, version)) throw new PfError('NOT_FOUND', 'ABI version not found');
  db.run('UPDATE contracts SET active_abi_version = ?, updated_at = ? WHERE id = ?', version, now(), ct.id);
  const redecoded = new EvmIndexer(db, networks.find((n) => n.id === ct.network_id)!, null as any).redecode(ct.id);
  audit(db, ct.project_id, actor, 'contract.abi.activate', ct.id, { version, redecoded });
  return c.json({ version, redecoded });
});

/** Read-only call of a view/pure function (eth_call). Writes go through wallet intents or the executor. */
contracts.post('/contracts/:cid/read', async (c) => {
  const { ct } = contractWithProject(c, c.req.param('cid'), 'project.read');
  const b = z.object({ function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), args: z.array(z.union([z.string().max(200), z.number(), z.boolean()])).max(10).default([]) }).parse(await c.req.json());
  const abi = parse<Abi>(c.get('deps').db.get('SELECT abi FROM contract_abis WHERE contract_id = ? AND version = ?', ct.id, ct.active_abi_version)!.abi)!;
  const fn = abi.filter((x: any) => x.type === 'function' && x.name === b.function) as any[];
  if (fn.length !== 1) throw new PfError('VALIDATION_FAILED', 'function not found or overloaded');
  if (!['view', 'pure'].includes(fn[0].stateMutability)) throw new PfError('POLICY_DENIED', 'only view/pure functions can be read here');
  const args = fn[0].inputs.map((inp: any, i: number) => (/int/.test(inp.type) ? BigInt(String(b.args[i])) : b.args[i]));
  const data = encodeFunctionData({ abi, functionName: b.function, args } as any);
  const profile = profileFor(c, ct.network_id);
  const ret = await new EvmReader(profile.evm.rpcUrl).call_({ to: ct.address as Hex, data });
  return c.json({ result: JSON.parse(json(decodeFunctionResult({ abi, functionName: b.function, data: ret } as any))!), block: 'latest', source: 'eth_call' });
});

// ------------------------------------------------------------------ events

contracts.get('/projects/:pid/events', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const q = c.req.query();
  const { limit, cursor } = page(q);
  const { db } = c.get('deps');
  const addrs = db.all('SELECT alias, address FROM contracts WHERE project_id = ?', project.id);
  if (!addrs.length) return c.json({ items: [], nextCursor: null });
  const alias = new Map(addrs.map((a) => [a.address, a.alias]));
  const where: string[] = ['e.network_id = ?', `e.address IN (${addrs.map(() => '?').join(',')})`];
  const params: any[] = [project.network_id, ...addrs.map((a) => a.address)];
  if (q.contract) { const a = addrs.find((x) => x.alias === q.contract); where.push('e.address = ?'); params.push(a?.address ?? '-'); }
  if (q.event) { where.push('e.event_name = ?'); params.push(q.event); }
  if (q.interface) { where.push('e.interface = ?'); params.push(q.interface); }
  if (q.finality) { where.push('e.finality = ?'); params.push(q.finality); }
  if (q.decodeErrors === '1') where.push('e.decode_error IS NOT NULL');
  if (q.fromBlock) { where.push('e.block_number >= ?'); params.push(Number(q.fromBlock)); }
  if (q.toBlock) { where.push('e.block_number <= ?'); params.push(Number(q.toBlock)); }
  if (q.q) { where.push('(e.tx_hash = ? OR e.block_hash = ? OR e.id = ?)'); params.push(q.q.toLowerCase(), q.q.toLowerCase(), q.q); }
  const order = q.sort === 'asc' ? 'ASC' : 'DESC';
  if (cursor !== null) { where.push(order === 'DESC' ? 'e.seq < ?' : 'e.seq > ?'); params.push(cursor); }
  const rows = db.all(`SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY e.seq ${order} LIMIT ?`, ...params, limit);
  return c.json({ items: rows.map((r) => ({ ...r, contractAlias: alias.get(r.address) ?? null, args: parse(r.args), raw: parse(r.raw) })), nextCursor: rows.length === limit ? rows.at(-1)!.seq : null });
});

contracts.get('/events/:id', (c) => {
  const { db } = c.get('deps');
  const e = db.get('SELECT * FROM events WHERE id = ?', c.req.param('id'));
  if (!e) throw new PfError('NOT_FOUND', 'event not found');
  const ct = db.get('SELECT project_id, alias FROM contracts WHERE network_id = ? AND address = ?', e.network_id, e.address);
  if (!ct) throw new PfError('NOT_FOUND', 'event not found');
  requireProject(c, ct.project_id, 'project.read');
  const pair = e.correlation_key ? db.all('SELECT id, interface, block_hash, raw FROM events WHERE correlation_key = ? AND id != ?', e.correlation_key, e.id).map((p) => ({ ...p, raw: parse(p.raw) })) : [];
  const nativeRaw = e.interface === 'native' ? parse<any>(e.raw) : pair.find((p) => p.interface === 'native')?.raw;
  const evmHash = e.interface === 'evm' ? e.block_hash : pair.find((p) => p.interface === 'evm')?.block_hash;
  const triggered = db.all(`SELECT x.id, x.state, w.name FROM executions x JOIN workflows w ON w.id = x.workflow_id WHERE x.trigger_key = ?`, e.id);
  return c.json({
    ...e, contractAlias: ct.alias, args: parse(e.args), raw: parse(e.raw), triggered,
    correlation: pair.length ? { pairs: pair.map((p) => ({ id: p.id, interface: p.interface })), rule: 'same block number, contract, topics, data and ordinal; EVM block hash must equal reviveApi.ethBlockHash(n)', verified: !!nativeRaw?.ethBlockHash && !!evmHash && nativeRaw.ethBlockHash.toLowerCase() === evmHash.toLowerCase() } : { pairs: [], rule: 'no matching observation on the other interface (relationship unknown)', verified: false },
  });
});

contracts.get('/projects/:pid/indexer', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const { db } = c.get('deps');
  const addrs = db.all('SELECT alias, address FROM contracts WHERE project_id = ?', project.id);
  const streams = db.all(`SELECT * FROM cursors WHERE network_id = ? AND (interface = 'native' OR address IN (${addrs.map(() => '?').join(',') || "''"}))`, project.network_id, ...addrs.map((a) => a.address))
    .map((s) => ({ ...s, alias: addrs.find((a) => a.address === s.address)?.alias ?? null, indexedTo: s.next_block - 1, lag: s.head_seen != null ? Math.max(0, s.head_seen - (s.next_block - 1)) : null, coverage: { from: s.start_block, to: s.next_block - 1 } }));
  return c.json({ networkId: project.network_id, streams, correlations: correlatedPairs(db, project.network_id, 20), observedAt: now() });
});


/** Register (or refresh verification of) every contract in a verified manifest under template aliases. */
function registerManifestContracts(db: any, project: any, m: any, mh: string) {
  const aliases: Record<string, string> = { JobRegistry: 'jobs', EvidenceRegistry: 'evidence', WorkflowExecutionRegistry: 'workflow-registry' };
  const abis: Record<string, unknown> = { JobRegistry: JobRegistryAbi, EvidenceRegistry: EvidenceRegistryAbi, WorkflowExecutionRegistry: WorkflowExecutionRegistryAbi };
  for (const ct of m.contracts) {
    const verification = json({ runtimeCodeHash: ct.runtimeCodeHash, artifactRuntimeHash: ct.artifactRuntimeHash, manifestHash: mh, checkedAt: now(), source: 'manifest' });
    const sameAddr = db.get('SELECT id FROM contracts WHERE project_id = ? AND address = ?', project.id, ct.address.toLowerCase());
    if (sameAddr) { db.run('UPDATE contracts SET verification = ?, deploy_tx = ?, deploy_block = ?, source_commit = ?, updated_at = ? WHERE id = ?', verification, ct.deployTx, ct.deployBlock, m.source.commit, now(), sameAddr.id); continue; }
    let alias = aliases[ct.name] ?? ct.name.toLowerCase();
    for (let i = 2; db.get('SELECT 1 FROM contracts WHERE project_id = ? AND alias = ?', project.id, alias); i++) alias = `${aliases[ct.name] ?? ct.name.toLowerCase()}-${i}`;
    const cid = newId('ctr');
    db.run(`INSERT INTO contracts (id, project_id, alias, network_id, runtime, address, deploy_block, deploy_tx, source_commit, compiler, labels, verification, created_at, updated_at) VALUES (?, ?, ?, ?, 'evm', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cid, project.id, alias, project.network_id, ct.address.toLowerCase(), ct.deployBlock, ct.deployTx, m.source.commit, json(m.compiler), json(['template', ct.name]), verification, now(), now());
    const abi = abis[ct.name] ?? [];
    db.run('INSERT INTO contract_abis (contract_id, version, abi, abi_hash, note, created_at) VALUES (?, 1, ?, ?, ?, ?)', cid, json(abi), hashCanonical(abi), 'from template', now());
  }
}

// ------------------------------------------------------------------ templates & deployments

const TEMPLATES = [
  { name: 'JobRegistry', title: 'DemoService / JobRegistry', abi: JobRegistryAbi, description: 'Deterministic job queue: requestJob emits JobRequested; one executor completes each job once (executionId recorded).', constructor: ['owner', 'executor'] },
  { name: 'EvidenceRegistry', title: 'EvidenceRegistry', abi: EvidenceRegistryAbi, description: 'Binds content hashes to evidence ids; one commitment slot per id; writer-only revocation.', constructor: ['owner', 'writer'] },
  { name: 'WorkflowExecutionRegistry', title: 'WorkflowExecutionRegistry', abi: WorkflowExecutionRegistryAbi, description: 'Immutable workflow version anchors and one outcome commitment per execution.', constructor: ['owner', 'recorder'] },
];
contracts.get('/templates', async (c) => {
  const { readFileSync, existsSync } = await import('node:fs');
  return c.json({ items: TEMPLATES.map((t) => {
    const p = `contracts/evm/out/${t.name}.sol/${t.name}.json`;
    const bytecode = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).bytecode.object : null;
    return { ...t, meta: (CONTRACT_ARTIFACT_META as any)[t.name], bytecode, compiled: !!bytecode };
  }) });
});

contracts.get('/projects/:pid/deployments', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const rows = c.get('deps').db.all('SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC', project.id);
  return c.json({ items: rows.map((r) => ({ ...r, manifest: parse(r.manifest), verification: parse(r.verification) })) });
});

contracts.get('/deployments/:id', (c) => {
  const d = c.get('deps').db.get('SELECT * FROM deployments WHERE id = ?', c.req.param('id'));
  if (!d) throw new PfError('NOT_FOUND', 'deployment not found');
  requireProject(c, d.project_id, 'project.read');
  return c.json({ ...d, manifest: parse(d.manifest), verification: parse(d.verification) });
});

/** Import a deployment manifest: verified live against the chain, then its contracts are registered. */
contracts.post('/projects/:pid/deployments', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'resource.write');
  const body = await c.req.json();
  const m = DeploymentManifest.parse(body.manifest);
  const profile = profileFor(c, project.network_id);
  if (m.network.id !== project.network_id) throw new PfError('NETWORK_MISMATCH', `manifest is for ${m.network.id}, project uses ${project.network_id}`);
  const report = await verifyManifest(m, profile, { expectedExecutor: body.expectedExecutor });
  const { db } = c.get('deps');
  const id = newId('dep');
  const mh = hashCanonical(m);
  db.tx(() => {
    db.run(`INSERT INTO deployments (id, project_id, network_id, manifest, manifest_hash, verification, verified_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, manifest_hash) DO UPDATE SET verification = excluded.verification, verified_at = excluded.verified_at, status = excluded.status`,
      id, project.id, m.network.id, json(m), mh, json(report), now(), report.ok ? 'verified' : 'failed', now());
    if (report.ok && body.register !== false) registerManifestContracts(db, project, m, mh);
    audit(db, project.id, actor, 'deployment.import', id, { ok: report.ok, manifestHash: mh });
  });
  return c.json({ id: db.get('SELECT id FROM deployments WHERE project_id = ? AND manifest_hash = ?', project.id, mh)!.id, verification: report }, 201);
});

contracts.post('/deployments/:id/verify', async (c) => {
  const { db } = c.get('deps');
  const d = db.get('SELECT * FROM deployments WHERE id = ?', c.req.param('id'));
  if (!d) throw new PfError('NOT_FOUND', 'deployment not found');
  const { actor } = requireProject(c, d.project_id, 'resource.write');
  const report = await verifyManifest(parse(d.manifest), profileFor(c, d.network_id));
  db.run('UPDATE deployments SET verification = ?, verified_at = ?, status = ? WHERE id = ?', json(report), now(), report.ok ? 'verified' : 'failed', d.id);
  audit(db, d.project_id, actor, 'deployment.verify', d.id, { ok: report.ok });
  return c.json(report);
});

// ------------------------------------------------------------------ browser wallet intents

const IntentInput = z.object({
  kind: z.enum(['deploy', 'call']), chainId: z.number().int(), from: addressSchema, to: addressSchema.optional(),
  contractAlias: z.string().optional(), functionName: z.string().optional(), args: z.array(z.any()).max(10).optional(),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/).max(100_000), note: z.string().max(200).optional(),
});

/**
 * Step 1 of a browser-signed transaction: persist the intent BEFORE the wallet opens. If this request
 * fails, the UI must not open the wallet. Only one open intent per (project, from) at a time.
 */
contracts.post('/projects/:pid/wallet-intents', async (c) => {
  const u = requireUser(c);
  const { project, actor } = requireProject(c, c.req.param('pid'), 'workflow.run');
  const b = IntentInput.parse(await c.req.json());
  const profile = profileFor(c, project.network_id);
  if (b.chainId !== profile.evm.chainId) throw new PfError('NETWORK_MISMATCH', `wallet is on chain ${b.chainId}; project network expects ${profile.evm.chainId}`);
  if (b.kind === 'call') {
    const ct = c.get('deps').db.get('SELECT address FROM contracts WHERE project_id = ? AND alias = ?', project.id, b.contractAlias ?? '');
    if (!ct || ct.address !== b.to?.toLowerCase()) throw new PfError('POLICY_DENIED', 'call target must be a registered contract of this project');
  }
  const { db } = c.get('deps');
  const t = Date.now();
  const evm = new EvmReader(profile.evm.rpcUrl);
  const [nonce, balance] = await Promise.all([evm.nonce(b.from as Hex, 'pending'), evm.balance(b.from as Hex)]); // RPC failure → 502, wallet stays closed
  const id = newId('wit');
  db.tx(() => {
    db.run(`UPDATE wallet_intents SET state = 'expired', updated_at = ? WHERE project_id = ? AND from_address = ? AND state = 'awaiting_signature' AND expires_at < ?`, now(), project.id, b.from.toLowerCase(), t);
    const open = db.get(`SELECT id FROM wallet_intents WHERE project_id = ? AND from_address = ? AND state = 'awaiting_signature'`, project.id, b.from.toLowerCase());
    if (open) throw new PfError('CONFLICT', `another signature request (${open.id}) is still open for this account — finish or cancel it first`, { openIntent: open.id });
    db.run(`INSERT INTO wallet_intents (id, project_id, user_id, kind, network_id, chain_id, from_address, to_address, contract_alias, function_name, args, data, data_hash, expected_nonce, state, note, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_signature', ?, ?, ?, ?)`, id, project.id, u.userId, b.kind, project.network_id, b.chainId, b.from.toLowerCase(), b.to?.toLowerCase() ?? null, b.contractAlias ?? null, b.functionName ?? null, json(b.args ?? []), b.data, keccak256(b.data as Hex), nonce, b.note ?? null, now(), now(), t + 5 * 60_000);
    audit(db, project.id, actor, 'wallet.intent', id, { kind: b.kind, to: b.to, fn: b.functionName });
  });
  return c.json({ id, expectedNonce: nonce, balance: balance.toString(), expiresAt: new Date(t + 5 * 60_000).toISOString() }, 201);
});

contracts.get('/projects/:pid/wallet-intents', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  return c.json({ items: c.get('deps').db.all('SELECT id, kind, from_address, to_address, contract_alias, function_name, args, state, tx_hash, error, note, deployment_id, created_at, updated_at FROM wallet_intents WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', project.id).map((r) => ({ ...r, args: parse(r.args) })) });
});

/** Step 2: the wallet answered. A hash moves the intent to submitted; 4001 → rejected; anything else → unknown (kept for recovery). */
contracts.patch('/wallet-intents/:id', async (c) => {
  const u = requireUser(c);
  const { db } = c.get('deps');
  const w = db.get('SELECT * FROM wallet_intents WHERE id = ?', c.req.param('id'));
  if (!w || w.user_id !== u.userId) throw new PfError('NOT_FOUND', 'intent not found');
  requireProject(c, w.project_id, 'workflow.run');
  const b = z.object({ txHash: hex32.optional(), outcome: z.enum(['submitted', 'rejected', 'unknown']), error: z.string().max(500).optional() }).parse(await c.req.json());
  if (b.outcome === 'submitted' && !b.txHash) throw new PfError('VALIDATION_FAILED', 'txHash required');
  if (!['awaiting_signature', 'unknown', 'expired'].includes(w.state)) throw new PfError('CONFLICT', `intent is ${w.state}`);
  db.run('UPDATE wallet_intents SET state = ?, tx_hash = COALESCE(?, tx_hash), error = ?, updated_at = ? WHERE id = ?', b.outcome, b.txHash?.toLowerCase() ?? null, b.error ?? null, now(), w.id);
  return c.json(db.get('SELECT * FROM wallet_intents WHERE id = ?', w.id));
});

/**
 * Reconcile an intent with the chain: receipt by hash; or, when the hash was never persisted, find a
 * mined tx from the same account with the intent's nonce and calldata. Replacement → 'replaced'.
 */
contracts.post('/wallet-intents/:id/refresh', async (c) => {
  requireUser(c); // reconciliation scans blocks over RPC; never on behalf of anonymous visitors
  const { db } = c.get('deps');
  const w = db.get('SELECT * FROM wallet_intents WHERE id = ?', c.req.param('id'));
  if (!w) throw new PfError('NOT_FOUND', 'intent not found');
  requireProject(c, w.project_id, 'project.read');
  const evm = new EvmReader(profileFor(c, w.network_id).evm.rpcUrl);
  const set = (state: string, extra: { txHash?: string | null; receipt?: unknown; error?: string | null } = {}) => db.run('UPDATE wallet_intents SET state = ?, tx_hash = COALESCE(?, tx_hash), receipt = COALESCE(?, receipt), error = ?, updated_at = ? WHERE id = ?', state, extra.txHash ?? null, extra.receipt ? json(extra.receipt) : null, extra.error ?? null, now(), w.id);
  if (['confirmed', 'failed', 'rejected', 'replaced'].includes(w.state)) return c.json(db.get('SELECT * FROM wallet_intents WHERE id = ?', w.id));
  let hash: string | null = w.tx_hash;
  if (!hash) {
    const latest = await evm.nonce(w.from_address, 'latest');
    if (latest > w.expected_nonce) {
      // The wallet signed and sent, but the hash never reached us. Search recent blocks for (from, nonce).
      const head = await evm.blockNumber();
      let found: any = null;
      for (let n = head; n > head - 200 && n >= 0 && !found; n--) {
        const b = await evm.raw<any>('eth_getBlockByNumber', [`0x${n.toString(16)}`, true]);
        if (b.ok && b.value) found = (b.value.transactions as any[]).find((t) => t.from?.toLowerCase() === w.from_address && Number.parseInt(t.nonce, 16) === w.expected_nonce) ?? null;
      }
      if (found && keccak256(found.input) === w.data_hash) { hash = found.hash.toLowerCase(); set('submitted', { txHash: hash, error: null }); }
      else if (found) set('replaced', { txHash: found.hash.toLowerCase(), error: 'the account nonce was used by a transaction with different calldata' });
      else set('unknown', { error: 'nonce consumed but the transaction was not found in the last 200 blocks' });
    } else if (Date.now() > w.expires_at && w.state === 'awaiting_signature') set('expired');
  }
  if (hash) {
    const r = await evm.receipt(hash as Hex);
    if (r) set(r.status === 'success' ? 'confirmed' : 'failed', { receipt: { blockNumber: r.blockNumber, blockHash: r.blockHash, status: r.status, contractAddress: r.contractAddress, gasUsed: r.gasUsed }, error: r.status === 'success' ? null : 'reverted' });
    else if (!(await evm.transaction(hash as Hex))) {
      const latest = await evm.nonce(w.from_address, 'latest');
      if (latest > w.expected_nonce) set('replaced', { error: `nonce ${w.expected_nonce} was used by another transaction (replaced or cancelled in wallet)` });
    }
  }
  return c.json(db.get('SELECT * FROM wallet_intents WHERE id = ?', w.id));
});

// ------------------------------------------------------------------ deployment workbench

/** Plan one template deploy for a wallet: live simulation, runtime match, fee and exact storage deposit. */
contracts.post('/projects/:pid/deploy/plan', async (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const b = z.object({ template: z.enum(['JobRegistry', 'EvidenceRegistry', 'WorkflowExecutionRegistry']), from: addressSchema, executor: addressSchema }).parse(await c.req.json());
  const profile = profileFor(c, project.network_id);
  const { loadFoundryArtifact, planDeployment } = await import('@portalforge/sdk');
  const { NativeReader } = await import('@portalforge/portaldot-native');
  const art = loadFoundryArtifact('contracts/evm/out', b.template);
  const native = profile.native ? await NativeReader.connect(profile.native.wsUrl, 15_000).catch(() => null) : null;
  try {
    const plan = await planDeployment(profile, { deployer: b.from as Hex, executor: b.executor as Hex, artifacts: [art], native });
    const pc = plan.contracts[0];
    return c.json({ network: { id: profile.id, chainId: plan.chainId }, from: b.from, balance: plan.deployerBalance?.toString() ?? null, gasPrice: plan.gasPrice.toString(),
      template: b.template, constructorArgs: pc.args, initCode: pc.initCode, initCodeHash: keccak256(pc.initCode), runtimeBytes: art.runtimeBytes, artifactRuntimeHash: art.artifactRuntimeHash, abiHash: art.abiHash, compiler: art.compiler,
      simulation: pc.simulation, gas: pc.gas?.toString() ?? null, maxFee: pc.fee?.toString() ?? null,
      deposit: pc.deposit ? { ok: pc.deposit.ok, amount: pc.deposit.storageDeposit?.toString() ?? null, decimals: profile.native?.token.decimals, symbol: profile.native?.token.symbol, error: pc.deposit.error } : null,
      blockers: plan.blockers, warnings: plan.warnings, plannedAt: plan.createdAt });
  } finally { await native?.disconnect().catch(() => {}); }
});

/**
 * After a wallet-signed deploy confirms: build a manifest from the receipt, verify it live, register the contract.
 * Works from what the intent recorded, so it can be finished after a reload. Repeating it returns the same record.
 */
contracts.post('/wallet-intents/:id/manifest', async (c) => {
  const { db } = c.get('deps');
  const w = db.get('SELECT * FROM wallet_intents WHERE id = ?', c.req.param('id'));
  if (!w || w.kind !== 'deploy') throw new PfError('NOT_FOUND', 'deploy intent not found');
  const { project, actor } = requireProject(c, w.project_id, 'resource.write');
  if (w.state !== 'confirmed') throw new PfError('CONFLICT', `intent is ${w.state}; refresh it first`);
  const existing = () => { const id = db.get('SELECT deployment_id id FROM wallet_intents WHERE id = ?', w.id)?.id; const d = id ? db.get('SELECT * FROM deployments WHERE id = ?', id) : null; return d ? c.json({ deploymentId: d.id, manifest: parse(d.manifest), verification: parse(d.verification), alreadyRegistered: true }) : null; };
  const done = existing();
  if (done) return done;
  const b = z.object({ template: z.enum(['JobRegistry', 'EvidenceRegistry', 'WorkflowExecutionRegistry']), constructorArgs: z.array(z.string()) }).parse({ template: w.function_name, constructorArgs: parse(w.args), ...(await c.req.json().catch(() => ({}))) });
  const profile = profileFor(c, project.network_id);
  const evm = new EvmReader(profile.evm.rpcUrl);
  const r = await evm.receipt(w.tx_hash);
  if (!r?.contractAddress) throw new PfError('VERIFICATION_FAILED', 'receipt has no contractAddress');
  const { loadFoundryArtifact, manifestContract } = await import('@portalforge/sdk');
  const art = loadFoundryArtifact('contracts/evm/out', b.template);
  const { encodeDeployData } = await import('viem');
  if (keccak256(encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: b.constructorArgs } as any)) !== w.data_hash) throw new PfError('VERIFICATION_FAILED', 'signed calldata does not match this template + constructor args');
  const code = await evm.code(r.contractAddress);
  const { execSync } = await import('node:child_process');
  const git = (cmd: string) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
  const commit = git('git rev-parse HEAD') ?? 'unknown';
  const manifest = {
    schema: 'portalforge.deployment/v1' as const,
    network: { id: profile.id, chainId: profile.evm.chainId, ...(profile.native ? { genesisHash: profile.native.genesisHash, specName: profile.native.specName } : {}) },
    source: { repo: 'portalforge', commit, dirty: git('git status --porcelain') !== '' }, compiler: art.compiler,
    contracts: [manifestContract(art, b.constructorArgs as Hex[], { address: r.contractAddress, txHash: r.transactionHash, blockNumber: r.blockNumber, blockHash: r.blockHash, deployer: w.from_address, runtimeCodeHash: keccak256(code) })],
    createdAt: now(), notes: ['Deployed from the PortalForge Deployment Workbench with a browser wallet.'],
  };
  const report = await verifyManifest(manifest, profile, { expectedExecutor: b.constructorArgs[1] as Hex });
  const mh = hashCanonical(manifest);
  const did = newId('dep');
  const raced = db.tx(() => {
    if (db.get('SELECT deployment_id id FROM wallet_intents WHERE id = ?', w.id)?.id) return true; // a concurrent request finished first
    db.run(`INSERT INTO deployments (id, project_id, network_id, manifest, manifest_hash, verification, verified_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, did, project.id, profile.id, json(manifest), mh, json(report), now(), report.ok ? 'verified' : 'failed', now());
    db.run('UPDATE wallet_intents SET deployment_id = ?, updated_at = ? WHERE id = ?', did, now(), w.id);
    if (report.ok) registerManifestContracts(db, project, manifest, mh);
    return false;
  });
  if (raced) return existing()!;
  audit(db, project.id, actor, 'deployment.browser', did, { tx: w.tx_hash, ok: report.ok });
  return c.json({ deploymentId: did, manifest, verification: report }, 201);
});
