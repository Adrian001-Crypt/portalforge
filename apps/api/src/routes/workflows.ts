import { Hono } from 'hono';
import { z } from 'zod';
import { PfError, validateWorkflow, hashCanonical, type WorkflowDefinition } from '@portalforge/domain';
import { newId, now, json, parse } from '@portalforge/store';
import { resolve, evaluate, runTask, validateValue, type Ctx } from '@portalforge/workflow-engine';
import { type Env, requireProject, audit, page } from '../context';

export const workflows = new Hono<Env>();

const wfWithProject = (c: any, wid: string, perm: Parameters<typeof requireProject>[2]) => {
  const w = c.get('deps').db.get('SELECT * FROM workflows WHERE id = ?', wid);
  if (!w) throw new PfError('NOT_FOUND', 'workflow not found');
  return { w, ...requireProject(c, w.project_id, perm) };
};
const execWithProject = (c: any, eid: string, perm: Parameters<typeof requireProject>[2]) => {
  const x = c.get('deps').db.get('SELECT * FROM executions WHERE id = ?', eid);
  if (!x) throw new PfError('NOT_FOUND', 'execution not found');
  return { x, ...requireProject(c, x.project_id, perm) };
};

workflows.post('/workflows/validate', async (c) => {
  const body = await c.req.json();
  const r = validateWorkflow(body.definition ?? body);
  return c.json(r.ok ? { ok: true, order: r.order, definitionHash: hashCanonical(r.definition), definition: r.definition } : { ok: false, issues: r.issues });
});

/**
 * Preview a definition against a sample trigger without side effects: pure steps (condition, map,
 * task, validate) really run; http / contract_call / evidence / approval / wait are reported as
 * "would …" with their resolved inputs. Nothing is persisted.
 */
workflows.post('/workflows/simulate', async (c) => {
  const b = z.object({ definition: z.any(), trigger: z.any(), stubs: z.record(z.any()).default({}) }).parse(await c.req.json());
  const v = validateWorkflow(b.definition);
  if (!v.ok) return c.json({ ok: false, issues: v.issues }, 400);
  const def = v.definition;
  const ctx: Ctx = { trigger: b.trigger ?? {}, steps: {}, execution: { id: '0x' + 'e'.repeat(64), workflowId: 'simulation', version: 0, projectId: 'simulation' } };
  const trace: any[] = [];
  const state = new Map<string, string>();
  if (def.trigger.type === 'event' && def.trigger.where && !evaluate(def.trigger.where, ctx)) return c.json({ ok: true, matched: false, trace: [], note: 'trigger filter did not match' });
  for (const id of v.order) {
    const s = def.steps.find((x) => x.id === id)!;
    const needs = s.needs.map((n) => ({ n, st: state.get(n), out: ctx.steps[n]?.output as any }));
    if (needs.some((x) => x.st === 'skipped' || x.st === 'failed' || (def.steps.find((d) => d.id === x.n)?.type === 'condition' && x.out?.result === false))) { state.set(id, 'skipped'); trace.push({ step: id, type: s.type, state: 'skipped' }); continue; }
    try {
      let out: unknown; let st = 'succeeded'; let note: string | undefined;
      switch (s.type) {
        case 'condition': out = { result: evaluate(s.condition, ctx) }; break;
        case 'map': out = resolve(s.output, ctx); break;
        case 'task': out = runTask(s.task, resolve(s.input, ctx) as any); break;
        case 'validate': { const issues = validateValue(resolve(`{{${s.value}}}`, ctx), s.schema); if (issues.length) { st = 'failed'; note = issues.join('; '); } out = { valid: !issues.length }; break; }
        case 'http': out = b.stubs[id] ?? null; st = b.stubs[id] ? 'stubbed' : 'would_call'; note = `POST connector "${s.connector}" with ${JSON.stringify(resolve(s.body, ctx))}`; break;
        case 'contract_call': out = b.stubs[id] ?? null; st = 'would_call'; note = `${s.mode} ${s.contract}.${s.function}(${JSON.stringify(resolve(s.args, ctx))})`; break;
        case 'evidence': { const items = Object.fromEntries(s.include.map((p) => [p, resolve(`{{${p}}}`, ctx) ?? null])); out = { previewHash: hashCanonical(items) }; st = 'would_register'; note = s.register ? 'would register on EvidenceRegistry' : 'local evidence only'; break; }
        case 'approval': st = 'would_wait'; note = `approval: ${s.prompt}`; out = { approvedBy: 'simulation' }; break;
        case 'wait': st = 'would_wait'; note = `wait ${s.seconds}s`; out = {}; break;
      }
      ctx.steps[id] = { output: out };
      state.set(id, st === 'failed' ? 'failed' : st);
      trace.push({ step: id, type: s.type, state: st, output: out, note });
    } catch (e) { state.set(id, 'failed'); trace.push({ step: id, type: s.type, state: 'failed', note: (e as Error).message }); }
  }
  return c.json({ ok: true, matched: true, trace, definitionHash: hashCanonical(def) });
});

workflows.get('/projects/:pid/workflows', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const { db } = c.get('deps');
  const rows = db.all(`SELECT w.*, v.definition, v.definition_hash,
      (SELECT COUNT(*) FROM executions x WHERE x.workflow_id = w.id) executions,
      (SELECT COUNT(*) FROM executions x WHERE x.workflow_id = w.id AND x.state = 'succeeded') succeeded,
      (SELECT COUNT(*) FROM executions x WHERE x.workflow_id = w.id AND x.state IN ('failed','dead_letter')) failed,
      (SELECT MAX(version) FROM workflow_versions v2 WHERE v2.workflow_id = w.id) latest_version
    FROM workflows w LEFT JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.active_version WHERE w.project_id = ? ORDER BY w.created_at`, project.id);
  return c.json({ items: rows.map((r) => ({ ...r, definition: parse(r.definition) })) });
});

workflows.post('/projects/:pid/workflows', async (c) => {
  const { project, actor } = requireProject(c, c.req.param('pid'), 'workflow.write');
  const b = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/), definition: z.any() }).parse(await c.req.json());
  const { db, engine } = c.get('deps');
  const v = validateWorkflow(b.definition);
  if (!v.ok) throw new PfError('VALIDATION_FAILED', 'workflow definition invalid', { issues: v.issues });
  if (db.get('SELECT 1 FROM workflows WHERE project_id = ? AND name = ?', project.id, b.name)) throw new PfError('CONFLICT', 'workflow name taken');
  const id = newId('wf');
  db.run('INSERT INTO workflows (id, project_id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', id, project.id, b.name, now(), now());
  const ver = engine.saveVersion(id, v.definition, actor);
  db.run('UPDATE workflows SET active_version = ? WHERE id = ?', ver.version, id);
  audit(db, project.id, actor, 'workflow.create', id, { name: b.name, ...ver });
  return c.json({ id, ...ver }, 201);
});

workflows.get('/workflows/:wid', (c) => {
  const { w } = wfWithProject(c, c.req.param('wid'), 'project.read');
  const { db } = c.get('deps');
  const versions = db.all('SELECT version, definition, definition_hash, created_by, created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC', w.id).map((v) => ({ ...v, definition: parse(v.definition) }));
  const byState = db.all('SELECT state, COUNT(*) n FROM executions WHERE workflow_id = ? GROUP BY state', w.id);
  return c.json({ ...w, versions, executionsByState: Object.fromEntries(byState.map((r) => [r.state, r.n])) });
});

workflows.post('/workflows/:wid/versions', async (c) => {
  const { w, actor } = wfWithProject(c, c.req.param('wid'), 'workflow.write');
  const { definition, activate } = z.object({ definition: z.any(), activate: z.boolean().default(false) }).parse(await c.req.json());
  const { db, engine } = c.get('deps');
  const v = engine.saveVersion(w.id, definition, actor);
  if (activate) db.run('UPDATE workflows SET active_version = ?, updated_at = ? WHERE id = ?', v.version, now(), w.id);
  audit(db, w.project_id, actor, 'workflow.version', w.id, { ...v, activate });
  return c.json(v, 201);
});

/** Activate a version and/or enable the trigger. Enabling starts from the current indexed block unless startBlock is given (no surprise backfill). */
workflows.post('/workflows/:wid/activate', async (c) => {
  const { w, actor, project } = wfWithProject(c, c.req.param('wid'), 'workflow.write');
  const b = z.object({ version: z.number().int().min(1).optional(), enabled: z.boolean(), startBlock: z.number().int().nonnegative().optional() }).parse(await c.req.json());
  const { db } = c.get('deps');
  if (b.version && !db.get('SELECT 1 FROM workflow_versions WHERE workflow_id = ? AND version = ?', w.id, b.version)) throw new PfError('NOT_FOUND', 'version not found');
  const indexed = db.get(`SELECT MAX(next_block) n FROM cursors WHERE network_id = ? AND interface = 'evm'`, project.network_id)?.n;
  const start = b.startBlock ?? (b.enabled && !w.enabled ? indexed ?? 0 : w.start_block);
  db.run('UPDATE workflows SET active_version = COALESCE(?, active_version), enabled = ?, start_block = ?, updated_at = ? WHERE id = ?', b.version ?? null, b.enabled, start, now(), w.id);
  audit(db, w.project_id, actor, b.enabled ? 'workflow.enable' : 'workflow.disable', w.id, { ...b, startBlock: start });
  return c.json(db.get('SELECT * FROM workflows WHERE id = ?', w.id));
});

workflows.post('/workflows/:wid/run', async (c) => {
  const { w, actor } = wfWithProject(c, c.req.param('wid'), 'workflow.run');
  const b = z.object({ payload: z.record(z.any()).default({}), idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{4,80}$/).optional() }).parse(await c.req.json());
  const { db, engine } = c.get('deps');
  const def = engine.definition(w.id, w.active_version) as WorkflowDefinition;
  if (def.trigger.type !== 'manual') throw new PfError('CONFLICT', `workflow trigger is ${def.trigger.type}; use replay or events`);
  const key = `manual:${b.idempotencyKey ?? newId('run')}`;
  const r = engine.createExecution(w.id, { type: 'manual', key, payload: { ...b.payload, requestedBy: actor } });
  audit(db, w.project_id, actor, 'workflow.run', r.id, { key, created: r.created });
  return c.json(r, r.created ? 201 : 200);
});

// ------------------------------------------------------------------ executions

workflows.get('/projects/:pid/executions', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  const q = c.req.query();
  const { limit, cursor } = page(q);
  const where = ['x.project_id = ?']; const params: any[] = [project.id];
  if (q.state) { where.push(`x.state IN (${q.state.split(',').map(() => '?').join(',')})`); params.push(...q.state.split(',')); }
  if (q.workflow) { where.push('x.workflow_id = ?'); params.push(q.workflow); }
  if (q.q) { where.push('(x.id = ? OR x.trigger_key LIKE ?)'); params.push(q.q.toLowerCase(), `%${q.q}%`); }
  if (cursor !== null) { where.push('x.rowid < ?'); params.push(cursor); }
  const rows = c.get('deps').db.all(`SELECT x.rowid AS rid, x.id, x.workflow_id, w.name workflow, x.version, x.state, x.trigger_type, x.trigger_key, x.error, x.created_at, x.updated_at, x.finished_at, x.replay_of,
      (SELECT COUNT(*) FROM step_attempts a WHERE a.execution_id = x.id) attempts
    FROM executions x JOIN workflows w ON w.id = x.workflow_id WHERE ${where.join(' AND ')} ORDER BY x.rowid DESC LIMIT ?`, ...params, limit);
  const counts = c.get('deps').db.all('SELECT state, COUNT(*) n FROM executions WHERE project_id = ? GROUP BY state', project.id);
  return c.json({ items: rows, nextCursor: rows.length === limit ? rows.at(-1)!.rid : null, counts: Object.fromEntries(counts.map((r) => [r.state, r.n])) });
});

/** Full execution trace: steps with inputs/outputs, every attempt, side-effect intents (no raw signed txs), approvals. */
workflows.get('/executions/:eid', (c) => {
  const { x, role } = execWithProject(c, c.req.param('eid'), 'project.read');
  const { db } = c.get('deps');
  const v = db.get('SELECT definition, definition_hash FROM workflow_versions WHERE workflow_id = ? AND version = ?', x.workflow_id, x.version)!;
  const w = db.get('SELECT name FROM workflows WHERE id = ?', x.workflow_id)!;
  const steps = db.all('SELECT * FROM steps WHERE execution_id = ? ORDER BY position', x.id).map((s) => ({ ...s, output: parse(s.output) }));
  const attempts = db.all('SELECT * FROM step_attempts WHERE execution_id = ? ORDER BY id', x.id).map((a) => ({ ...a, input: parse(a.input), output: parse(a.output) }));
  const intents = db.all('SELECT id, step_id, kind, idempotency_key, request, state, tx_hash, nonce, from_address, response, error, created_at, updated_at FROM intents WHERE execution_id = ? ORDER BY created_at', x.id).map((i) => ({ ...i, request: parse(i.request), response: parse(i.response) }));
  const approvals = db.all('SELECT * FROM approvals WHERE execution_id = ?', x.id);
  const evidence = db.all('SELECT id, evidence_id, kind, content_hash, status, tx_hash, block_number FROM evidence WHERE execution_id = ?', x.id);
  const replays = db.all('SELECT id, state, created_at FROM executions WHERE replay_of = ?', x.id);
  const incidents = db.all(`SELECT id, title, severity, state FROM incidents WHERE refs LIKE ?`, `%${x.id}%`);
  return c.json({ ...x, workflow: w.name, trigger: parse(x.trigger), result: parse(x.result), definition: parse(v.definition), definitionHash: v.definition_hash, steps, attempts, intents, approvals, evidence, replays, incidents, canControl: role !== 'public' });
});

workflows.post('/executions/:eid/cancel', (c) => {
  const { x, actor } = execWithProject(c, c.req.param('eid'), 'execution.control');
  const r = c.get('deps').engine.requestCancel(x.id, actor);
  audit(c.get('deps').db, x.project_id, actor, 'execution.cancel', x.id, r);
  return c.json(r);
});

workflows.post('/executions/:eid/replay', async (c) => {
  const { x, actor } = execWithProject(c, c.req.param('eid'), 'execution.control');
  const { mode } = z.object({ mode: z.enum(['full', 'from-failure']) }).parse(await c.req.json());
  const r = c.get('deps').engine.replay(x.id, mode, actor);
  audit(c.get('deps').db, x.project_id, actor, 'execution.replay', r.id, { of: x.id, mode });
  return c.json(r, 201);
});

workflows.post('/executions/:eid/steps/:sid/resolve', async (c) => {
  const { x, actor } = execWithProject(c, c.req.param('eid'), 'execution.control');
  const b = z.object({ decision: z.enum(['retry', 'mark_succeeded', 'fail']), note: z.string().max(500).optional() }).parse(await c.req.json());
  const r = c.get('deps').engine.resolveUnknown(x.id, c.req.param('sid'), b.decision, actor, b.note);
  audit(c.get('deps').db, x.project_id, actor, 'execution.resolve', x.id, { step: c.req.param('sid'), ...b });
  return c.json(r);
});

workflows.get('/projects/:pid/approvals', (c) => {
  const { project } = requireProject(c, c.req.param('pid'), 'project.read');
  return c.json({ items: c.get('deps').db.all(`SELECT a.*, w.name workflow FROM approvals a JOIN executions x ON x.id = a.execution_id JOIN workflows w ON w.id = x.workflow_id WHERE x.project_id = ? ORDER BY a.requested_at DESC LIMIT 100`, project.id) });
});

workflows.post('/approvals/:aid/decide', async (c) => {
  const { db, engine } = c.get('deps');
  const a = db.get('SELECT a.*, x.project_id FROM approvals a JOIN executions x ON x.id = a.execution_id WHERE a.id = ?', c.req.param('aid'));
  if (!a) throw new PfError('NOT_FOUND', 'approval not found');
  const { actor } = requireProject(c, a.project_id, 'approval.decide');
  const b = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(500).optional() }).parse(await c.req.json());
  const r = engine.decideApproval(a.id, b.decision, actor, b.reason);
  audit(db, a.project_id, actor, `approval.${b.decision}`, a.id, b);
  return c.json(r);
});

void json;
