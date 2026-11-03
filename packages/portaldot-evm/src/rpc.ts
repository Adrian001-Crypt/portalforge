import { PfError } from '@portalforge/domain';

export interface RpcCallResult<T> { ok: true; value: T; ms: number }
export interface RpcCallFailure { ok: false; error: { kind: 'unreachable' | 'timeout' | 'rpc_error' | 'method_missing' | 'bad_response'; message: string; code?: number }; ms: number }

/**
 * Minimal JSON-RPC over HTTP. Distinguishes "the RPC said empty" (ok with [] / null)
 * from "we could not read" (failure). Callers must not treat a failure as empty data.
 */
export async function rpcRaw<T = unknown>(url: string, method: string, params: unknown[] = [], timeoutMs = 10_000, fetchImpl: typeof fetch = fetch): Promise<RpcCallResult<T> | RpcCallFailure> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    const ms = performance.now() - t0;
    if (!res.ok) return { ok: false, error: { kind: 'unreachable', message: `HTTP ${res.status}` }, ms };
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) {
      const missing = body.error.code === -32601;
      return { ok: false, error: { kind: missing ? 'method_missing' : 'rpc_error', message: body.error.message, code: body.error.code }, ms };
    }
    if (!('result' in body)) return { ok: false, error: { kind: 'bad_response', message: 'no result field' }, ms };
    return { ok: true, value: body.result as T, ms };
  } catch (e) {
    const ms = performance.now() - t0;
    const aborted = (e as Error).name === 'AbortError';
    return { ok: false, error: { kind: aborted ? 'timeout' : 'unreachable', message: aborted ? `timeout after ${timeoutMs}ms` : (e as Error).message }, ms };
  } finally {
    clearTimeout(timer);
  }
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = [], timeoutMs?: number, fetchImpl?: typeof fetch): Promise<T> {
  const r = await rpcRaw<T>(url, method, params, timeoutMs, fetchImpl);
  if (r.ok) return r.value;
  const code = r.error.kind === 'method_missing' ? 'RPC_METHOD_MISSING' : r.error.kind === 'rpc_error' ? 'RPC_ERROR' : 'RPC_UNREACHABLE';
  throw new PfError(code, `${method}: ${r.error.message}`, { method, kind: r.error.kind });
}
