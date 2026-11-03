import { z } from 'zod';
import { PfError } from './errors';

/** Template strings reference earlier data: {{trigger.args.jobId}}, {{steps.fetch.output.value}}, {{execution.id}}. */
const Template = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type TemplateValue = string | number | boolean | null | TemplateValue[] | { [k: string]: TemplateValue };
const TemplateTree: z.ZodType<TemplateValue> = z.lazy(() =>
  z.union([Template, z.array(TemplateTree), z.record(TemplateTree)]),
);

export type Condition =
  | { op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; left: string; right: string | number | boolean }
  | { op: 'exists'; path: string }
  | { op: 'in'; left: string; values: (string | number)[] }
  | { op: 'and' | 'or'; all: Condition[] }
  | { op: 'not'; cond: Condition };
export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']), left: z.string(), right: z.union([z.string(), z.number(), z.boolean()]) }),
    z.object({ op: z.literal('exists'), path: z.string() }),
    z.object({ op: z.literal('in'), left: z.string(), values: z.array(z.union([z.string(), z.number()])) }),
    z.object({ op: z.enum(['and', 'or']), all: z.array(Condition).min(1) }),
    z.object({ op: z.literal('not'), cond: Condition }),
  ]),
);

export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(20).default(3),
  backoffMs: z.number().int().min(10).max(600_000).default(1000),
  maxBackoffMs: z.number().int().min(10).max(3_600_000).default(60_000),
  jitter: z.boolean().default(true),
});

const base = {
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'step id: lowercase, digits, underscore'),
  name: z.string().max(80).optional(),
  needs: z.array(z.string()).default([]),
  retry: RetryPolicy.optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(30_000),
  ui: z.object({ x: z.number(), y: z.number() }).optional(),
};

export const BUILTIN_TASKS = ['math.square', 'hash.canonical', 'json.pick', 'text.upper'] as const;

export const Step = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('condition'), condition: Condition }),
  z.object({ ...base, type: z.literal('map'), output: z.record(TemplateTree) }),
  z.object({ ...base, type: z.literal('task'), task: z.enum(BUILTIN_TASKS), input: z.record(TemplateTree) }),
  z.object({
    ...base,
    type: z.literal('http'),
    /** Name of a project connector. Raw URLs are never accepted in definitions (SSRF policy). */
    connector: z.string(),
    body: z.record(TemplateTree),
    /** query-before-retry: connector exposes GET {url}/{executionId}; required for safe retry of unknown outcomes. */
    idempotency: z.enum(['query-before-retry', 'none']).default('query-before-retry'),
  }),
  z.object({
    ...base,
    type: z.literal('validate'),
    value: z.string(),
    schema: z.object({
      type: z.enum(['object', 'number', 'string', 'boolean']),
      required: z.array(z.string()).default([]),
      properties: z.record(z.object({ type: z.enum(['number', 'string', 'boolean', 'integer']), min: z.number().optional(), max: z.number().optional(), pattern: z.string().optional() })).default({}),
    }),
  }),
  z.object({ ...base, type: z.literal('approval'), prompt: z.string().max(500), expiresInSec: z.number().int().min(30).max(7 * 86400).default(3600) }),
  z.object({ ...base, type: z.literal('wait'), seconds: z.number().int().min(1).max(86400) }),
  z.object({
    ...base,
    type: z.literal('contract_call'),
    /** Alias of an allowlisted project contract; addresses come from the registry, not the definition. */
    contract: z.string(),
    function: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    args: z.array(TemplateTree),
    mode: z.enum(['simulate', 'write']).default('simulate'),
  }),
  z.object({ ...base, type: z.literal('evidence'), kind: z.enum(['execution', 'report']), include: z.array(z.string()).min(1), register: z.boolean().default(false) }),
]);
export type Step = z.infer<typeof Step>;
export type StepType = Step['type'];

export const Trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), contract: z.string(), event: z.string(), where: Condition.optional(), minFinality: z.enum(['unconfirmed', 'safe', 'finalized']).default('safe') }),
  z.object({ type: z.literal('schedule'), everySeconds: z.number().int().min(10).max(86400) }),
  z.object({ type: z.literal('manual') }),
]);
export type Trigger = z.infer<typeof Trigger>;

export const WorkflowDefinition = z.object({
  schema: z.literal('portalforge.workflow/v1'),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).default(''),
  trigger: Trigger,
  concurrency: z.number().int().min(1).max(50).default(4),
  steps: z.array(Step).min(1).max(40),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export const EXECUTION_STATES = [
  'queued', 'running', 'awaiting_approval', 'broadcasting', 'pending', 'unknown',
  'succeeded', 'failed', 'cancelled', 'dead_letter',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export const TERMINAL_STATES: readonly ExecutionState[] = ['succeeded', 'failed', 'cancelled', 'dead_letter'];

export interface ValidationIssue { path: string; message: string }

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
export const templateRefs = (v: unknown): string[] => {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === 'string') for (const m of x.matchAll(TEMPLATE_RE)) out.push(m[1]);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return out;
};

const conditionPaths = (c: Condition): string[] => {
  if ('all' in c) return c.all.flatMap(conditionPaths);
  if (c.op === 'not') return conditionPaths(c.cond);
  if (c.op === 'exists') return [c.path];
  return [c.left];
};

/** Structural validation: schema, unique ids, known needs, acyclic, and references only to ancestors. */
export function validateWorkflow(input: unknown): { ok: true; definition: WorkflowDefinition; order: string[] } | { ok: false; issues: ValidationIssue[] } {
  const parsed = WorkflowDefinition.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.') || '$', message: i.message })) };
  }
  const def = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  def.steps.forEach((s, i) => {
    if (ids.has(s.id)) issues.push({ path: `steps.${i}.id`, message: `duplicate step id ${s.id}` });
    ids.add(s.id);
  });
  def.steps.forEach((s, i) => s.needs.forEach((n) => { if (!ids.has(n)) issues.push({ path: `steps.${i}.needs`, message: `unknown step ${n}` }); }));
  // Kahn topological sort
  const indeg = new Map(def.steps.map((s) => [s.id, 0]));
  def.steps.forEach((s) => s.needs.forEach(() => indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1)));
  const queue = def.steps.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    def.steps.filter((s) => s.needs.includes(id)).forEach((s) => {
      indeg.set(s.id, indeg.get(s.id)! - 1);
      if (indeg.get(s.id) === 0) queue.push(s.id);
    });
  }
  if (order.length !== def.steps.length && issues.length === 0) issues.push({ path: 'steps', message: 'workflow graph has a cycle' });
  // Reference check: a step may only read trigger/execution data or outputs of its ancestors.
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const n of byId.get(id)?.needs ?? []) if (!seen.has(n)) { seen.add(n); ancestors(n, seen); }
    return seen;
  };
  if (issues.length === 0) {
    def.steps.forEach((s, i) => {
      const refs = [...templateRefs(s)];
      if (s.type === 'condition') refs.push(...conditionPaths(s.condition));
      if (s.type === 'validate') refs.push(s.value);
      if (s.type === 'evidence') refs.push(...s.include);
      const anc = ancestors(s.id);
      for (const r of refs) {
        const [root, stepId] = r.split('.');
        if (root === 'trigger' || root === 'execution') continue;
        if (root !== 'steps' || !stepId) { issues.push({ path: `steps.${i}`, message: `unknown reference root in "${r}"` }); continue; }
        if (!anc.has(stepId)) issues.push({ path: `steps.${i}`, message: `"${r}" references ${stepId}, which is not an upstream step` });
      }
    });
  }
  if (def.trigger.type === 'event' && def.trigger.where) {
    for (const p of conditionPaths(def.trigger.where)) if (!p.startsWith('trigger.')) issues.push({ path: 'trigger.where', message: `trigger filter may only read trigger.*, got ${p}` });
  }
  return issues.length ? { ok: false, issues } : { ok: true, definition: def, order };
}

export const assertWorkflow = (input: unknown) => {
  const r = validateWorkflow(input);
  if (!r.ok) throw new PfError('VALIDATION_FAILED', 'workflow definition invalid', { issues: r.issues });
  return r;
};
