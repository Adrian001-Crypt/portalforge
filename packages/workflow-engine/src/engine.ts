import { encodeFunctionData, decodeFunctionResult, keccak256, toBytes, type Abi, type Hex } from 'viem';
import {
  PfError, hashCanonical, isPfError, type Step, type WorkflowDefinition, type ExecutionState, validateWorkflow, TERMINAL_STATES,
} from '@portalforge/domain';
import { type Db, json, parse, now as isoNow } from '@portalforge/store';
import { resolve, evaluate, type Ctx } from './templates';
import { runTask, validateValue } from './tasks';
import { type ChainExecutor, type Reconciler, findFunction, decodeRevert, RECONCILERS, readFn } from './chain';
import { safeFetch, type HttpResult } from './http';

export const NEVER = 8_640_000_000_000_000; // "no automatic retry": operator action required

export type Outcome =
  | { kind: 'ok'; output: unknown }
  | { kind: 'fail'; error: string; retryable: boolean }
  | { kind: 'unknown'; error: string; operator?: boolean }
  | { kind: 'wait'; until: number; approval?: boolean; output?: unknown }
  | { kind: 'pending'; until: number; output?: unknown };

export interface Signal { kind: 'step_failed' | 'execution_failed' | 'dead_letter' | 'unknown_outcome' | 'contract_revert' | 'succeeded' | 'trigger_orphaned'; projectId: string; executionId: string; workflowId: string; stepId?: string; detail: string }

export interface EngineDeps {
  db: Db;
  workerId: string;
  clock?: () => number;
  leaseMs?: number;
  chains?: Map<string, ChainExecutor>;
  fetchImpl?: typeof fetch;
  resolver?: (h: string) => Promise<{ address: string }[]>;
  httpTimeoutMs?: number;
  pollMs?: number; receiptGraceMs?: number;
  random?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  onSignal?: (s: Signal) => void;
  /** Test hook: called after an intent is persisted and before the side effect is attempted. */
  beforeSideEffect?: (kind: 'http' | 'chain_tx', key: string) => Promise<void> | void;
}

class LeaseLost extends Error { constructor(id: string) { super(`lease lost for ${id}`); } }

const SIDE_EFFECT_TYPES = new Set(['http', 'contract_call', 'evidence']);
const ACTIVE_STATES = ['queued', 'running', 'awaiting_approval', 'broadcasting', 'pending', 'unknown'];

const describeError = (e: unknown): string => {
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string } };
  return [err.code, err.cause?.code, err.message, err.cause?.message].filter(Boolean).join(': ');
};

export const executionIdFor = (workflowId: string, version: number, triggerKey: string) =>
  keccak256(toBytes(`portalforge.execution/v1|${workflowId}|${version}|${triggerKey}`));

export class WorkflowEngine {
  readonly db: Db;
  private clock: () => number;
  private leaseMs: number;
  constructor(readonly deps: EngineDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? Date.now;
    this.leaseMs = deps.leaseMs ?? 30_000;
  }
  private log(m: string, d?: Record<string, unknown>) { this.deps.log?.(m, d); }
  private signal(s: Signal) { try { this.deps.onSignal?.(s); } catch { /* signals never break execution */ } }

  // ------------------------------------------------------------------ definitions

  /** Save a new immutable version. Running executions keep the version they were created with. */
  saveVersion(workflowId: string, definition: unknown, actor: string): { version: number; definitionHash: Hex } {
    const v = validateWorkflow(definition);
    if (!v.ok) throw new PfError('VALIDATION_FAILED', 'workflow definition invalid', { issues: v.issues });
    const definitionHash = hashCanonical(v.definition);
    return this.db.tx(() => {
      const last = this.db.get('SELECT version, definition_hash FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 1', workflowId);
      if (last?.definition_hash === definitionHash) return { version: last.version as number, definitionHash };
      const version = (last?.version ?? 0) + 1;
      this.db.run('INSERT INTO workflow_versions (workflow_id, version, definition, definition_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', workflowId, version, json(v.definition), definitionHash, actor, isoNow());
      return { version, definitionHash };
    });
  }

  definition(workflowId: string, version: number): WorkflowDefinition {
    const r = this.db.get('SELECT definition FROM workflow_versions WHERE workflow_id = ? AND version = ?', workflowId, version);
    if (!r) throw new PfError('NOT_FOUND', `workflow ${workflowId} v${version} not found`);
    return parse<WorkflowDefinition>(r.definition)!;
  }

  // ------------------------------------------------------------------ creation & routing

  createExecution(workflowId: string, trigger: { type: string; key: string; payload: unknown }, opts: { version?: number; replayOf?: string; reuse?: Record<string, { output: unknown; from: string }> } = {}): { id: string; created: boolean } {
    const wf = this.db.get('SELECT * FROM workflows WHERE id = ?', workflowId);
    if (!wf) throw new PfError('NOT_FOUND', 'workflow not found');
    const version = opts.version ?? wf.active_version;
    if (!version) throw new PfError('CONFLICT', 'workflow has no active version');
    const def = this.definition(workflowId, version);
    const order = (validateWorkflow(def) as { ok: true; order: string[] }).order;
    const project = this.db.get('SELECT network_id FROM projects WHERE id = ?', wf.project_id)!;
    const id = executionIdFor(workflowId, version, trigger.key);
    const t = this.clock();
    return this.db.tx(() => {
      const r = this.db.run(`INSERT INTO executions (id, project_id, workflow_id, version, network_id, trigger_type, trigger_key, trigger, input_hash, state, next_run_at, replay_of, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT (workflow_id, trigger_key) DO NOTHING`,
        id, wf.project_id, workflowId, version, project.network_id, trigger.type, trigger.key, json(trigger.payload), hashCanonical(trigger.payload ?? null), t, opts.replayOf ?? null, isoNow(), isoNow());
      if (r.changes === 0) return { id: this.db.get('SELECT id FROM executions WHERE workflow_id = ? AND trigger_key = ?', workflowId, trigger.key)!.id, created: false };
      order.forEach((sid, i) => {
        const step = def.steps.find((s) => s.id === sid)!;
        const reused = opts.reuse?.[sid];
        this.db.run(`INSERT INTO steps (execution_id, step_id, type, position, state, output, reused_from, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id, sid, step.type, i, reused ? 'succeeded' : 'pending', reused ? json(reused.output) : null, reused?.from ?? null, reused ? isoNow() : null);
      });
      return { id, created: true };
    });
  }

  /** Match indexed events to enabled event-triggered workflows. Each (workflow, event) is decided once. */
  routeEvents(limit = 200): number {
    const wfs = this.db.all(`SELECT w.*, v.definition, p.network_id FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.active_version JOIN projects p ON p.id = w.project_id WHERE w.enabled = 1`);
    let created = 0;
    for (const w of wfs) {
      const def = parse<WorkflowDefinition>(w.definition)!;
      if (def.trigger.type !== 'event') continue;
      const trig = def.trigger;
      const c = this.db.get('SELECT address FROM contracts WHERE project_id = ? AND alias = ? AND network_id = ?', w.project_id, trig.contract, w.network_id);
      if (!c) continue;
      const fins = trig.minFinality === 'finalized' ? ['finalized'] : trig.minFinality === 'safe' ? ['safe', 'finalized'] : ['unconfirmed', 'safe', 'finalized'];
      const rows = this.db.all(`SELECT e.* FROM events e WHERE e.network_id = ? AND e.interface = 'evm' AND e.address = ? AND e.event_name = ? AND e.block_number >= ?
          AND e.finality IN (${fins.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM trigger_seen s WHERE s.workflow_id = ? AND s.trigger_key = e.id)
          ORDER BY e.block_number, e.log_index LIMIT ?`, w.network_id, c.address, trig.event, w.start_block ?? 0, ...fins, w.id, limit);
      for (const e of rows) {
        const payload = { eventId: e.id, contract: trig.contract, address: e.address, event: e.event_name, args: parse(e.args), blockNumber: e.block_number, blockHash: e.block_hash, txHash: e.tx_hash, logIndex: e.log_index, finality: e.finality, networkId: e.network_id };
        const ctx: Ctx = { trigger: payload, steps: {}, execution: { id: '', workflowId: w.id, version: w.active_version, projectId: w.project_id } };
        const matched = !trig.where || evaluate(trig.where, ctx);
        this.db.tx(() => {
          let execId: string | null = null;
          if (matched) { const r = this.createExecution(w.id, { type: 'event', key: e.id, payload }); execId = r.id; if (r.created) created++; }
          this.db.run('INSERT INTO trigger_seen (workflow_id, trigger_key, matched, execution_id, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', w.id, e.id, matched ? 1 : 0, execId, isoNow());
        });
      }
    }
    this.handleOrphanedTriggers();
    return created;
  }

  /** A trigger event that was orphaned by a reorg cancels queued executions; started ones raise a signal. */
  private handleOrphanedTriggers() {
    const rows = this.db.all(`SELECT x.* FROM executions x JOIN events e ON e.id = x.trigger_key WHERE x.trigger_type = 'event' AND e.finality = 'orphaned' AND x.state IN ('queued','running','awaiting_approval','pending','unknown','broadcasting')`);
    for (const x of rows) {
      if (x.state === 'queued' && !x.lease_owner) {
        this.db.run(`UPDATE executions SET state = 'cancelled', error = 'trigger event orphaned by reorg', finished_at = ?, updated_at = ? WHERE id = ? AND state = 'queued' AND lease_owner IS NULL`, isoNow(), isoNow(), x.id);
      } else this.db.run('UPDATE executions SET cancel_requested = 1 WHERE id = ?', x.id);
      this.signal({ kind: 'trigger_orphaned', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, detail: `trigger ${x.trigger_key} orphaned` });
    }
  }

  /** Schedule triggers: one execution per slot, no catch-up storm after downtime. */
  scheduleTick(): number {
    const wfs = this.db.all(`SELECT w.id, v.definition FROM workflows w JOIN workflow_versions v ON v.workflow_id = w.id AND v.version = w.active_version WHERE w.enabled = 1`);
    let created = 0;
    for (const w of wfs) {
      const def = parse<WorkflowDefinition>(w.definition)!;
      if (def.trigger.type !== 'schedule') continue;
      const slot = Math.floor(this.clock() / 1000 / def.trigger.everySeconds);
      const r = this.createExecution(w.id, { type: 'schedule', key: `schedule:${def.trigger.everySeconds}:${slot}`, payload: { slot, at: new Date(slot * def.trigger.everySeconds * 1000).toISOString() } });
      if (r.created) created++;
    }
    return created;
  }

  // ------------------------------------------------------------------ claim / lease

  claim(): any | null {
    const t = this.clock();
    return this.db.tx(() => this.db.get(`UPDATE executions SET lease_owner = ?, lease_expires_at = ?, state_version = state_version + 1,
        state = CASE WHEN state = 'queued' THEN 'running' ELSE state END, updated_at = ?
      WHERE id = (
        SELECT e.id FROM executions e WHERE e.state IN (${ACTIVE_STATES.map(() => '?').join(',')}) AND e.next_run_at <= ?
          AND (e.lease_owner IS NULL OR e.lease_expires_at < ?)
          AND (SELECT COUNT(*) FROM executions x WHERE x.workflow_id = e.workflow_id AND x.id != e.id AND x.lease_owner IS NOT NULL AND x.lease_expires_at >= ?)
              < COALESCE((SELECT json_extract(v.definition, '$.concurrency') FROM workflow_versions v WHERE v.workflow_id = e.workflow_id AND v.version = e.version), 4)
        ORDER BY e.next_run_at LIMIT 1)
      RETURNING *`, this.deps.workerId, t + this.leaseMs, isoNow(), ...ACTIVE_STATES, t, t, t) ?? null);
  }

  private guard(id: string, sets: string, ...params: any[]) {
    const r = this.db.run(`UPDATE executions SET ${sets}, updated_at = ? WHERE id = ? AND lease_owner = ? AND lease_expires_at >= ?`, ...params, isoNow(), id, this.deps.workerId, this.clock());
    if (r.changes !== 1) throw new LeaseLost(id);
  }
  private renew(id: string) { this.guard(id, 'lease_expires_at = ?', this.clock() + this.leaseMs); }
  private release(id: string, state: ExecutionState, nextRunAt: number) {
    this.guard(id, 'lease_owner = NULL, lease_expires_at = NULL, state = ?, next_run_at = ?', state, nextRunAt);
  }
  private finish(x: any, state: ExecutionState, error: string | null) {
    const steps = this.db.all('SELECT step_id, output FROM steps WHERE execution_id = ? ORDER BY position', x.id);
    const result = Object.fromEntries(steps.map((s) => [s.step_id, parse(s.output)]));
    this.db.tx(() => {
      this.guard(x.id, 'lease_owner = NULL, lease_expires_at = NULL, state = ?, error = ?, result = ?, result_hash = ?, finished_at = ?, next_run_at = ?', state, error, json(result), state === 'succeeded' ? hashCanonical(result) : null, isoNow(), NEVER);
      if (state === 'cancelled') this.db.run(`UPDATE approvals SET state = 'void' WHERE execution_id = ? AND state = 'pending'`, x.id);
    });
    this.log('execution finished', { id: x.id, state, error });
    if (state === 'succeeded') this.signal({ kind: 'succeeded', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, detail: 'ok' });
    if (state === 'failed') this.signal({ kind: 'execution_failed', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, detail: error ?? '' });
    if (state === 'dead_letter') this.signal({ kind: 'dead_letter', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, detail: error ?? '' });
  }

  // ------------------------------------------------------------------ run loop

  /** Claim and advance one execution. Returns false when nothing was runnable. */
  async runNext(): Promise<boolean> {
    const x = this.claim();
    if (!x) return false;
    const timer = setInterval(() => { try { this.renew(x.id); } catch { /* surfaced on next guarded write */ } }, Math.max(1_000, this.leaseMs / 3));
    try { await this.advance(x); } catch (e) {
      if (e instanceof LeaseLost) this.log('lease lost; another worker owns the execution now', { id: x.id });
      else {
        this.log('advance error', { id: x.id, error: (e as Error).message });
        try { this.release(x.id, 'running', this.clock() + 5_000); } catch { /* lease already gone */ }
      }
    } finally { clearInterval(timer); }
    return true;
  }

  async runUntilIdle(maxIterations = 200): Promise<number> {
    let n = 0;
    while (n < maxIterations && (await this.runNext())) n++;
    return n;
  }

  private async advance(x0: any) {
    const def = this.definition(x0.workflow_id, x0.version);
    for (let guardIter = 0; guardIter < 200; guardIter++) {
      const x = this.db.get('SELECT * FROM executions WHERE id = ?', x0.id)!;
      if (x.lease_owner !== this.deps.workerId) throw new LeaseLost(x.id);
      if (TERMINAL_STATES.includes(x.state)) return;
      if (x.cancel_requested && x.state !== 'broadcasting') return this.finish(x, 'cancelled', 'cancelled by operator');
      const rows = this.db.all('SELECT * FROM steps WHERE execution_id = ? ORDER BY position', x.id);
      const byId = new Map(rows.map((r) => [r.step_id, r]));
      const t = this.clock();
      let next: any = null;
      let waitUntil = Infinity;
      let waitState: ExecutionState = 'running';
      const rank: Record<string, number> = { running: 0, pending: 1, awaiting_approval: 2, unknown: 3 };
      let skippedOne = false;
      for (const r of rows) {
        if (['succeeded', 'failed', 'skipped'].includes(r.state)) continue;
        const step = def.steps.find((s) => s.id === r.step_id)!;
        const needs = step.needs.map((n) => byId.get(n)!);
        if (needs.some((n) => n.state === 'failed')) continue;
        if (needs.some((n) => !['succeeded', 'skipped'].includes(n.state))) continue;
        const skip = needs.some((n) => n.state === 'skipped' || (n.type === 'condition' && parse<any>(n.output)?.result === false));
        if (skip) {
          this.db.tx(() => { this.renew(x.id); this.db.run(`UPDATE steps SET state = 'skipped', finished_at = ? WHERE execution_id = ? AND step_id = ?`, isoNow(), x.id, r.step_id); });
          skippedOne = true;
          break;
        }
        if (['retry_wait', 'waiting', 'awaiting_approval', 'unknown'].includes(r.state) && (r.next_attempt_at ?? 0) > t) {
          if (r.next_attempt_at < waitUntil) waitUntil = r.next_attempt_at;
          const st: ExecutionState = r.state === 'awaiting_approval' ? 'awaiting_approval' : r.state === 'unknown' ? 'unknown' : r.state === 'waiting' && SIDE_EFFECT_TYPES.has(r.type) ? 'pending' : 'running';
          if (rank[st] > rank[waitState]) waitState = st;
          continue;
        }
        next = r;
        break;
      }
      if (skippedOne) continue;
      if (!next) {
        const all = this.db.all('SELECT state FROM steps WHERE execution_id = ?', x.id);
        if (all.every((s) => ['succeeded', 'skipped'].includes(s.state))) return this.finish(x, 'succeeded', null);
        if (all.some((s) => s.state === 'failed')) return this.finish(x, 'failed', x.error ?? 'step failed');
        return this.release(x.id, waitState, waitUntil === Infinity ? t + 5_000 : waitUntil);
      }
      const done = await this.runStep(x, def, next);
      if (done) return;
    }
  }

  /** Runs one step and persists its outcome. Returns true when the execution reached a terminal state. */
  private async runStep(x: any, def: WorkflowDefinition, row: any): Promise<boolean> {
    const step = def.steps.find((s) => s.id === row.step_id)!;
    const resume = row.state === 'waiting' || row.state === 'awaiting_approval';
    const attempt = resume ? row.attempts : row.attempts + 1;
    const startedAt = isoNow();
    const ctx = this.buildCtx(x, def);
    this.db.tx(() => {
      this.renew(x.id);
      this.db.run(`UPDATE steps SET state = 'running', attempts = ?, started_at = COALESCE(started_at, ?) WHERE execution_id = ? AND step_id = ?`, attempt, startedAt, x.id, step.id);
      if (!resume) this.db.run(`INSERT INTO step_attempts (execution_id, step_id, attempt, worker_id, state, input, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)
        ON CONFLICT (execution_id, step_id, attempt) DO UPDATE SET worker_id = excluded.worker_id, state = 'running', started_at = excluded.started_at`, x.id, step.id, attempt, this.deps.workerId, json(this.stepInput(step, ctx)), startedAt);
    });
    let out: Outcome;
    try {
      out = await this.withTimeout(this.handle(step, ctx, x, row, attempt), step.timeoutMs, SIDE_EFFECT_TYPES.has(step.type));
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      out = this.classify(e);
    }
    return this.applyOutcome(x, step, attempt, out);
  }

  private stepInput(step: Step, ctx: Ctx): unknown {
    try {
      switch (step.type) {
        case 'map': return resolve(step.output, ctx);
        case 'task': return resolve(step.input, ctx);
        case 'http': return resolve(step.body, ctx);
        case 'contract_call': return { contract: step.contract, function: step.function, args: resolve(step.args, ctx), mode: step.mode };
        case 'validate': return resolve(`{{${step.value}}}`, ctx);
        default: return null;
      }
    } catch { return null; }
  }

  private withTimeout(p: Promise<Outcome>, ms: number, sideEffect: boolean): Promise<Outcome> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => res(sideEffect ? { kind: 'unknown', error: `step timed out after ${ms}ms; outcome of the side effect is unknown` } : { kind: 'fail', error: `step timed out after ${ms}ms`, retryable: true }), ms);
      p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
    });
  }

  private classify(e: unknown): Outcome {
    if (isPfError(e)) {
      const nonRetry = ['VALIDATION_FAILED', 'POLICY_DENIED', 'UNSAFE_TARGET', 'NOT_SUPPORTED', 'NOT_CONFIGURED', 'BUDGET_EXCEEDED', 'NETWORK_MISMATCH', 'NOT_FOUND', 'FORBIDDEN'];
      return { kind: 'fail', error: `${e.code}: ${e.message}`, retryable: !nonRetry.includes(e.code) };
    }
    return { kind: 'fail', error: (e as Error).message ?? String(e), retryable: true };
  }

  private backoff(step: Step, attempt: number) {
    const p = { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 60_000, jitter: true, ...(step.retry ?? {}) };
    const base = Math.min(p.maxBackoffMs, p.backoffMs * 2 ** (attempt - 1));
    return Math.round(p.jitter ? base * (0.5 + (this.deps.random ?? Math.random)() * 0.5) : base);
  }

  private applyOutcome(x: any, step: Step, attempt: number, out: Outcome): boolean {
    const maxAttempts = step.retry?.maxAttempts ?? 3;
    const t = this.clock();
    const fin = isoNow();
    const setAttempt = (state: string, output: unknown, error: string | null) =>
      this.db.run('UPDATE step_attempts SET state = ?, output = ?, error = ?, finished_at = ? WHERE execution_id = ? AND step_id = ? AND attempt = ?', state, json(output), error, fin, x.id, step.id, attempt);
    const setStep = (state: string, extra: { output?: unknown; error?: string | null; next?: number | null; finished?: boolean }) =>
      this.db.run(`UPDATE steps SET state = ?, output = COALESCE(?, output), error = ?, next_attempt_at = ?, finished_at = ? WHERE execution_id = ? AND step_id = ?`,
        state, extra.output === undefined ? null : json(extra.output), extra.error ?? null, extra.next ?? null, extra.finished ? fin : null, x.id, step.id);
    let terminal: ExecutionState | null = null;
    let err: string | null = null;
    this.db.tx(() => {
      this.renew(x.id);
      switch (out.kind) {
        case 'ok': setStep('succeeded', { output: out.output, finished: true }); setAttempt('succeeded', out.output, null); break;
        case 'wait': setStep(out.approval ? 'awaiting_approval' : 'waiting', { output: out.output, next: out.until }); break;
        case 'pending': setStep('waiting', { output: out.output, next: out.until }); this.guard(x.id, 'state = ?', 'pending'); break;
        case 'unknown': {
          const next = out.operator || attempt >= maxAttempts + 2 ? NEVER : t + this.backoff(step, attempt);
          setStep('unknown', { error: out.error, next }); setAttempt('unknown', null, out.error);
          this.guard(x.id, 'state = ?', 'unknown');
          this.signal({ kind: 'unknown_outcome', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, stepId: step.id, detail: out.error + (next === NEVER ? ' (operator action required)' : '') });
          break;
        }
        case 'fail': {
          setAttempt('failed', null, out.error);
          if (out.retryable && attempt < maxAttempts) { setStep('retry_wait', { error: out.error, next: t + this.backoff(step, attempt) }); break; }
          setStep('failed', { error: out.error, finished: true });
          terminal = out.retryable ? 'dead_letter' : 'failed';
          err = out.retryable ? `step ${step.id} exhausted ${maxAttempts} attempts: ${out.error}` : `step ${step.id}: ${out.error}`;
          this.signal({ kind: 'step_failed', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, stepId: step.id, detail: out.error });
        }
      }
    });
    if (terminal) { this.finish(x, terminal, err); return true; }
    return false;
  }

  private buildCtx(x: any, def: WorkflowDefinition): Ctx {
    const rows = this.db.all('SELECT step_id, output, state FROM steps WHERE execution_id = ?', x.id);
    void def;
    return {
      trigger: parse(x.trigger),
      steps: Object.fromEntries(rows.filter((r) => r.state === 'succeeded').map((r) => [r.step_id, { output: parse(r.output) }])),
      execution: { id: x.id, workflowId: x.workflow_id, version: x.version, projectId: x.project_id },
    };
  }

  // ------------------------------------------------------------------ step handlers

  private async handle(step: Step, ctx: Ctx, x: any, row: any, attempt: number): Promise<Outcome> {
    switch (step.type) {
      case 'condition': return { kind: 'ok', output: { result: evaluate(step.condition, ctx) } };
      case 'map': return { kind: 'ok', output: resolve(step.output, ctx) };
      case 'task': return { kind: 'ok', output: runTask(step.task, resolve(step.input, ctx) as Record<string, unknown>) };
      case 'validate': {
        const value = resolve(`{{${step.value}}}`, ctx);
        const issues = validateValue(value, step.schema);
        return issues.length ? { kind: 'fail', error: `validation failed: ${issues.join('; ')}`, retryable: false } : { kind: 'ok', output: { valid: true } };
      }
      case 'wait': {
        const prev = parse<any>(row.output);
        if (prev?.until && this.clock() >= prev.until) return { kind: 'ok', output: { waitedUntil: new Date(prev.until).toISOString() } };
        const until = prev?.until ?? this.clock() + step.seconds * 1000;
        return { kind: 'wait', until, output: { until } };
      }
      case 'approval': return this.approval(step, x);
      case 'http': return this.http(step, ctx, x);
      case 'contract_call': return this.contractCall(x, step.id, step.contract, step.function, resolve(step.args, ctx) as unknown[], step.mode);
      case 'evidence': return this.evidence(step, ctx, x);
    }
    void attempt;
  }

  private approval(step: Extract<Step, { type: 'approval' }>, x: any): Outcome {
    const a = this.db.get('SELECT * FROM approvals WHERE execution_id = ? AND step_id = ?', x.id, step.id);
    const t = this.clock();
    if (!a) {
      const expires = t + step.expiresInSec * 1000;
      this.db.run(`INSERT INTO approvals (id, execution_id, step_id, prompt, state, execution_state_version, requested_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        `apr_${x.id.slice(2, 14)}_${step.id}`, x.id, step.id, step.prompt, x.state_version, isoNow(), expires);
      return { kind: 'wait', until: expires, approval: true, output: { approvalId: `apr_${x.id.slice(2, 14)}_${step.id}`, expiresAt: new Date(expires).toISOString() } };
    }
    if (a.state === 'approved') return { kind: 'ok', output: { approvedBy: a.decided_by, approvedAt: a.decided_at, reason: a.reason } };
    if (a.state === 'rejected') return { kind: 'fail', error: `approval rejected by ${a.decided_by}: ${a.reason ?? ''}`, retryable: false };
    if (a.state === 'void') return { kind: 'fail', error: 'approval voided', retryable: false };
    if (t >= a.expires_at) {
      this.db.run(`UPDATE approvals SET state = 'expired' WHERE id = ? AND state = 'pending'`, a.id);
      return { kind: 'fail', error: 'approval expired', retryable: false };
    }
    return { kind: 'wait', until: a.expires_at, approval: true, output: { approvalId: a.id, expiresAt: new Date(a.expires_at).toISOString() } };
  }

  private getIntent(key: string) { return this.db.get('SELECT * FROM intents WHERE idempotency_key = ?', key); }

  private async http(step: Extract<Step, { type: 'http' }>, ctx: Ctx, x: any): Promise<Outcome> {
    const conn = this.db.get('SELECT * FROM connectors WHERE project_id = ? AND name = ?', x.project_id, step.connector);
    if (!conn) return { kind: 'fail', error: `connector ${step.connector} not configured`, retryable: false };
    const key = `${x.id}:${step.id}`;
    const body = { executionId: x.id, ...(resolve(step.body, ctx) as object) };
    let intent = this.getIntent(key);
    if (!intent) {
      this.db.run(`INSERT INTO intents (id, execution_id, step_id, kind, idempotency_key, request, state, created_at, updated_at) VALUES (?, ?, ?, 'http', ?, ?, 'prepared', ?, ?)`,
        `int_${keccak256(toBytes(key)).slice(2, 18)}`, x.id, step.id, key, json({ connector: step.connector, body }), isoNow(), isoNow());
      intent = this.getIntent(key)!;
    }
    if (intent.state === 'confirmed') return { kind: 'ok', output: parse(intent.response) };
    const timeoutMs = this.deps.httpTimeoutMs ?? 8_000;
    const opts = { allowPrivate: !!conn.allow_private_host, fetchImpl: this.deps.fetchImpl, resolver: this.deps.resolver, timeoutMs };
    if (intent.state === 'sent' || intent.state === 'unknown') {
      // The previous attempt may have reached the receiver. Never resend blindly.
      if (step.idempotency !== 'query-before-retry' || !conn.query_url) {
        return { kind: 'unknown', error: 'previous request outcome unknown and connector has no idempotent result query; resolve manually', operator: true };
      }
      const q = await safeFetch(`${conn.query_url.replace(/\/$/, '')}/${encodeURIComponent(x.id)}`, { method: 'GET', headers: { 'x-portalforge-execution': x.id } }, opts).catch((e) => ({ error: (e as Error).message }) as HttpResult);
      if ('status' in q && q.status === 200 && q.json && typeof q.json === 'object') {
        this.db.run(`UPDATE intents SET state = 'confirmed', response = ?, updated_at = ? WHERE id = ?`, json(q.json), isoNow(), intent.id);
        this.log('http reconciled from receiver', { key });
        return { kind: 'ok', output: { ...(q.json as object), reconciled: true } };
      }
      if (!('status' in q) || q.status !== 404) {
        this.db.run(`UPDATE intents SET state = 'unknown', error = ?, updated_at = ? WHERE id = ?`, 'error' in q ? q.error : `query HTTP ${q.status}`, isoNow(), intent.id);
        return { kind: 'unknown', error: `result query failed: ${'error' in q ? q.error : `HTTP ${q.status}`}` };
      }
      // 404: receiver confirms it has no result for this execution → safe to (re)send with the same key.
    }
    this.db.run(`UPDATE intents SET state = 'sent', updated_at = ? WHERE id = ?`, isoNow(), intent.id);
    await this.deps.beforeSideEffect?.('http', key);
    const r = await safeFetch(conn.url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': x.id, 'x-portalforge-execution': x.id, 'x-portalforge-step': step.id }, body: JSON.stringify(body),
    }, opts).catch((e) => ({ error: describeError(e) }) as HttpResult);
    if ('error' in r) {
      if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UNSAFE_TARGET/.test(r.error)) {
        // The request never left this host: definitely not delivered, safe to retry with the same key.
        this.db.run(`UPDATE intents SET state = 'prepared', error = ?, updated_at = ? WHERE id = ?`, r.error, isoNow(), intent.id);
        return { kind: 'fail', error: `connector unreachable: ${r.error}`, retryable: !/UNSAFE_TARGET/.test(r.error) };
      }
      this.db.run(`UPDATE intents SET state = 'unknown', error = ?, updated_at = ? WHERE id = ?`, r.error, isoNow(), intent.id);
      return { kind: 'unknown', error: `request outcome unknown: ${r.error}` };
    }
    if (r.status >= 200 && r.status < 300) {
      if (!r.json || typeof r.json !== 'object') return { kind: 'fail', error: 'response is not a JSON object', retryable: false };
      this.db.run(`UPDATE intents SET state = 'confirmed', response = ?, updated_at = ? WHERE id = ?`, json(r.json), isoNow(), intent.id);
      return { kind: 'ok', output: r.json };
    }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      this.db.run(`UPDATE intents SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`, `HTTP ${r.status}`, isoNow(), intent.id);
      return { kind: 'fail', error: `receiver rejected request: HTTP ${r.status} ${r.text.slice(0, 200)}`, retryable: false };
    }
    this.db.run(`UPDATE intents SET state = 'unknown', error = ?, updated_at = ? WHERE id = ?`, `HTTP ${r.status}`, isoNow(), intent.id);
    return { kind: 'unknown', error: `receiver returned HTTP ${r.status}; outcome unknown until queried` };
  }

  private coerceArgs(abi: Abi, fnName: string, args: unknown[]): unknown[] {
    const fn = findFunction(abi, fnName);
    if (args.length !== fn.inputs.length) throw new PfError('VALIDATION_FAILED', `${fnName} expects ${fn.inputs.length} args, got ${args.length}`);
    return fn.inputs.map((inp, i) => {
      const v = args[i];
      if (/^u?int\d*$/.test(inp.type)) { const s = String(v); if (!/^-?\d+$/.test(s)) throw new PfError('VALIDATION_FAILED', `arg ${inp.name} must be an integer`); return BigInt(s); }
      if (inp.type === 'bool') return v === true || v === 'true';
      if (inp.type === 'address' || /^bytes\d+$/.test(inp.type)) { if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new PfError('VALIDATION_FAILED', `arg ${inp.name} must be hex`); return v; }
      if (inp.type === 'string') return String(v);
      throw new PfError('POLICY_DENIED', `argument type ${inp.type} not supported by the executor`);
    });
  }

  /** Allowlisted contract call. Write mode: policy, identity, simulation, budget, intent-before-broadcast, reconciliation. */
  async contractCall(x: any, stepId: string, alias: string, fnName: string, rawArgs: unknown[], mode: 'simulate' | 'write'): Promise<Outcome> {
    const chain = this.deps.chains?.get(x.network_id);
    if (!chain) return { kind: 'fail', error: `NOT_CONFIGURED: no executor for network ${x.network_id} (no silent fallback)`, retryable: false };
    const c = this.db.get(`SELECT c.*, a.abi FROM contracts c JOIN contract_abis a ON a.contract_id = c.id AND a.version = c.active_abi_version WHERE c.project_id = ? AND c.alias = ? AND c.network_id = ?`, x.project_id, alias, x.network_id);
    if (!c) return { kind: 'fail', error: `contract ${alias} not registered on ${x.network_id}`, retryable: false };
    const abi = parse<Abi>(c.abi)!;
    const fn = findFunction(abi, fnName);
    if (fn.stateMutability === 'payable') return { kind: 'fail', error: 'POLICY_DENIED: payable functions are never called by the executor', retryable: false };
    const args = this.coerceArgs(abi, fnName, rawArgs);
    const to = c.address as Hex;
    const data = encodeFunctionData({ abi, functionName: fnName, args } as any);
    const read = readFn(chain, abi, to);
    if (mode === 'simulate' || fn.stateMutability === 'view' || fn.stateMutability === 'pure') {
      const sim = await chain.simulate(to, data);
      if (!sim.ok) return { kind: 'fail', error: `simulation reverted: ${decodeRevert(abi, sim.revertData) ?? sim.message}`, retryable: false };
      const result = fn.outputs.length ? decodeFunctionResult({ abi, functionName: fnName, data: sim.returnData } as any) : null;
      return { kind: 'ok', output: { simulated: true, result: JSON.parse(json(result) ?? 'null') } };
    }
    const policy = this.db.get('SELECT * FROM contract_policies WHERE project_id = ? AND contract_alias = ? AND function_name = ? AND enabled = 1', x.project_id, alias, fnName);
    if (!policy) return { kind: 'fail', error: `POLICY_DENIED: ${alias}.${fnName} is not on the executor allowlist`, retryable: false };
    const reconcile: Reconciler | undefined = RECONCILERS[fnName];
    const reconcileNow = async () => (reconcile ? reconcile({ read, args, executor: chain.address }) : 'not_applied' as const);
    const key = `${x.id}:${stepId}`;
    const intent = this.getIntent(key);
    if (intent?.tx_hash && intent.state !== 'failed') return this.followTx(x, intent, chain, reconcile ? reconcileNow : null, abi);

    await chain.assertNetwork();
    const sim = await chain.simulate(to, data);
    if (!sim.ok) {
      const name = decodeRevert(abi, sim.revertData);
      if (reconcile) {
        const st = await reconcileNow();
        if (st === 'applied') return { kind: 'ok', output: { alreadyApplied: true, note: `${alias}.${fnName} already applied by this execution`, revert: name } };
        if (st === 'applied_by_other') return { kind: 'fail', error: `conflict: ${alias}.${fnName} was applied by a different execution (${name})`, retryable: false };
      }
      this.signal({ kind: 'contract_revert', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, stepId, detail: `${alias}.${fnName} reverted in simulation: ${name ?? sim.message}` });
      return { kind: 'fail', error: `simulation reverted: ${name ?? sim.message}`, retryable: false };
    }
    const est = await chain.estimate(to, data); // RPC failure throws → retryable; never assume a fee
    if (est.fee > BigInt(policy.max_fee_wei)) return { kind: 'fail', error: `BUDGET_EXCEEDED: estimated fee ${est.fee} > policy max ${policy.max_fee_wei}`, retryable: false };
    if (est.balance < est.fee) return { kind: 'fail', error: `executor balance ${est.balance} < fee ${est.fee}`, retryable: true };
    const hour = Math.floor(this.clock() / 3_600_000);
    const spent = this.db.get('SELECT calls FROM executor_spend WHERE network_id = ? AND hour = ? AND contract_alias = ? AND function_name = ?', x.network_id, hour, alias, fnName);
    if ((spent?.calls ?? 0) >= policy.max_calls_per_hour) return { kind: 'fail', error: `hourly call budget (${policy.max_calls_per_hour}) for ${alias}.${fnName} used up`, retryable: true };

    const mutex = `executor:${x.network_id}:${chain.address.toLowerCase()}`;
    if (!this.acquireMutex(mutex)) return { kind: 'pending', until: this.clock() + 1_000, output: { waitingFor: 'executor nonce lock' } };
    try {
      const chainNonce = await chain.pendingNonce();
      const local = this.db.get(`SELECT MAX(nonce) n FROM intents WHERE kind = 'chain_tx' AND from_address = ? AND state IN ('prepared','sent','unknown')`, chain.address.toLowerCase());
      const nonce = Math.max(chainNonce, local?.n != null ? local.n + 1 : 0);
      const signed = await chain.sign(to, data, nonce, est.gas, est.gasPrice);
      this.db.tx(() => {
        this.renew(x.id);
        this.db.run(`INSERT INTO intents (id, execution_id, step_id, kind, idempotency_key, request, state, tx_hash, raw_tx, nonce, from_address, created_at, updated_at) VALUES (?, ?, ?, 'chain_tx', ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`,
          `int_${signed.hash.slice(2, 18)}`, x.id, stepId, key, json({ alias, to, function: fnName, args, gas: est.gas, gasPrice: est.gasPrice, fee: est.fee }), signed.hash, signed.raw, nonce, chain.address.toLowerCase(), isoNow(), isoNow());
        this.db.run(`INSERT INTO executor_spend (network_id, hour, contract_alias, function_name, calls, fee_wei) VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT DO UPDATE SET calls = calls + 1, fee_wei = CAST(CAST(fee_wei AS INTEGER) + CAST(excluded.fee_wei AS INTEGER) AS TEXT)`, x.network_id, hour, alias, fnName, est.fee.toString());
        this.guard(x.id, 'state = ?', 'broadcasting');
      });
      await this.deps.beforeSideEffect?.('chain_tx', key);
      try {
        const b = await chain.broadcast(signed.raw);
        if (!b.accepted && !b.known) {
          // Definitive rejection: the tx is not in any pool. Free the idempotency key for a fresh attempt.
          this.db.run(`UPDATE intents SET state = 'failed', error = ?, idempotency_key = idempotency_key || ':rejected:' || id, updated_at = ? WHERE tx_hash = ?`, b.error ?? 'rejected', isoNow(), signed.hash);
          return { kind: 'fail', error: `broadcast rejected: ${b.error}`, retryable: true };
        }
        this.db.run(`UPDATE intents SET state = 'sent', updated_at = ? WHERE tx_hash = ?`, isoNow(), signed.hash);
      } catch (e) {
        this.db.run(`UPDATE intents SET state = 'unknown', error = ?, updated_at = ? WHERE tx_hash = ?`, (e as Error).message, isoNow(), signed.hash);
      }
      return { kind: 'pending', until: this.clock() + (this.deps.pollMs ?? 2_000), output: { txHash: signed.hash, nonce } };
    } finally { this.releaseMutex(mutex); }
  }

  private async followTx(x: any, intent: any, chain: ChainExecutor, reconcile: null | (() => Promise<'applied' | 'applied_by_other' | 'not_applied'>), abi: Abi): Promise<Outcome> {
    const hash = intent.tx_hash as Hex;
    const poll = this.clock() + (this.deps.pollMs ?? 2_000);
    const r = await chain.receipt(hash);
    if (r) {
      if (r.status === 'success') {
        const safe = await chain.safeBlock();
        if (r.blockNumber > safe) return { kind: 'pending', until: poll, output: { txHash: hash, blockNumber: r.blockNumber, waitingFor: 'safe confirmation' } };
        const output = { txHash: hash, blockNumber: r.blockNumber, blockHash: r.blockHash, gasUsed: r.gasUsed.toString(), feeWei: (r.gasUsed * r.effectiveGasPrice).toString(), nonce: intent.nonce };
        this.db.run(`UPDATE intents SET state = 'confirmed', response = ?, updated_at = ? WHERE id = ?`, json(output), isoNow(), intent.id);
        return { kind: 'ok', output };
      }
      this.db.run(`UPDATE intents SET state = 'failed', error = 'reverted', updated_at = ? WHERE id = ?`, isoNow(), intent.id);
      if (reconcile && (await reconcile()) === 'applied') return { kind: 'ok', output: { alreadyApplied: true, txHash: hash } };
      this.signal({ kind: 'contract_revert', projectId: x.project_id, executionId: x.id, workflowId: x.workflow_id, stepId: intent.step_id, detail: `tx ${hash} reverted on-chain` });
      return { kind: 'fail', error: `transaction ${hash} reverted`, retryable: false };
    }
    if (await chain.txKnown(hash)) return { kind: 'pending', until: poll, output: { txHash: hash, waitingFor: 'inclusion' } };
    const latest = await chain.latestNonce();
    if (latest > intent.nonce) {
      // Portaldot's eth-rpc serves the new nonce before it has indexed the transaction, so a used nonce alone does not
      // mean the transaction was replaced. Give the index time; concluding early would also skip the finality wait.
      if (this.clock() - Date.parse(intent.updated_at) < (this.deps.receiptGraceMs ?? 120_000)) return { kind: 'pending', until: poll, output: { txHash: hash, waitingFor: 'receipt index' } };
      // Our nonce was consumed by another transaction (replacement/cancel elsewhere). Decide from business state.
      const st = reconcile ? await reconcile() : 'not_applied';
      if (st === 'applied') {
        this.db.run(`UPDATE intents SET state = 'failed', error = 'not found on chain; nonce used by another transaction, effect confirmed from contract state', updated_at = ? WHERE id = ?`, isoNow(), intent.id);
        return { kind: 'ok', output: { alreadyApplied: true, replacedTx: hash } };
      }
      if (st === 'applied_by_other') return { kind: 'fail', error: 'conflict: effect applied by a different execution', retryable: false };
      if (!reconcile) return { kind: 'unknown', error: `nonce ${intent.nonce} consumed by another tx and no reconciler for this function`, operator: true };
      this.db.run(`UPDATE intents SET state = 'failed', error = 'dropped: nonce consumed by another tx', idempotency_key = idempotency_key || ':dropped:' || id, updated_at = ? WHERE id = ?`, isoNow(), intent.id);
      return { kind: 'fail', error: `tx ${hash} dropped; nonce reused by another transaction`, retryable: true };
    }
    // Not mined, not in the pool, nonce unused: re-broadcast the SAME signed tx (same hash) — not a new business operation.
    try {
      const b = await chain.broadcast(intent.raw_tx);
      if (!b.accepted && !b.known) return { kind: 'unknown', error: `re-broadcast rejected: ${b.error}` };
    } catch (e) { return { kind: 'unknown', error: `re-broadcast failed: ${(e as Error).message}` }; }
    void abi;
    return { kind: 'pending', until: poll, output: { txHash: hash, rebroadcast: true } };
  }

  private async evidence(step: Extract<Step, { type: 'evidence' }>, ctx: Ctx, x: any): Promise<Outcome> {
    const wf = this.db.get('SELECT definition_hash FROM workflow_versions WHERE workflow_id = ? AND version = ?', x.workflow_id, x.version)!;
    const items = Object.fromEntries(step.include.map((p) => [p, resolve(`{{${p}}}`, ctx) ?? null]));
    const content = { schema: 'portalforge.evidence/v1', kind: step.kind, executionId: x.id, workflow: { id: x.workflow_id, version: x.version, definitionHash: wf.definition_hash }, trigger: { type: x.trigger_type, key: x.trigger_key, inputHash: x.input_hash }, items };
    const contentHash = hashCanonical(content);
    const evidenceId = keccak256(toBytes(`portalforge.evidence/v1|${x.id}|${step.id}`));
    const kindHash = keccak256(toBytes(`portalforge.${step.kind}`));
    const existing = this.db.get('SELECT * FROM evidence WHERE project_id = ? AND evidence_id = ?', x.project_id, evidenceId);
    if (existing && existing.content_hash !== contentHash) return { kind: 'fail', error: 'evidence content changed between attempts (non-deterministic input)', retryable: false };
    if (!existing) {
      this.db.run(`INSERT INTO evidence (id, project_id, evidence_id, kind, kind_hash, subject, content, content_hash, network_id, execution_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?)`,
        `evd_${evidenceId.slice(2, 18)}`, x.project_id, evidenceId, step.kind, kindHash, x.id, json(content), contentHash, x.network_id, x.id, isoNow());
    }
    if (!step.register) return { kind: 'ok', output: { evidenceId, contentHash, registered: false } };
    const out = await this.contractCall(x, step.id, 'evidence', 'register', [evidenceId, kindHash, x.id, contentHash], 'write');
    if (out.kind === 'ok') {
      const o = out.output as any;
      const reg = this.db.get(`SELECT address FROM contracts WHERE project_id = ? AND alias = 'evidence' AND network_id = ?`, x.project_id, x.network_id);
      this.db.run(`UPDATE evidence SET status = 'registered', registry = ?, tx_hash = COALESCE(?, tx_hash), block_number = COALESCE(?, block_number) WHERE project_id = ? AND evidence_id = ?`, reg?.address ?? null, o.txHash ?? null, o.blockNumber ?? null, x.project_id, evidenceId);
      return { kind: 'ok', output: { evidenceId, contentHash, registered: true, ...o } };
    }
    if (out.kind === 'pending' || out.kind === 'wait') return { ...out, output: { evidenceId, contentHash, ...(out.output as object) } };
    return out;
  }

  private acquireMutex(name: string): boolean {
    const t = this.clock();
    return this.db.tx(() => {
      const r = this.db.run(`INSERT INTO mutex (name, owner, expires_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE mutex.expires_at < ? OR mutex.owner = excluded.owner`, name, this.deps.workerId, t + 60_000, t);
      return r.changes === 1;
    });
  }
  private releaseMutex(name: string) { this.db.run('DELETE FROM mutex WHERE name = ? AND owner = ?', name, this.deps.workerId); }

  // ------------------------------------------------------------------ operator actions

  requestCancel(id: string, actor: string) {
    return this.db.tx(() => {
      const x = this.db.get('SELECT * FROM executions WHERE id = ?', id);
      if (!x) throw new PfError('NOT_FOUND', 'execution not found');
      if (TERMINAL_STATES.includes(x.state)) throw new PfError('CONFLICT', `execution already ${x.state}`);
      // Not leased: cancel now. Leased: the owning worker cancels at the next step boundary.
      // A broadcast transaction cannot be recalled; it is followed to completion.
      const r = this.db.run(`UPDATE executions SET state = 'cancelled', error = ?, finished_at = ?, updated_at = ?, next_run_at = ? WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at < ?) AND state NOT IN ('broadcasting','pending')`, `cancelled by ${actor}`, isoNow(), isoNow(), NEVER, id, this.clock());
      if (r.changes) this.db.run(`UPDATE approvals SET state = 'void' WHERE execution_id = ? AND state = 'pending'`, id);
      else this.db.run('UPDATE executions SET cancel_requested = 1, updated_at = ? WHERE id = ?', isoNow(), id);
      return { cancelled: r.changes === 1, requested: r.changes === 0 };
    });
  }

  decideApproval(approvalId: string, decision: 'approved' | 'rejected', actor: string, reason?: string) {
    return this.db.tx(() => {
      const a = this.db.get('SELECT a.*, x.state xstate FROM approvals a JOIN executions x ON x.id = a.execution_id WHERE a.id = ?', approvalId);
      if (!a) throw new PfError('NOT_FOUND', 'approval not found');
      if (a.state !== 'pending') throw new PfError('CONFLICT', `approval is ${a.state}`);
      if (this.clock() >= a.expires_at) { this.db.run(`UPDATE approvals SET state = 'expired' WHERE id = ?`, a.id); throw new PfError('CONFLICT', 'approval expired'); }
      if (a.xstate !== 'awaiting_approval') throw new PfError('CONFLICT', `execution is ${a.xstate}`);
      this.db.run('UPDATE approvals SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND state = ?', decision, actor, isoNow(), reason ?? null, a.id, 'pending');
      this.db.run(`UPDATE steps SET next_attempt_at = ? WHERE execution_id = ? AND step_id = ?`, this.clock(), a.execution_id, a.step_id);
      this.db.run(`UPDATE executions SET next_run_at = ?, updated_at = ? WHERE id = ?`, this.clock(), isoNow(), a.execution_id);
      return { executionId: a.execution_id, decision };
    });
  }

  /** Operator decision for a step whose side-effect outcome is unknown. */
  resolveUnknown(id: string, stepId: string, decision: 'retry' | 'mark_succeeded' | 'fail', actor: string, note?: string) {
    return this.db.tx(() => {
      const s = this.db.get('SELECT * FROM steps WHERE execution_id = ? AND step_id = ?', id, stepId);
      if (!s || s.state !== 'unknown') throw new PfError('CONFLICT', 'step is not in unknown state');
      if (decision === 'retry') {
        this.db.run(`UPDATE steps SET next_attempt_at = ? WHERE execution_id = ? AND step_id = ?`, this.clock(), id, stepId);
      } else if (decision === 'mark_succeeded') {
        this.db.run(`UPDATE steps SET state = 'succeeded', output = ?, finished_at = ? WHERE execution_id = ? AND step_id = ?`, json({ resolvedBy: actor, note: note ?? null, manual: true }), isoNow(), id, stepId);
      } else {
        this.db.run(`UPDATE steps SET state = 'failed', error = ?, finished_at = ? WHERE execution_id = ? AND step_id = ?`, `marked failed by ${actor}: ${note ?? ''}`, isoNow(), id, stepId);
      }
      this.db.run(`UPDATE executions SET next_run_at = ?, state = CASE WHEN state = 'unknown' THEN 'running' ELSE state END, updated_at = ? WHERE id = ?`, this.clock(), isoNow(), id);
      return { decision };
    });
  }

  /**
   * Replay with the original version and trigger payload. mode 'full' re-runs every step;
   * 'from-failure' reuses outputs of steps that succeeded. Contract-level dedup still applies.
   */
  replay(id: string, mode: 'full' | 'from-failure', actor: string) {
    const x = this.db.get('SELECT * FROM executions WHERE id = ?', id);
    if (!x) throw new PfError('NOT_FOUND', 'execution not found');
    if (!TERMINAL_STATES.includes(x.state)) throw new PfError('CONFLICT', 'only finished executions can be replayed');
    const n = (this.db.get('SELECT COUNT(*) n FROM executions WHERE replay_of = ?', id)?.n ?? 0) + 1;
    const reuse = mode === 'from-failure'
      ? Object.fromEntries(this.db.all(`SELECT step_id, output FROM steps WHERE execution_id = ? AND state = 'succeeded'`, id).map((s) => [s.step_id, { output: parse(s.output), from: id }]))
      : undefined;
    void actor;
    return this.createExecution(x.workflow_id, { type: 'replay', key: `replay:${id}:${n}`, payload: parse(x.trigger) }, { version: x.version, replayOf: id, reuse });
  }
}
