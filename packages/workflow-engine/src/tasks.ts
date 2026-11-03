import { hashCanonical, PfError } from '@portalforge/domain';

/** Deterministic built-in tasks. No I/O, no dynamic code. */
export function runTask(task: string, input: Record<string, unknown>): unknown {
  switch (task) {
    case 'math.square': {
      const v = String(input.value ?? '');
      if (!/^\d{1,40}$/.test(v)) throw new PfError('VALIDATION_FAILED', 'math.square expects a non-negative integer "value"');
      const x = BigInt(v);
      return { value: v, result: (x * x).toString() };
    }
    case 'hash.canonical': return { hash: hashCanonical(input.value ?? null) };
    case 'json.pick': {
      const src = input.from as Record<string, unknown>;
      const keys = input.keys as string[];
      if (!src || typeof src !== 'object' || !Array.isArray(keys)) throw new PfError('VALIDATION_FAILED', 'json.pick expects {from, keys}');
      return Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(src, k)).map((k) => [k, src[k]]));
    }
    case 'text.upper': return { text: String(input.text ?? '').toUpperCase() };
    default: throw new PfError('NOT_SUPPORTED', `unknown task ${task}`);
  }
}

type PropSchema = { type: 'number' | 'string' | 'boolean' | 'integer'; min?: number; max?: number; pattern?: string };
export function validateValue(value: unknown, schema: { type: string; required: string[]; properties: Record<string, PropSchema> }): string[] {
  const issues: string[] = [];
  if (schema.type !== 'object') {
    if (typeof value !== schema.type) issues.push(`expected ${schema.type}, got ${typeof value}`);
    return issues;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['expected object'];
  const o = value as Record<string, unknown>;
  for (const r of schema.required) if (o[r] === undefined || o[r] === null) issues.push(`missing ${r}`);
  for (const [k, p] of Object.entries(schema.properties)) {
    const v = o[k];
    if (v === undefined) continue;
    if (p.type === 'integer') {
      const s = typeof v === 'number' ? String(v) : String(v);
      if (!/^-?\d+$/.test(s)) { issues.push(`${k} must be an integer`); continue; }
      if (p.min !== undefined && BigInt(s) < BigInt(Math.trunc(p.min))) issues.push(`${k} < ${p.min}`);
      if (p.max !== undefined && BigInt(s) > BigInt(Math.trunc(p.max))) issues.push(`${k} > ${p.max}`);
    } else if (p.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) issues.push(`${k} must be a number`);
      else { if (p.min !== undefined && v < p.min) issues.push(`${k} < ${p.min}`); if (p.max !== undefined && v > p.max) issues.push(`${k} > ${p.max}`); }
    } else if (typeof v !== p.type) issues.push(`${k} must be ${p.type}`);
    if (p.pattern && typeof v === 'string') {
      if (p.pattern.length > 200) issues.push(`${k}: pattern too long`);
      else if (!new RegExp(p.pattern).test(v)) issues.push(`${k} does not match ${p.pattern}`);
    }
  }
  return issues;
}
