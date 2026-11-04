import { Hono } from 'hono';
import { z } from 'zod';
import { PfError, API_SCOPES, ROLES, hashCanonical, validateWorkflow, address as addressSchema } from '@portalforge/domain';
import { newId, now, json, parse, randomToken, sha256 } from '@portalforge/store';
import { parseConnectorUrl, assertPublicTarget } from '@portalforge/workflow-engine';
import { retryDelivery } from '@portalforge/ops';
import { type Env, requireUser, requireProject, audit, page } from '../context';

export const projects = new Hono<Env>();

const ProjectInput = z.object({
  name: z.string().min(2).max(60),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  description: z.string().max(500).default(''),
  environment: z.enum(['development', 'testnet', 'demo']),
  networkId: z.string(),
  visibility: z.enum(['private', 'public_readonly']).default('private'),
});

projects.get('/', (c) => {
  const { db } = c.get('deps');
  const p = c.get('principal');
  const mine = p.type === 'user' ? db.all(`SELECT p.*, m.role FROM projects p JOIN members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC`, p.userId) : [];
  const keyProject = p.type === 'apikey' ? db.all(`SELECT p.*, 'apikey' role FROM projects p WHERE p.id = ?`, p.projectId) : [];
  const pub = db.all(`SELECT p.*, 'public' role FROM projects p WHERE p.visibility = 'public_readonly'`).filter((x) => !mine.some((m) => m.id === x.id));
  const rows = [...mine, ...keyProject, ...(c.get('deps').publicReadOnly || p.type === 'user' ? pub : [])];
  return c.json({ items: rows.map((r) => ({ ...r, stats: projectStats(db, r.id) })) });
});

function projectStats(db: any, id: string) {
  return {
    contracts: db.get('SELECT COUNT(*) n FROM contracts WHERE project_id = ?', id).n,
    workflows: db.get('SELECT COUNT(*) n FROM workflows WHERE project_id = ?', id).n,
    executions: db.get('SELECT COUNT(*) n FROM executions WHERE project_id = ?', id).n,
    openIncidents: db.get(`SELECT COUNT(*) n FROM incidents WHERE project_id = ? AND state != 'resolved'`, id).n,
  };
}

projects.post('/', async (c) => {
  const u = requireUser(c);
  const { db, networks } = c.get('deps');
  const b = ProjectInput.parse(await c.req.json());
  if (!networks.some((n) => n.id === b.networkId)) throw new PfError('VALIDATION_FAILED', `network ${b.networkId} is not configured on this deployment`);
  if (db.get('SELECT 1 FROM projects WHERE slug = ?', b.slug)) throw new PfError('CONFLICT', 'slug already taken');
  const id = newId('prj');
  db.tx(() => {
    db.run(`INSERT INTO projects (id, slug, name, description, environment, visibility, network_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, b.slug, b.name, b.description, b.environment, b.visibility, b.networkId, u.userId, now(), now());
    db.run(`INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)`, id, u.userId, now());
    audit(db, id, `user:${u.handle}`, 'project.create', id, b);
  });
  return c.json(db.get('SELECT * FROM projects WHERE id = ?', id), 201);
});

projects.get('/:pid', (c) => {
  const { project, role } = requireProject(c, c.req.param('pid'), 'project.read');
  const { db } = c.get('deps');
  return c.json({ ...project, role, stats: projectStats(db, project.id), members: role === 'public' ? [] : db.all('SELECT u.handle, m.role, m.added_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?', project.id) });
});

projects.patch('/:pid', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'project.update');
  const b = ProjectInput.partial().omit({ slug: true, networkId: true }).parse(await c.req.json());
  const { db } = c.get('deps');
  db.run(`UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), environment = COALESCE(?, environment), visibility = COALESCE(?, visibility), updated_at = ? WHERE id = ?`, b.name, b.description, b.environment, b.visibility, now(), project.id);
  audit(db, project.id, actor, 'project.update', project.id, b);
  return c.json(db.get('SELECT * FROM projects WHERE id = ?', project.id));
});

projects.post('/:pid/members', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'project.members');
  const b = z.object({ handle: z.string(), role: z.enum(ROLES) }).parse(await c.req.json());
  const { db } = c.get('deps');
  const u = db.get('SELECT * FROM users WHERE handle = ?', b.handle);
  if (!u) throw new PfError('NOT_FOUND', 'user has not signed in yet');
  db.tx(() => {
    db.run('INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET role = excluded.role', project.id, u.id, b.role, now());
    const owners = db.get(`SELECT COUNT(*) n FROM members WHERE project_id = ? AND role = 'owner'`, project.id)!.n;
    if (owners < 1) throw new PfError('CONFLICT', 'a project needs at least one owner');
    audit(db, project.id, actor, 'member.set', b.handle, b);
  });
  return c.json({ ok: true });
});

projects.delete('/:pid/members/:handle', (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'project.members');
  const { db } = c.get('deps');
  db.tx(() => {
    db.run('DELETE FROM members WHERE project_id = ? AND user_id = (SELECT id FROM users WHERE handle = ?)', project.id, c.req.param('handle'));
    if (db.get(`SELECT COUNT(*) n FROM members WHERE project_id = ? AND role = 'owner'`, project.id)!.n < 1) throw new PfError('CONFLICT', 'a project needs at least one owner');
    audit(db, project.id, actor, 'member.remove', c.req.param('handle'));
  });
  return c.json({ ok: true });
});

projects.get('/:pid/audit', (c) => {
  const { project, role } = requireProject(c, c.req.param('pid'), 'project.read');
  if (role === 'public') throw new PfError('FORBIDDEN', 'audit log is visible to members only');
  const { limit, cursor } = page(c.req.query());
  const items = c.get('deps').db.all(`SELECT * FROM audit_log WHERE project_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`, project.id, cursor, cursor, limit);
  return c.json({ items: items.map((r) => ({ ...r, detail: parse(r.detail) })), nextCursor: items.length === limit ? items.at(-1)!.id : null });
});

/** Export: configuration only. No sessions, API key hashes, intents with signed txs, or executor material. */
projects.get('/:pid/export', (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'project.export');
  const { db } = c.get('deps');
  const contracts = db.all(`SELECT c.alias, c.network_id, c.runtime, c.address, c.deploy_block, c.deploy_tx, c.source_commit, c.labels, c.notes, a.abi FROM contracts c JOIN contract_abis a ON a.contract_id = c.id AND a.version = c.active_abi_version WHERE c.project_id = ?`, project.id)
    .map((r) => ({ ...r, labels: parse(r.labels), abi: parse(r.abi) }));
  const workflows = db.all(`SELECT w.name, w.enabled, v.version, v.definition, v.definition_hash FROM workflows w LEFT JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.active_version WHERE w.project_id = ?`, project.id).map((r) => ({ ...r, definition: parse(r.definition) }));
  const connectors = db.all('SELECT name, url, query_url FROM connectors WHERE project_id = ?', project.id);
  const policies = db.all('SELECT contract_alias, function_name, max_calls_per_hour, max_fee_wei, enabled FROM contract_policies WHERE project_id = ?', project.id);
  const body = { schema: 'portalforge.project/v1', project: { name: project.name, slug: project.slug, description: project.description, environment: project.environment, networkId: project.network_id }, contracts, workflows, connectors, policies, exportedAt: now() };
  audit(db, project.id, actor, 'project.export', project.id);
  return c.json({ ...body, contentHash: hashCanonical(body) });
});

const ImportSchema = z.object({
  schema: z.literal('portalforge.project/v1'),
  contracts: z.array(z.object({ alias: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/), network_id: z.string(), runtime: z.enum(['evm', 'wasm']), address: addressSchema, deploy_block: z.number().int().nonnegative(), deploy_tx: z.string().nullable().optional(), abi: z.array(z.any()).max(500) })).max(50),
  workflows: z.array(z.object({ name: z.string(), definition: z.any() })).max(50),
  connectors: z.array(z.object({ name: z.string(), url: z.string(), query_url: z.string().nullable().optional() })).max(20),
  policies: z.array(z.object({ contract_alias: z.string(), function_name: z.string(), max_calls_per_hour: z.number().int().min(1).max(1000), max_fee_wei: z.string().regex(/^\d+$/) })).max(50),
});

/** Validate a project config without applying it; returns every issue found. */
projects.post('/:pid/import/validate', async (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'resource.write');
  const r = ImportSchema.safeParse(await c.req.json());
  if (!r.success) return c.json({ ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const issues: { path: string; message: string }[] = [];
  r.data.contracts.forEach((ct, i) => { if (ct.network_id !== project.network_id) issues.push({ path: `contracts.${i}.network_id`, message: `project network is ${project.network_id}` }); });
  r.data.workflows.forEach((w, i) => { const v = validateWorkflow(w.definition); if (!v.ok) v.issues.forEach((x) => issues.push({ path: `workflows.${i}.${x.path}`, message: x.message })); });
  r.data.connectors.forEach((cn, i) => { try { parseConnectorUrl(cn.url); } catch (e) { issues.push({ path: `connectors.${i}.url`, message: (e as Error).message }); } });
  return c.json({ ok: issues.length === 0, issues });
});

// ---- API keys
projects.get('/:pid/api-keys', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'apikey.manage');
  return c.json({ items: c.get('deps').db.all('SELECT id, name, prefix, scopes, created_by, created_at, revoked_at, last_used_at FROM api_keys WHERE project_id = ? ORDER BY created_at DESC', project.id).map((k) => ({ ...k, scopes: parse(k.scopes) })) });
});
projects.post('/:pid/api-keys', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'apikey.manage');
  const b = z.object({ name: z.string().min(1).max(60), scopes: z.array(z.enum(API_SCOPES)).min(1) }).parse(await c.req.json());
  const prefix = randomToken(4).replace(/[^a-zA-Z0-9]/g, 'x').slice(0, 6);
  const secret = `pf_${prefix}_${randomToken(24)}`;
  const id = newId('key');
  const { db } = c.get('deps');
  db.run('INSERT INTO api_keys (id, project_id, name, key_hash, prefix, scopes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, project.id, b.name, sha256(secret), prefix, json(b.scopes), actor, now());
  audit(db, project.id, actor, 'apikey.create', id, { name: b.name, scopes: b.scopes });
  return c.json({ id, secret, note: 'Shown once. Store it in your secret manager.' }, 201);
});
projects.delete('/:pid/api-keys/:kid', (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'apikey.manage');
  const { db } = c.get('deps');
  db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ?', now(), c.req.param('kid'), project.id);
  audit(db, project.id, actor, 'apikey.revoke', c.req.param('kid'));
  return c.json({ ok: true });
});

// ---- connectors (webhook targets)
projects.get('/:pid/connectors', (c) => {
  const { project, role } = requireProject(c, c.req.param('pid'), 'project.read');
  if (role === 'public') throw new PfError('FORBIDDEN', 'connector targets are visible to project members only');
  return c.json({ items: c.get('deps').db.all('SELECT id, name, url, query_url, allow_private_host, created_at FROM connectors WHERE project_id = ?', project.id) });
});
projects.post('/:pid/connectors', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'resource.write');
  const deps = c.get('deps');
  const b = z.object({ name: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/), url: z.string().max(500), queryUrl: z.string().max(500).nullable().optional(), allowPrivateHost: z.boolean().default(false) }).parse(await c.req.json());
  if (b.allowPrivateHost && !deps.allowPrivateConnectors) throw new PfError('UNSAFE_TARGET', 'private-network connectors are disabled on this deployment');
  await assertPublicTarget(b.url, b.allowPrivateHost);
  if (b.queryUrl) await assertPublicTarget(b.queryUrl, b.allowPrivateHost);
  deps.db.run(`INSERT INTO connectors (id, project_id, name, url, query_url, allow_private_host, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, name) DO UPDATE SET url = excluded.url, query_url = excluded.query_url, allow_private_host = excluded.allow_private_host`, newId('con'), project.id, b.name, b.url, b.queryUrl ?? null, b.allowPrivateHost, now());
  audit(deps.db, project.id, actor, 'connector.set', b.name, { url: b.url, queryUrl: b.queryUrl, allowPrivateHost: b.allowPrivateHost });
  return c.json({ ok: true }, 201);
});

// ---- executor policies (allowlist for contract writes)
projects.get('/:pid/policies', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  return c.json({ items: c.get('deps').db.all('SELECT * FROM contract_policies WHERE project_id = ?', project.id) });
});
projects.post('/:pid/policies', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'resource.write');
  const b = z.object({ contractAlias: z.string(), functionName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), maxCallsPerHour: z.number().int().min(1).max(1000), maxFeeWei: z.string().regex(/^\d{1,30}$/), enabled: z.boolean().default(true) }).parse(await c.req.json());
  const { db } = c.get('deps');
  const ct = db.get(`SELECT a.abi FROM contracts c JOIN contract_abis a ON a.contract_id = c.id AND a.version = c.active_abi_version WHERE c.project_id = ? AND c.alias = ?`, project.id, b.contractAlias);
  if (!ct) throw new PfError('NOT_FOUND', 'contract alias not registered');
  const fn = parse<any[]>(ct.abi)!.filter((x) => x.type === 'function' && x.name === b.functionName);
  if (fn.length !== 1) throw new PfError('VALIDATION_FAILED', 'function must exist exactly once in the ABI');
  if (['view', 'pure', 'payable'].includes(fn[0].stateMutability)) throw new PfError('POLICY_DENIED', `only nonpayable functions can be allowlisted (got ${fn[0].stateMutability})`);
  db.run(`INSERT INTO contract_policies (id, project_id, contract_alias, function_name, max_calls_per_hour, max_fee_wei, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, contract_alias, function_name) DO UPDATE SET max_calls_per_hour = excluded.max_calls_per_hour, max_fee_wei = excluded.max_fee_wei, enabled = excluded.enabled`, newId('pol'), project.id, b.contractAlias, b.functionName, b.maxCallsPerHour, b.maxFeeWei, b.enabled, now());
  audit(db, project.id, actor, 'policy.set', `${b.contractAlias}.${b.functionName}`, b);
  return c.json({ ok: true }, 201);
});

// ---- notification channels
projects.get('/:pid/channels', (c) => {
  const { project, role } = requireProject(c, c.req.param('pid'), 'project.read');
  if (role === 'public') throw new PfError('FORBIDDEN', 'notification channels are visible to project members only');
  const { db } = c.get('deps');
  return c.json({ items: db.all('SELECT * FROM notification_channels WHERE project_id = ?', project.id), recent: db.all(`SELECT n.* FROM notifications n JOIN notification_channels ch ON ch.id = n.channel_id WHERE ch.project_id = ? ORDER BY n.id DESC LIMIT 50`, project.id) });
});
projects.post('/:pid/channels', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'incident.manage');
  const b = z.object({ connector: z.string(), minSeverity: z.enum(['info', 'warning', 'critical']) }).parse(await c.req.json());
  const { db } = c.get('deps');
  if (!db.get('SELECT 1 FROM connectors WHERE project_id = ? AND name = ?', project.id, b.connector)) throw new PfError('NOT_FOUND', 'connector not found');
  db.run('INSERT INTO notification_channels (id, project_id, kind, connector, min_severity, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, connector) DO UPDATE SET min_severity = excluded.min_severity', newId('chn'), project.id, 'webhook', b.connector, b.minSeverity, now());
  audit(db, project.id, actor, 'channel.create', b.connector, b);
  return c.json({ ok: true }, 201);
});
projects.post('/:pid/notifications/:id/retry', (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'incident.manage');
  const { db } = c.get('deps');
  const n = db.get('SELECT n.id FROM notifications n JOIN notification_channels ch ON ch.id = n.channel_id WHERE n.id = ? AND ch.project_id = ?', Number(c.req.param('id')), project.id);
  if (!n) throw new PfError('NOT_FOUND', 'delivery not found');
  if (!retryDelivery(db, n.id).changes) throw new PfError('CONFLICT', 'only a delivery that gave up can be retried');
  audit(db, project.id, actor, 'notification.retry', String(n.id), {});
  return c.json({ ok: true });
});
