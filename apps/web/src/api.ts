/** Browser API client. Cookie session + CSRF header for writes; errors carry the server code. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: any) { super(message); }
}
let csrf: string | null = null;
export const setCsrf = (t: string | null) => { csrf = t; };

/** The static demo build answers from responses captured off the public read-only stack (scripts/media/capture-snapshot.ts). */
export const SNAPSHOT = import.meta.env.VITE_SNAPSHOT === '1';
let captured: Promise<{ capturedAt: string; responses: Record<string, unknown> }> | null = null;
export const loadSnapshot = () => (captured ??= fetch(`${import.meta.env.BASE_URL}snapshot.json`).then((r) => r.json()));
async function fromSnapshot<T>(path: string, method: string): Promise<T> {
  if (method !== 'GET') throw new ApiError(0, 'STATIC_SNAPSHOT', 'This is a static snapshot, so nothing can be sent. Run PortalForge locally to try this action.');
  const { responses } = await loadSnapshot();
  if (!(path in responses)) throw new ApiError(404, 'NOT_CAPTURED', 'This view was not captured in the static snapshot.');
  return responses[path] as T;
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  if (SNAPSHOT) return fromSnapshot<T>(path, method);
  let r: Response;
  try {
    r = await fetch(`/api/v1${path}`, {
      method, signal: init.signal, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the PortalForge API. Is it running?');
  }
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!r.ok) throw new ApiError(r.status, data?.error?.code ?? 'HTTP', data?.error?.message ?? `HTTP ${r.status}`, data?.error?.details);
  return data as T;
}
