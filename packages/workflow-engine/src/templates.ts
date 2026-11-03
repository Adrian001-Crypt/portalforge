import { PfError, type Condition } from '@portalforge/domain';

export interface Ctx { trigger: unknown; steps: Record<string, { output: unknown }>; execution: { id: string; workflowId: string; version: number; projectId: string } }

const FULL = /^\{\{\s*([^}]+?)\s*\}\}$/;
const PART = /\{\{\s*([^}]+?)\s*\}\}/g;
const SEG = /^[A-Za-z0-9_]+$/;

export function lookup(ctx: Ctx, path: string): unknown {
  const parts = path.split('.');
  if (!parts.every((p) => SEG.test(p))) throw new PfError('VALIDATION_FAILED', `invalid path ${path}`);
  let cur: any = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') throw new PfError('VALIDATION_FAILED', 'forbidden path segment');
    cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : undefined;
  }
  return cur;
}

/** "{{a.b}}" keeps the referenced type; "x {{a}} y" interpolates as text. Templates never execute code. */
export function resolve(value: unknown, ctx: Ctx): unknown {
  if (typeof value === 'string') {
    const m = FULL.exec(value);
    if (m) return lookup(ctx, m[1]);
    return value.replace(PART, (_s, p) => { const v = lookup(ctx, p); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, ctx)]));
  return value;
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);
const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === 'string' && typeof b === 'string' && /^-?\d+$/.test(a) && /^-?\d+$/.test(b)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  const x = num(a), y = num(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  return x < y ? -1 : x > y ? 1 : 0;
};
const eq = (a: unknown, b: unknown) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() || a === b : String(a) === String(b));

export function evaluate(c: Condition, ctx: Ctx): boolean {
  switch (c.op) {
    case 'and': return c.all.every((x) => evaluate(x, ctx));
    case 'or': return c.all.some((x) => evaluate(x, ctx));
    case 'not': return !evaluate(c.cond, ctx);
    case 'exists': { const v = lookup(ctx, c.path); return v !== undefined && v !== null; }
    case 'in': { const v = lookup(ctx, c.left); return c.values.some((x) => eq(v, x)); }
    default: {
      const l = lookup(ctx, c.left);
      if (c.op === 'eq') return eq(l, c.right);
      if (c.op === 'neq') return !eq(l, c.right);
      const r = cmp(l, c.right);
      if (Number.isNaN(r)) return false;
      return c.op === 'gt' ? r > 0 : c.op === 'gte' ? r >= 0 : c.op === 'lt' ? r < 0 : r <= 0;
    }
  }
}
