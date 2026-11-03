import { PfError, type PfErrorCode } from '@portalforge/domain';

export interface ClientOptions { baseUrl: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
export interface Page<T> { items: T[]; nextCursor: number | null }

/** Typed client for the PortalForge HTTP API (API-key auth). Errors surface as PfError with the server code. */
export class PortalForgeClient {
  constructor(readonly opts: ClientOptions) {}
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    let r: Response;
    try {
      r = await f(`${this.opts.baseUrl.replace(/\/$/, '')}/api/v1${path}`, {
        method, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { throw new PfError('RPC_UNREACHABLE', `PortalForge API unreachable: ${(e as Error).message}`); }
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new PfError((data?.error?.code ?? 'INTERNAL') as PfErrorCode, data?.error?.message ?? `HTTP ${r.status}`, data?.error?.details);
    return data as T;
  }
  health() { return this.req<any>('GET', '/health'); }
  networks() { return this.req<{ items: any[] }>('GET', '/networks'); }
  capabilities(networkId: string) { return this.req<any>('GET', `/networks/${networkId}/capabilities`); }
  projects() { return this.req<{ items: any[] }>('GET', '/projects'); }
  project(id: string) { return this.req<any>('GET', `/projects/${id}`); }
  contracts(projectId: string) { return this.req<{ items: any[] }>('GET', `/projects/${projectId}/contracts`); }
  registerContract(projectId: string, input: { alias: string; address: string; abi: unknown[]; deployBlock: number; deployTx?: string }) { return this.req<any>('POST', `/projects/${projectId}/contracts`, input); }
  events(projectId: string, q: { contract?: string; event?: string; finality?: string; fromBlock?: number; cursor?: number; limit?: number; sort?: 'asc' | 'desc' } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.req<Page<any>>('GET', `/projects/${projectId}/events?${qs}`);
  }
  async *allEvents(projectId: string, q: Omit<Parameters<PortalForgeClient['events']>[1], 'cursor'> = {}) {
    let cursor: number | undefined;
    for (;;) { const p = await this.events(projectId, { ...q, cursor }); yield* p.items; if (!p.nextCursor) return; cursor = p.nextCursor; }
  }
  validateWorkflow(definition: unknown) { return this.req<any>('POST', '/workflows/validate', { definition }); }
  simulateWorkflow(definition: unknown, trigger: unknown, stubs: Record<string, unknown> = {}) { return this.req<any>('POST', '/workflows/simulate', { definition, trigger, stubs }); }
  executions(projectId: string, q: { state?: string; workflow?: string; cursor?: number } = {}) { const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])); return this.req<Page<any> & { counts: Record<string, number> }>('GET', `/projects/${projectId}/executions?${qs}`); }
  execution(id: string) { return this.req<any>('GET', `/executions/${id}`); }
  runWorkflow(workflowId: string, payload: Record<string, unknown>, idempotencyKey?: string) { return this.req<any>('POST', `/workflows/${workflowId}/run`, { payload, idempotencyKey }); }
  evidence(id: string) { return this.req<any>('GET', `/evidence/${id}`); }
  incidents(projectId: string) { return this.req<{ items: any[] }>('GET', `/projects/${projectId}/incidents`); }
}
