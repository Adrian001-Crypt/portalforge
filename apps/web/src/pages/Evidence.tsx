import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, Hash, Json, KV, ErrorBox, Src, downloadJson } from '../ui';

export function EvidenceList({ p }: { p: any }) {
  const q = useApi<{ items: any[] }>(`/projects/${p.id}/evidence`, [p.id]);
  const nav = useNavigate();
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Evidence" sub="Content hashes of execution results bound on-chain in EvidenceRegistry. A registration proves who bound which hash when — not that the content is true." />
      <Card flush><Async q={q}>{(d) => d.items.length ? <table className="t"><thead><tr><th>Evidence id</th><th>Kind</th><th>Content hash</th><th>Status</th><th>Tx</th><th>Last verification</th><th>Created</th></tr></thead><tbody>
        {d.items.map((e) => <tr key={e.id} className="click" onClick={() => nav(`/p/${p.slug}/evidence/${e.id}`)}><td><Hash v={e.evidence_id} n={8} /></td><td>{e.kind}</td><td><Hash v={e.content_hash} n={8} /></td><td><Tag s={e.status} /></td><td><Hash v={e.tx_hash} n={6} /></td><td>{e.verification ? <Tag s={e.verification.ok ? 'pass' : 'fail'}>{e.verification.ok ? 'verified' : 'failed'}</Tag> : <span className="faint small">never</span>}</td><td><Time t={e.created_at} /></td></tr>)}
      </tbody></table> : <div className="empty"><b>No evidence yet</b>Workflows with an evidence step create records here.</div>}</Async></Card>
    </div>
  );
}

export function EvidenceDetail({ p }: { p: any }) {
  const { id } = useParams();
  const q = useApi<any>(`/evidence/${id}`, [id]);
  const [v, setV] = useState<any>(null); const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="content"><Async q={q}>{(e) => <>
      <PageHead crumbs={<Link to={`/p/${p.slug}/evidence`}>Evidence</Link>} title={<>Evidence <Hash v={e.evidence_id} n={10} /></>} sub={<><Tag s={e.status} /> · {e.kind} · {e.network_id}</>}
        actions={<><button className="btn" onClick={() => downloadJson('evidence-content.json', e.content)}>Download content</button><button className="btn primary" disabled={busy || !e.registry} onClick={async () => { setBusy(true); setErr(null); try { setV(await api(`/evidence/${e.id}/verify`, { method: 'POST' })); } catch (x) { setErr(x); } finally { setBusy(false); } }}>{busy ? 'Verifying…' : 'Verify against chain'}</button></>} />
      <ErrorBox error={err} />
      <div className="split">
        <div className="stack">
          <Card title="Local vs on-chain" right={<Src kind="live" />}>
            <KV items={[['Hash computed here', <Hash v={e.localHash} />], ['Hash stored at creation', <Hash v={e.content_hash} />], ['Match', e.localHash === e.content_hash ? <Tag s="pass">identical</Tag> : <Tag s="fail">differs</Tag>], ['Registry', <Hash v={e.registry} />], ['Registered in tx', <Hash v={e.tx_hash} />], ['Block', e.block_number ? `#${e.block_number}` : '—'], ['Canonicalization', <span className="small">{e.canonicalization}</span>]]} />
            {(v ?? e.verification) && <table className="t" style={{ marginTop: 12 }}><tbody>{(v ?? e.verification).checks.map((c: any) => <tr key={c.id}><td><Tag s={c.status} /></td><td className="small"><div className="mono">{c.id}</div><div className="faint">{c.detail}</div></td></tr>)}</tbody></table>}
            <div className="small faint" style={{ marginTop: 8 }}>Independent check: <code>pf evidence verify {e.id}</code> re-reads the registry from RPC without trusting this server.</div>
          </Card>
          <Card title="Content (canonical JSON input)"><Json v={e.content} /></Card>
        </div>
        <Card title="Scope of this proof"><ul className="small" style={{ margin: 0, paddingLeft: 18 }}><li>Proves: the writer address bound this exact content hash to this evidence id, in a canonical block of this network.</li><li>Does not prove: that the off-chain computation was correct, that the report is true, or anything about other chains.</li><li>Revocation by the original writer is permanent and shows as “revoked”.</li></ul>
          {e.execution_id && <div style={{ marginTop: 10 }}><Link className="btn sm" to={`/p/${p.slug}/executions/${e.execution_id}`}>Open execution</Link></div>}</Card>
      </div>
    </>}</Async></div>
  );
}
