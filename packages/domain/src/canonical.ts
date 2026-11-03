import { keccak256, toBytes, type Hex } from 'viem';
import { PfError } from './errors';

/**
 * Canonical JSON used for every hash PortalForge publishes (manifests, workflow versions,
 * execution inputs/results, reports). Rules (documented in docs/security.md):
 *  - object keys sorted by UTF-16 code unit order, no insignificant whitespace
 *  - bigint is encoded as a decimal string
 *  - undefined object members are dropped; undefined in arrays is rejected
 *  - non-finite numbers, functions and symbols are rejected
 *  - strings use JSON.stringify escaping
 * The hash is keccak256 over the UTF-8 bytes, so it can be compared with bytes32 on-chain.
 */
export function canonicalize(value: unknown): string {
  return encode(value, '$');
}

function encode(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'number':
      if (!Number.isFinite(v)) throw new PfError('VALIDATION_FAILED', `non-finite number at ${path}`);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        return '[' + v.map((x, i) => {
          if (x === undefined) throw new PfError('VALIDATION_FAILED', `undefined array item at ${path}[${i}]`);
          return encode(x, `${path}[${i}]`);
        }).join(',') + ']';
      }
      if (v instanceof Date) return JSON.stringify(v.toISOString());
      const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + encode((v as Record<string, unknown>)[k], `${path}.${k}`)).join(',') + '}';
    }
    default:
      throw new PfError('VALIDATION_FAILED', `unsupported ${typeof v} at ${path}`);
  }
}

export const hashCanonical = (value: unknown): Hex => keccak256(toBytes(canonicalize(value)));
export const hashText = (text: string): Hex => keccak256(toBytes(text));
export const hashBytes = (bytes: Uint8Array): Hex => keccak256(bytes);
