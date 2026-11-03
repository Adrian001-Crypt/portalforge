import { useState } from 'react';
import { useApi, Async, Card, PageHead, Tag, Time, Spark, Src, ErrorBox, Json, Hash } from '../ui';
import { api } from '../api';
import { useSession } from '../session';

const WINDOWS = [{ ms: 15 * 60_000, l: '15 min' }, { ms: 3_600_000, l: '1 hour' }, { ms: 6 * 3_600_000, l: '6 hours' }, { ms: 86_400_000, l: '24 hours' }];

export function NetworkHealth() {
  const nets = useApi<{ items: any[] }>('/networks');
  const [nid, setNid] = useState<string | null>(null);
  const [win, setWin] = useState(3_600_000);
  const id = nid ?? nets.data?.items[0]?.id ?? null;
  const h = useApi<any>(id ? `/networks/${id}/health?windowMs=${win}` : null, [id, win], { pollMs: 15_000 });
  const caps = useApi<any>(id ? `/networks/${id}/capabilities` : null, [id]);
  const { me } = useSession();
  const [probing, setProbing] = useState(false); const [perr, setPerr] = useState<any>(null);
  return (
    <div className="content">
      <PageHead title="Network Health" sub="RPC reachability, latency, block growth and finality — computed only from samples this deployment collected."
        actions={<><select value={id ?? ''} onChange={(e) => setNid(e.target.value)} aria-label="Network">{nets.data?.items.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>
          <select value={win} onChange={(e) => setWin(Number(e.target.value))} aria-label="Window">{WINDOWS.map((w) => <option key={w.ms} value={w.ms}>{w.l}</option>)}</select></>} />
      <Async q={h}>{(d) => <div className="stack">
        {d.endpoints.map((e: any) => (
          <Card key={e.id} title={<>{e.label} <span className="small faint mono">{e.url}</span></>} right={<><Src kind="live" /><Tag s={e.stats.insufficient ? 'unknown' : e.stats.availability > 0.95 ? 'alive' : 'failed'}>{e.stats.insufficient ? 'insufficient data' : `${(e.stats.availability * 100).toFixed(1)}% available`}</Tag></>}>
            <div className="grid g4" style={{ marginBottom: 12 }}>
              <div><div className="small muted">Head</div><b className="mono">#{e.stats.head ?? '—'}</b></div>
              <div><div className="small muted">Finality lag</div><b>{e.stats.finalityLag ?? '—'}{e.stats.finalityLag != null && ' blocks'}</b></div>
              <div><div className="small muted">Latency p50 / p95</div><b>{e.stats.p50 ?? '—'} / {e.stats.p95 ?? '—'} ms</b></div>
              <div><div className="small muted">Block growth</div><b>{e.stats.blocksPerMinute != null ? `${e.stats.blocksPerMinute.toFixed(1)}/min` : '—'}</b><div className="small faint">{e.stats.samples} samples</div></div>
            </div>
            <div className="grid g2">
              <div><div className="legend"><span><i style={{ background: 'var(--accent)' }} />latency ms (bucket avg)</span></div><Spark series={e.series.map((s: any) => s.latency)} fmt={(v) => `${v}ms`} /></div>
              <div><div className="legend"><span><i style={{ background: 'var(--info)' }} />finality lag (blocks)</span></div><Spark series={e.series.map((s: any) => s.finalityLag)} color="var(--info)" /></div>
            </div>
            {e.recentErrors.length > 0 && <details style={{ marginTop: 8 }}><summary className="small">Recent errors ({e.recentErrors.length})</summary><ul className="small">{e.recentErrors.map((r: any, i: number) => <li key={i}><Time t={r.at} /> — {r.error}</li>)}</ul></details>}
          </Card>))}
        <div className="notice small">{d.sources.samples}. {d.sources.notCollected}.</div>
      </div>}</Async>
      <div style={{ height: 14 }} />
      <Card title="Capability probe" right={<>{caps.data?.latest && <span className="small muted">probed <Time t={caps.data.latest.probedAt} /></span>}{me?.user && <button className="btn sm" disabled={probing} onClick={async () => { setProbing(true); setPerr(null); try { await api(`/networks/${id}/probe`, { method: 'POST' }); caps.reload(); } catch (x) { setPerr(x); } finally { setProbing(false); } }}>{probing ? 'Probing…' : 'Run probe'}</button>}</>} flush>
        <ErrorBox error={perr} />
        <Async q={caps}>{(d) => d.latest ? <div className="table-wrap"><table className="t"><thead><tr><th>Check</th><th>Status</th><th>Result</th></tr></thead><tbody>
          {d.latest.checks.map((c: any) => <tr key={c.id}><td className="mono small">{c.id}</td><td><Tag s={c.status} /></td><td className="small">{c.summary}</td></tr>)}</tbody></table></div>
          : <div className="empty"><b>No stored probe</b>Run the probe (read-only RPC) or <code>pf network inspect</code>.</div>}</Async>
      </Card>
    </div>
  );
}

export function IntegrationHealth() {
  const s = useApi<any>('/health', [], { pollMs: 10_000 });
  const nets = useApi<{ items: any[] }>('/networks');
  const id = nets.data?.items[0]?.id;
  const h = useApi<any>(id ? `/networks/${id}/health?windowMs=900000` : null, [id], { pollMs: 10_000 });
  return (
    <div className="content">
      <PageHead title="Integration Health" sub="PortalForge’s own services: API, indexer, worker, monitor — and which chain executors are configured." />
      <div className="grid g2">
        <Card title="Services (heartbeats)" flush>
          <Async q={s}>{(d) => d.services.length ? <table className="t"><thead><tr><th>Service</th><th>Instance</th><th>Last seen</th><th>Status</th><th>Info</th></tr></thead><tbody>
            {d.services.map((x: any) => <tr key={x.service + x.instance}><td><b>{x.service}</b></td><td className="small mono">{x.instance}</td><td><Time t={x.lastSeen} /></td><td><Tag s={x.alive ? 'alive' : 'stale'}>{x.alive ? 'alive' : 'stale'}</Tag></td><td className="small">{x.info?.executors ? `executors: ${x.info.executors.join(', ') || 'none (writes disabled)'}` : x.info?.native ? x.info.native.map((n: any) => `${n.network} native ${n.connected ? 'connected' : 'disconnected'}`).join(', ') : ''}</td></tr>)}
          </tbody></table> : <div className="empty"><b>No heartbeats</b>Start the indexer and worker (npm run dev).</div>}</Async>
        </Card>
        <Card title="Indexer streams" flush>
          <Async q={h}>{(d) => d.indexer.length ? <table className="t"><thead><tr><th>Stream</th><th>Next block</th><th>Head</th><th>Last success</th><th>Last error</th></tr></thead><tbody>
            {d.indexer.map((c: any) => <tr key={c.stream_id}><td className="small">{c.interface}{c.address && <div><Hash v={c.address} n={6} /></div>}</td><td className="mono">#{c.next_block}</td><td className="mono">#{c.head_seen ?? '—'}</td><td><Time t={c.last_success_at} /></td><td className="small">{c.last_error ? <span className={c.last_error_at > (c.last_success_at ?? '') ? 'bad-t' : 'faint'}>{c.last_error.slice(0, 80)} (<Time t={c.last_error_at} />)</span> : '—'}</td></tr>)}
          </tbody></table> : <div className="empty"><b>No streams</b></div>}</Async>
        </Card>
      </div>
      {s.data && <div style={{ marginTop: 14 }}><Card title="API"><Json v={{ ok: s.data.ok, mode: s.data.mode, networks: s.data.networks, publicReadOnly: s.data.publicReadOnly, time: s.data.time }} /></Card></div>}
    </div>
  );
}
