import { Hono } from 'hono';
import { z } from 'zod';
import type { Hex } from 'viem';
import { PfError, hashCanonical } from '@portalforge/domain';
import { newId, now, json, parse } from '@portalforge/store';
import { endpointStats, serviceHealth, transitionIncident } from '@portalforge/ops';
import { parseConnectorUrl } from '@portalforge/workflow-engine';
import { probeNetwork, verifyEvidence } from '@portalforge/sdk';
import { type Env, requireProject, requireUser, audit, visibleServices } from '../context';

export const ops = new Hono<Env>();

const network = (c: any, id: string) => {
  const p = c.get('deps').networks.find((n: any) => n.id === id);
  if (!p) throw new PfError('NOT_FOUND', 'network not configured');
  return p;
};

ops.get('/networks', (c) => {
  const { networks, db } = c.get('deps');
  return c.json({ items: networks.map((n) => {
    const eps = db.all('SELECT * FROM rpc_endpoints WHERE network_id = ?', n.id);
    const probe = db.get('SELECT created_at FROM probe_reports WHERE network_id = ? ORDER BY id DESC LIMIT 1', n.id);
    return { ...n, endpoints: eps.map((e) => ({ ...e, stats: endpointStats(db, e.id, 15 * 60_000) })), lastProbeAt: probe?.created_at ?? null };
  }) });
});

/** Latest stored capability report plus any stored history. Reports are produced by the probe (live RPC). */
ops.get('/networks/:id/capabilities', (c) => {
  network(c, c.req.param('id'));
  const rows = c.get('deps').db.all('SELECT id, report, created_at FROM probe_reports WHERE network_id = ? ORDER BY id DESC LIMIT 10', c.req.param('id'));
  return c.json({ latest: rows[0] ? parse(rows[0].report) : null, history: rows.map((r) => ({ id: r.id, createdAt: r.created_at, summary: summarize(parse(r.report)) })) });
});
const summarize = (r: any) => ({ supported: r.checks.filter((x: any) => x.status === 'supported').length, mismatch: r.checks.filter((x: any) => x.status === 'mismatch').length, error: r.checks.filter((x: any) => x.status === 'error').length });

ops.post('/networks/:id/probe', async (c) => {
  requireUser(c);
  const p = network(c, c.req.param('id'));
  const { db } = c.get('deps');
  const last = db.get('SELECT created_at FROM probe_reports WHERE network_id = ? ORDER BY id DESC LIMIT 1', p.id);
  if (last && Date.now() - Date.parse(last.created_at) < 60_000) throw new PfError('RATE_LIMITED', 'a probe ran less than a minute ago');
  const report = await probeNetwork(p);
  db.run('INSERT INTO probe_reports (network_id, report, created_at) VALUES (?, ?, ?)', p.id, json(report), now());
  return c.json(report, 201);
});

/** Health over a time window, from stored samples only. `insufficient: true` when there is not enough data. */
ops.get('/networks/:id/health', (c) => {
  const p = network(c, c.req.param('id'));
  const windowMs = Math.min(7 * 86_400_000, Math.max(60_000, Number(c.req.query('windowMs') ?? 3_600_000)));
  const { db } = c.get('deps');
  const t = Date.now();
  const buckets = 60;
  const step = windowMs / buckets;
  const endpoints = db.all('SELECT * FROM rpc_endpoints WHERE network_id = ?', p.id).map((e) => {
    const rows = db.all('SELECT at, ok, latency_ms, head, finalized FROM rpc_samples WHERE endpoint_id = ? AND at >= ? ORDER BY at', e.id, t - windowMs);
    const series = Array.from({ length: buckets }, (_, i) => {
      const from = t - windowMs + i * step;
      const inB = rows.filter((r) => r.at >= from && r.at < from + step);
      const ok = inB.filter((r) => r.ok);
      return { t: Math.round(from), samples: inB.length, ok: ok.length, latency: ok.length ? Math.round(ok.reduce((s, r) => s + r.latency_ms, 0) / ok.length) : null, head: ok.at(-1)?.head ?? null, finalityLag: ok.at(-1)?.finalized != null ? ok.at(-1)!.head - ok.at(-1)!.finalized : null };
    });
    return { ...e, stats: endpointStats(db, e.id, windowMs, t), series, recentErrors: db.all('SELECT at, error FROM rpc_samples WHERE endpoint_id = ? AND ok = 0 ORDER BY at DESC LIMIT 10', e.id) };
  });
  const cursors = db.all('SELECT stream_id, interface, address, next_block, head_seen, finalized_seen, last_error, last_error_at, last_success_at FROM cursors WHERE network_id = ?', p.id);
  return c.json({ networkId: p.id, windowMs, endpoints, services: visibleServices(c, serviceHealth(db)), indexer: cursors, observedAt: new Date(t).toISOString(),
    sources: { samples: 'PortalForge monitor probes from this host (eth_getBlockByNumber, chain_getHeader, state_getRuntimeVersion)', notCollected: 'CPU/memory/peer metrics are not available from public RPC and are not shown' } });
});

/** Register an additional RPC endpoint to monitor. Public https only unless the deployment allows private endpoints. */
ops.post('/networks/:id/endpoints', async (c) => {
  const u = requireUser(c);
  const p = network(c, c.req.param('id'));
  const b = z.object({ url: z.string().max(300), interface: z.enum(['evm', 'native']), label: z.string().min(2).max(60) }).parse(await c.req.json());
  const url = new URL(b.url);
  if (b.interface === 'evm') parseConnectorUrl(b.url); else if (!['wss:', 'ws:'].includes(url.protocol)) throw new PfError('UNSAFE_TARGET', 'native endpoints must be ws(s)');
  if (process.env.PF_ALLOW_PRIVATE_RPC !== '1' && /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(url.hostname)) throw new PfError('UNSAFE_TARGET', 'private RPC endpoints are disabled on this deployment');
  const { db } = c.get('deps');
  const id = newId('rpc');
  db.run('INSERT INTO rpc_endpoints (id, network_id, interface, url, label, builtin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT DO NOTHING', id, p.id, b.interface, b.url, b.label, now());
  audit(db, null, `user:${u.handle}`, 'rpc.add', id, b);
  return c.json({ id }, 201);
});

ops.get('/services', (c) => c.json({ items: visibleServices(c, serviceHealth(c.get('deps').db)) }));

// ------------------------------------------------------------------ incidents

ops.get('/projects/:pid/incidents', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const q = c.req.query();
  const where = ['(project_id = ? OR (project_id IS NULL AND network_id = ?))']; const params: any[] = [project.id, project.network_id];
  if (q.state) { where.push('state = ?'); params.push(q.state); }
  if (q.severity) { where.push('severity = ?'); params.push(q.severity); }
  const rows = c.get('deps').db.all(`SELECT * FROM incidents WHERE ${where.join(' AND ')} ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, last_seen DESC LIMIT 200`, ...params);
  return c.json({ items: rows.map((r) => ({ ...r, facts: parse(r.facts), inference: parse(r.inference), suggestion: parse(r.suggestion), refs: parse(r.refs) })) });
});

const incidentAuth = (c: any, id: string, perm: 'project.read' | 'incident.manage', projectHint?: string) => {
  const { db } = c.get('deps');
  const inc = db.get('SELECT * FROM incidents WHERE id = ?', id);
  if (!inc) throw new PfError('NOT_FOUND', 'incident not found');
  const pid = inc.project_id ?? projectHint ?? c.req.query('project');
  if (!pid) throw new PfError('BAD_REQUEST', 'network-level incident: pass ?project=<id> of a project on that network');
  const auth = requireProject(c, pid, perm);
  if (!inc.project_id && auth.project.network_id !== inc.network_id) throw new PfError('NOT_FOUND', 'incident not found');
  return { inc, ...auth };
};

ops.get('/incidents/:id', (c) => {
  const { inc } = incidentAuth(c, c.req.param('id'), 'project.read');
  const { db } = c.get('deps');
  return c.json({ ...inc, facts: parse(inc.facts), inference: parse(inc.inference), suggestion: parse(inc.suggestion), refs: parse(inc.refs),
    timeline: db.all('SELECT * FROM incident_events WHERE incident_id = ? ORDER BY id', inc.id).map((e) => ({ ...e, detail: parse(e.detail) })),
    notifications: db.all('SELECT * FROM notifications WHERE incident_id = ? ORDER BY id DESC', inc.id) });
});

for (const action of ['acknowledge', 'resolve'] as const) {
  ops.post(`/incidents/:id/${action}`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { inc, actor, project } = incidentAuth(c, c.req.param('id'), 'incident.manage', body.project);
    const r = transitionIncident(c.get('deps').db, inc.id, action, actor, body.note);
    audit(c.get('deps').db, project.id, actor, `incident.${action}`, inc.id, { note: body.note });
    return c.json(r);
  });
}

/**
 * Optional model explanation. Only the incident's recorded facts are sent; the model has no tools and
 * its text is stored as a labelled explanation — it cannot act, broadcast, or change permissions.
 */
ops.post('/incidents/:id/explain', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { inc, actor, project } = incidentAuth(c, c.req.param('id'), 'incident.manage', body.project);
  const { aiExplain, db } = c.get('deps');
  if (!aiExplain) throw new PfError('NOT_CONFIGURED', 'no model configured (set ANTHROPIC_API_KEY); the rule-based diagnosis above is authoritative');
  const prompt = `You are assisting an operator of a Portaldot developer platform. Explain the likely cause and an ordered checklist. Only use these recorded facts; say when facts are insufficient.\nTitle: ${inc.title}\nKind: ${inc.kind}\nFacts: ${inc.facts}\nRule inference: ${inc.inference}`;
  const r = await aiExplain(prompt);
  db.run(`INSERT INTO incident_events (incident_id, at, kind, actor, detail) VALUES (?, ?, 'explanation', ?, ?)`, inc.id, now(), actor, json({ model: r.model, text: r.text, label: 'model-generated; verify against facts' }));
  audit(db, project.id, actor, 'incident.explain', inc.id, { model: r.model });
  return c.json(r);
});

// ------------------------------------------------------------------ evidence

ops.get('/projects/:pid/evidence', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  return c.json({ items: c.get('deps').db.all('SELECT id, evidence_id, kind, kind_hash, subject, content_hash, network_id, registry, execution_id, tx_hash, block_number, status, verification, created_at FROM evidence WHERE project_id = ? ORDER BY created_at DESC LIMIT 200', project.id).map((r) => ({ ...r, verification: parse(r.verification) })) });
});

ops.get('/evidence/:id', (c) => {
  const { db } = c.get('deps');
  const e = db.get('SELECT * FROM evidence WHERE id = ? OR evidence_id = ?', c.req.param('id'), c.req.param('id'));
  if (!e) throw new PfError('NOT_FOUND', 'evidence not found');
  requireProject(c, e.project_id, 'project.read');
  const content = parse(e.content);
  return c.json({ ...e, content, verification: parse(e.verification), localHash: hashCanonical(content), canonicalization: 'portalforge canonical JSON (sorted keys, bigint as string) → keccak256 UTF-8' });
});

/** Recompute the hash locally and compare with the on-chain registry record (live eth_call). */
ops.post('/evidence/:id/verify', async (c) => {
  const { db, networks } = c.get('deps');
  const e = db.get('SELECT * FROM evidence WHERE id = ? OR evidence_id = ?', c.req.param('id'), c.req.param('id'));
  if (!e) throw new PfError('NOT_FOUND', 'evidence not found');
  requireProject(c, e.project_id, 'project.read');
  if (!e.registry) return c.json({ ok: false, checks: [{ id: 'evidence.registered', status: 'fail', detail: 'evidence was stored locally only (register: false or not yet confirmed)' }] });
  const profile = networks.find((n) => n.id === e.network_id);
  if (!profile) throw new PfError('NOT_CONFIGURED', 'network not configured');
  const exec = db.get(`SELECT from_address FROM intents WHERE execution_id = ? AND step_id = (SELECT step_id FROM steps WHERE execution_id = ? AND type = 'evidence' LIMIT 1) AND kind = 'chain_tx' AND state = 'confirmed'`, e.execution_id, e.execution_id);
  const report = await verifyEvidence(profile, { registry: e.registry as Hex, evidenceId: e.evidence_id as Hex, content: parse(e.content), expectedWriter: exec?.from_address, expectedKind: e.kind_hash, subject: e.subject } as any);
  db.run('UPDATE evidence SET verification = ? WHERE id = ?', json(report), e.id);
  return c.json(report);
});
