import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { PfError } from '@portalforge/domain';
import { assertPublicTarget, isPrivateAddress } from './ssrf';

export type HttpResult = { status: number; json: unknown; text: string } | { error: string };

const MAX_BODY = 256 * 1024;

/**
 * Outbound request for connectors. The socket connects only to addresses validated at request time
 * (DNS answer is pinned into the connection, closing the rebinding window), redirects are refused,
 * and the response body is capped.
 */
export async function safeFetch(url: string, init: { method: string; headers?: Record<string, string>; body?: string }, opts: { allowPrivate: boolean; timeoutMs: number; fetchImpl?: typeof fetch; resolver?: (h: string) => Promise<{ address: string }[]> }): Promise<HttpResult> {
  const resolver = opts.resolver ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));
  const u = await assertPublicTarget(url, opts.allowPrivate, resolver);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  if (opts.fetchImpl) {
    res = await opts.fetchImpl(u, { ...init, redirect: 'manual', signal });
  } else {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const pinned = isIP(host) ? [{ address: host, family: isIP(host) }] : (await resolver(host)).map((a) => ({ address: a.address, family: isIP(a.address) }));
    if (!opts.allowPrivate && pinned.some((a) => isPrivateAddress(a.address))) throw new PfError('UNSAFE_TARGET', 'resolved to a private address');
    const dispatcher = new Agent({
      connect: {
        lookup: (_h: string, o: any, cb: any) => (o?.all ? cb(null, pinned) : cb(null, pinned[0].address, pinned[0].family)),
      },
      headersTimeout: opts.timeoutMs, bodyTimeout: opts.timeoutMs,
    });
    try {
      res = (await undiciFetch(u, { ...init, redirect: 'manual', signal, dispatcher })) as unknown as Response;
    } finally { dispatcher.close().catch(() => {}); }
  }
  if (res.status >= 300 && res.status < 400) return { status: res.status, json: null, text: 'redirect refused' };
  const reader = res.body?.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); return { status: res.status, json: null, text: 'response too large' }; }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}
