import { type Db, json, now, parse } from '@portalforge/store';
import { rpcRaw } from '@portalforge/portaldot-evm';
import type { NetworkProfile } from '@portalforge/domain';
import type { NativeReader } from '@portalforge/portaldot-native';

export interface Sample { endpointId: string; ok: boolean; latencyMs: number | null; head: number | null; finalized: number | null; headHash: string | null; specVersion: number | null; error: string | null }

/** One EVM endpoint sample: reachability, latency, head, finalized head. Fields are null when not observed. */
export async function sampleEvm(endpoint: { id: string; url: string }, profile: NetworkProfile, fetchImpl?: typeof fetch): Promise<Sample> {
  const head = await rpcRaw<any>(endpoint.url, 'eth_getBlockByNumber', ['latest', false], 8_000, fetchImpl);
  if (!head.ok || !head.value) return { endpointId: endpoint.id, ok: false, latencyMs: Math.round(head.ms), head: null, finalized: null, headHash: null, specVersion: null, error: head.ok ? 'null block' : `${head.error.kind}: ${head.error.message}` };
  const cid = await rpcRaw<string>(endpoint.url, 'eth_chainId', [], 8_000, fetchImpl);
  if (cid.ok && Number.parseInt(cid.value, 16) !== profile.evm.chainId) return { endpointId: endpoint.id, ok: false, latencyMs: Math.round(head.ms), head: null, finalized: null, headHash: null, specVersion: null, error: `chainId mismatch: ${Number.parseInt(cid.value, 16)}` };
  let finalized: number | null = null;
  if (profile.evm.finalizedTag) {
    const f = await rpcRaw<any>(endpoint.url, 'eth_getBlockByNumber', ['finalized', false], 8_000, fetchImpl);
    if (f.ok && f.value) finalized = Number.parseInt(f.value.number, 16);
  }
  return { endpointId: endpoint.id, ok: true, latencyMs: Math.round(head.ms), head: Number.parseInt(head.value.number, 16), finalized, headHash: head.value.hash, specVersion: null, error: null };
}

export async function sampleNative(endpoint: { id: string }, reader: NativeReader | null, connectError?: string): Promise<Sample> {
  if (!reader) return { endpointId: endpoint.id, ok: false, latencyMs: null, head: null, finalized: null, headHash: null, specVersion: null, error: connectError ?? 'not connected' };
  const t0 = performance.now();
  try {
    const [h, rv] = await Promise.race([
      Promise.all([reader.heads(), reader.api.rpc.state.getRuntimeVersion()]),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout after 8000ms')), 8_000)),
    ]);
    return { endpointId: endpoint.id, ok: true, latencyMs: Math.round(performance.now() - t0), head: h.best, finalized: h.finalized, headHash: h.bestHash, specVersion: rv.specVersion.toNumber(), error: null };
  } catch (e) {
    return { endpointId: endpoint.id, ok: false, latencyMs: Math.round(performance.now() - t0), head: null, finalized: null, headHash: null, specVersion: null, error: (e as Error).message };
  }
}

export function storeSample(db: Db, s: Sample, at = Date.now()) {
  db.run('INSERT INTO rpc_samples (endpoint_id, at, ok, latency_ms, head, finalized, head_hash, spec_version, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', s.endpointId, at, s.ok, s.latencyMs, s.head, s.finalized, s.headHash, s.specVersion, s.error);
}

export interface EndpointStats {
  endpointId: string; samples: number; window: { from: number; to: number };
  availability: number | null; p50: number | null; p95: number | null; errorRate: number | null;
  head: number | null; finalized: number | null; finalityLag: number | null; blocksPerMinute: number | null;
  lastError: string | null; lastOkAt: number | null; insufficient: boolean;
}

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

/** Derived only from stored samples. With fewer than MIN samples the stats are marked insufficient. */
export function endpointStats(db: Db, endpointId: string, windowMs: number, nowMs = Date.now(), MIN = 5): EndpointStats {
  const from = nowMs - windowMs;
  const rows = db.all('SELECT * FROM rpc_samples WHERE endpoint_id = ? AND at >= ? ORDER BY at', endpointId, from);
  const ok = rows.filter((r) => r.ok);
  const lastOk = ok.at(-1);
  const firstOk = ok[0];
  const spanMin = lastOk && firstOk && lastOk.at > firstOk.at ? (lastOk.at - firstOk.at) / 60_000 : 0;
  const insufficient = rows.length < MIN;
  return {
    endpointId, samples: rows.length, window: { from, to: nowMs },
    availability: insufficient ? null : ok.length / rows.length,
    p50: insufficient ? null : pct(ok.map((r) => r.latency_ms), 50), p95: insufficient ? null : pct(ok.map((r) => r.latency_ms), 95),
    errorRate: insufficient ? null : (rows.length - ok.length) / rows.length,
    head: lastOk?.head ?? null, finalized: lastOk?.finalized ?? null,
    finalityLag: lastOk && lastOk.finalized != null ? lastOk.head - lastOk.finalized : null,
    blocksPerMinute: spanMin >= 1 && lastOk?.head != null && firstOk?.head != null ? (lastOk.head - firstOk.head) / spanMin : null,
    lastError: rows.filter((r) => !r.ok).at(-1)?.error ?? null, lastOkAt: lastOk?.at ?? null, insufficient,
  };
}

export function heartbeat(db: Db, service: string, instance: string, info: Record<string, unknown> = {}) {
  db.run('INSERT INTO heartbeats (service, instance, at, info) VALUES (?, ?, ?, ?) ON CONFLICT (service, instance) DO UPDATE SET at = excluded.at, info = excluded.info', service, instance, Date.now(), json(info));
}

export function serviceHealth(db: Db, staleMs = 30_000, nowMs = Date.now()) {
  return db.all('SELECT * FROM heartbeats ORDER BY service, instance').map((h) => ({ service: h.service, instance: h.instance, lastSeen: new Date(h.at).toISOString(), ageMs: nowMs - h.at, alive: nowMs - h.at < staleMs, info: parse(h.info) }));
}

export { now };
