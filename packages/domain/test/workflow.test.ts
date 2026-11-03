import { describe, it, expect } from 'vitest';
import { validateWorkflow, canonicalize, hashCanonical, formatUnits, parseUnits, can } from '../src';

const base = { schema: 'portalforge.workflow/v1', name: 'x', trigger: { type: 'manual' } };

describe('workflow validation', () => {
  it('accepts a DAG and returns topological order', () => {
    const r = validateWorkflow({ ...base, steps: [{ id: 'b', type: 'map', needs: ['a'], output: { v: '{{steps.a.output.v}}' } }, { id: 'a', type: 'map', output: { v: 1 } }] });
    expect(r.ok && r.order).toEqual(['a', 'b']);
  });
  it('rejects cycles, unknown needs, duplicate ids and non-upstream references', () => {
    const cyc = validateWorkflow({ ...base, steps: [{ id: 'a', type: 'map', needs: ['b'], output: {} }, { id: 'b', type: 'map', needs: ['a'], output: {} }] });
    expect(!cyc.ok && cyc.issues[0].message).toMatch(/cycle/);
    const unk = validateWorkflow({ ...base, steps: [{ id: 'a', type: 'map', needs: ['zz'], output: {} }] });
    expect(!unk.ok && unk.issues[0].message).toMatch(/unknown step/);
    const dup = validateWorkflow({ ...base, steps: [{ id: 'a', type: 'map', output: {} }, { id: 'a', type: 'map', output: {} }] });
    expect(!dup.ok && dup.issues[0].message).toMatch(/duplicate/);
    const ref = validateWorkflow({ ...base, steps: [{ id: 'a', type: 'map', output: { v: '{{steps.b.output}}' } }, { id: 'b', type: 'map', output: {} }] });
    expect(!ref.ok && ref.issues[0].message).toMatch(/not an upstream step/);
  });
  it('rejects raw URLs and unknown step types (connectors only)', () => {
    const r = validateWorkflow({ ...base, steps: [{ id: 'a', type: 'shell', cmd: 'rm -rf /' }] });
    expect(r.ok).toBe(false);
    const h = validateWorkflow({ ...base, steps: [{ id: 'a', type: 'http', url: 'http://169.254.169.254/', body: {} }] });
    expect(h.ok).toBe(false);
  });
  it('trigger filters may only read trigger data', () => {
    const r = validateWorkflow({ ...base, trigger: { type: 'event', contract: 'jobs', event: 'E', where: { op: 'eq', left: 'steps.a.output', right: 1 } }, steps: [{ id: 'a', type: 'map', output: {} }] });
    expect(!r.ok && r.issues[0].path).toBe('trigger.where');
  });
});

describe('canonical hashing', () => {
  it('is key-order independent and encodes bigint as string', () => {
    expect(canonicalize({ b: 1, a: [true, null, 2n] })).toBe('{"a":[true,null,"2"],"b":1}');
    expect(hashCanonical({ x: 1, y: 2 })).toBe(hashCanonical({ y: 2, x: 1 }));
  });
  it('rejects non-finite numbers and undefined array items', () => {
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(() => canonicalize([undefined])).toThrow();
  });
});

describe('units and roles', () => {
  it('formats native (14 dp) and EVM (18 dp) amounts without float error', () => {
    expect(formatUnits(161_037_000_000_000_00n, 14)).toBe('161.037');
    expect(parseUnits('0.000000000000000001', 18)).toBe(1n);
    expect(() => parseUnits('1.000000000000001', 14)).toThrow();
  });
  it('viewer cannot write; operator can approve but not change members', () => {
    expect(can('viewer', 'workflow.write')).toBe(false);
    expect(can('operator', 'approval.decide')).toBe(true);
    expect(can('operator', 'project.members')).toBe(false);
  });
});
