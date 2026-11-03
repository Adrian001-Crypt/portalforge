import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, Hash, KV, Json, Src, ErrorBox, downloadJson } from '../ui';

export function Events({ p }: { p: any }) {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const filters = ['contract', 'event', 'interface', 'finality', 'q', 'decodeErrors'].map((k) => [k, sp.get(k) ?? ''] as const).filter(([, v]) => v);
  const qs = new URLSearchParams([...filters, ['limit', '50'], ...(cursors.at(-1) ? [['cursor', String(cursors.at(-1))]] : [])] as any).toString();
  const q = useApi<any>(`/projects/${p.id}/events?${qs}`, [qs], { pollMs: cursors.length === 1 ? 8000 : undefined });
  const ix = useApi<any>(`/projects/${p.id}/indexer`, [p.id], { pollMs: 8000 });
  const contracts = useApi<{ items: any[] }>(`/projects/${p.id}/contracts`, [p.id]);
  useEffect(() => setCursors([null]), [sp.toString()]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n); };
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Event Explorer" sub="EVM logs and native Revive events from each contract’s deploy block, with finality and raw evidence."
        actions={q.data && <button className="btn" onClick={() => downloadJson('events.json', q.data.items)}>Export page</button>} />
      <Async q={ix}>{(d) => <div className="grid g4" style={{ marginBottom: 14 }}>
        {d.streams.slice(0, 4).map((s: any) => <div key={s.stream_id} className="card stat"><div className="label">{s.interface === 'native' ? 'Native stream' : s.alias ?? 'EVM stream'} <Src kind="live" /></div><div className="value mono" style={{ fontSize: 17 }}>#{s.indexedTo}</div>
          <div className="hint">head #{s.head_seen ?? '—'} · finalized #{s.finalized_seen ?? '—'} · lag {s.lag ?? '—'}{s.last_error && (!s.last_success_at || s.last_error_at > s.last_success_at) && <div className="bad-t">last error: {s.last_error.slice(0, 70)}</div>}</div></div>)}
      </div>}</Async>
      <Card title="Events" right={<div className="row">
        <select aria-label="Contract" value={sp.get('contract') ?? ''} onChange={(e) => set('contract', e.target.value)}><option value="">All contracts</option>{contracts.data?.items.map((c) => <option key={c.id}>{c.alias}</option>)}</select>
        <input aria-label="Event name" placeholder="Event name" value={sp.get('event') ?? ''} onChange={(e) => set('event', e.target.value)} style={{ width: 130 }} />
        <select aria-label="Interface" value={sp.get('interface') ?? ''} onChange={(e) => set('interface', e.target.value)}><option value="">EVM + native</option><option value="evm">EVM logs</option><option value="native">Native events</option></select>
        <select aria-label="Finality" value={sp.get('finality') ?? ''} onChange={(e) => set('finality', e.target.value)}><option value="">Any finality</option><option>unconfirmed</option><option>safe</option><option>finalized</option><option>orphaned</option></select>
        <label className="small row"><input type="checkbox" checked={sp.get('decodeErrors') === '1'} onChange={(e) => set('decodeErrors', e.target.checked ? '1' : '')} /> undecoded</label>
        <input aria-label="Search hash" placeholder="tx / block hash" value={sp.get('q') ?? ''} onChange={(e) => set('q', e.target.value.trim())} style={{ width: 160 }} />
      </div>} flush>
        <Async q={q}>{(d) => <>
          {d.items.length ? <div className="table-wrap"><table className="t"><thead><tr><th>Block</th><th>Contract</th><th>Event</th><th>Arguments</th><th>Interface</th><th>Finality</th><th>Tx</th></tr></thead><tbody>
            {d.items.map((e: any) => <tr key={e.id} className="click" onClick={() => nav(`/p/${p.slug}/events/${encodeURIComponent(e.id)}`)}>
              <td className="mono">#{e.block_number}<div className="small faint"><Time t={e.raw?.timestamp ? e.raw.timestamp * 1000 : e.observed_at} /></div></td>
              <td>{e.contractAlias ?? <Hash v={e.address} n={6} />}</td>
              <td>{e.event_name ?? <Tag s="warn">undecoded</Tag>}</td>
              <td className="small mono" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.args ? Object.entries(e.args).filter(([k]) => !/^\d+$/.test(k)).map(([k, v]) => `${k}=${String(v).length > 18 ? String(v).slice(0, 10) + '…' : v}`).join(' ') : e.decode_error}</td>
              <td><Tag s="info">{e.interface}</Tag>{e.correlation_key && <span title="has a correlated observation on the other interface"> ⇄</span>}</td>
              <td><Tag s={e.finality} /></td>
              <td><Hash v={e.tx_hash} n={6} /></td>
            </tr>)}
          </tbody></table></div> : <div className="empty"><b>No events match</b>{filters.length ? 'Clear filters to see everything indexed so far.' : 'Nothing indexed yet for this project’s contracts.'}</div>}
          <div className="pager"><button className="btn sm" disabled={cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>← Newer</button><span className="small faint">page {cursors.length}</span><button className="btn sm" disabled={!d.nextCursor} onClick={() => setCursors([...cursors, d.nextCursor])}>Older →</button></div>
        </>}</Async>
      </Card>
    </div>
  );
}

export function EventDetail({ p }: { p: any }) {
  const { eid } = useParams();
  const q = useApi<any>(`/events/${encodeURIComponent(eid!)}`, [eid]);
  return (
    <div className="content">
      <Async q={q}>{(e) => <>
        <PageHead crumbs={<Link to={`/p/${p.slug}/events`}>Event Explorer</Link>} title={<>{e.event_name ?? 'Undecoded event'} <Tag s={e.finality} /></>} sub={<>{e.contractAlias} · block #{e.block_number} · {e.interface}</>} />
        <div className="split">
          <div className="stack">
            <Card title="Decoded arguments" right={<span className="small faint">decoder {e.decoder_version}</span>}>{e.args ? <KV items={Object.entries(e.args).filter(([k]) => !/^\d+$/.test(k)).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('0x') ? <Hash v={v} n={14} /> : <span className="mono">{String(v)}</span>])} /> : <ErrorBox error={new Error(e.decode_error ?? 'not decoded')} />}</Card>
            <Card title="Raw evidence" right={<Src kind="hist" />}><Json v={e.raw} /></Card>
          </div>
          <div className="stack">
            <Card title="Location"><KV items={[['Event id', <span className="mono small">{e.id}</span>], ['Network', e.network_id], ['Block', <span className="mono">#{e.block_number}</span>], ['Block hash', <Hash v={e.block_hash} />], ['Tx / extrinsic', <Hash v={e.tx_hash} />], ['Log index', e.log_index], ['Contract', <Hash v={e.address} />], ['Observed', <Time t={e.observed_at} />]]} /></Card>
            <Card title="EVM ⇄ native correlation">
              {e.correlation.pairs.length ? <><Tag s={e.correlation.verified ? 'verified' : 'unknown'}>{e.correlation.verified ? 'verified link' : 'key match, hash not verified'}</Tag><ul className="small">{e.correlation.pairs.map((x: any) => <li key={x.id}><Link to={`/p/${p.slug}/events/${encodeURIComponent(x.id)}`}>{x.interface} observation</Link></li>)}</ul></> : <Tag s="">no linked observation</Tag>}
              <div className="small faint" style={{ marginTop: 6 }}>Rule: {e.correlation.rule}</div>
            </Card>
            <Card title="Triggered executions">{e.triggered.length ? <ul className="small">{e.triggered.map((x: any) => <li key={x.id}><Link to={`/p/${p.slug}/executions/${x.id}`}>{x.name}</Link> <Tag s={x.state} /></li>)}</ul> : <span className="small faint">None</span>}</Card>
          </div>
        </div>
      </>}</Async>
    </div>
  );
}
void api;
