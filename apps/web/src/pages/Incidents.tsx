import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, ErrorBox, toast } from '../ui';
import { canWrite, useSession } from '../session';

export function Incidents({ p }: { p: any }) {
  const [state, setState] = useState('');
  const q = useApi<{ items: any[] }>(`/projects/${p.id}/incidents${state ? `?state=${state}` : ''}`, [p.id, state], { pollMs: 10_000 });
  const nav = useNavigate();
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Incidents" sub="Aggregated alerts for this project and its network. Diagnoses separate facts, rule inference and suggested steps."
        actions={<select value={state} onChange={(e) => setState(e.target.value)} aria-label="State"><option value="">All states</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option></select>} />
      <Card flush><Async q={q}>{(d) => d.items.length ? <table className="t"><thead><tr><th>Incident</th><th>Severity</th><th>State</th><th>Count</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>
        {d.items.map((i) => <tr key={i.id} className="click" onClick={() => nav(`/p/${p.slug}/incidents/${i.id}`)}><td><b>{i.title}</b><div className="small faint">{i.kind}{i.project_id ? '' : ' · network-level'}</div></td><td><Tag s={i.severity} /></td><td><Tag s={i.state} /></td><td>×{i.count}</td><td><Time t={i.first_seen} /></td><td><Time t={i.last_seen} /></td></tr>)}
      </tbody></table> : <div className="empty"><b>No incidents</b>Rules watch RPC reachability, block growth, finality, indexer lag, workflow failures, reverts, code drift and runtime upgrades.</div>}</Async></Card>
    </div>
  );
}

export function IncidentDetail({ p }: { p: any }) {
  const { iid } = useParams();
  const q = useApi<any>(`/incidents/${iid}?project=${p.id}`, [iid]);
  const { me } = useSession();
  const [note, setNote] = useState(''); const [err, setErr] = useState<any>(null); const [explaining, setExplaining] = useState(false);
  const act = async (a: string) => { setErr(null); try { await api(`/incidents/${iid}/${a}`, { method: 'POST', body: { note, project: p.id } }); toast(`Incident ${a}d`); q.reload(); } catch (x) { setErr(x); } };
  const refLink = (r: any) => r.type === 'execution' ? `/p/${p.slug}/executions/${r.id}` : r.type === 'workflow' ? `/p/${p.slug}/workflows/${r.id}` : r.type === 'contract' ? `/p/${p.slug}/contracts/${r.id}` : r.type === 'rpc_endpoint' ? '/network' : r.type === 'cursor' ? '/integrations' : null;
  return (
    <div className="content"><Async q={q}>{(i) => <>
      <PageHead crumbs={<Link to={`/p/${p.slug}/incidents`}>Incidents</Link>} title={i.title} sub={<><Tag s={i.severity} /> <Tag s={i.state} /> · {i.kind} · ×{i.count} · first <Time t={i.first_seen} /> · last <Time t={i.last_seen} /></>}
        actions={me?.user && canWrite(p.role, 'control') && <><input placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />{i.state === 'open' && <button className="btn" onClick={() => act('acknowledge')}>Acknowledge</button>}{i.state !== 'resolved' && <button className="btn primary" onClick={() => act('resolve')}>Resolve</button>}</>} />
      <ErrorBox error={err} />
      <div className="split">
        <div className="stack">
          <Card title="Facts" right={<span className="small faint">observed, with evidence links</span>}><table className="t"><tbody>{i.facts.map((f: any, k: number) => <tr key={k}><td className="muted small">{f.label}</td><td className="mono small" style={{ overflowWrap: 'anywhere' }}>{f.ref ? <Link to={`/p/${p.slug}${f.ref}`}>{f.value}</Link> : f.value}</td></tr>)}</tbody></table></Card>
          <Card title="Inference" right={<span className="tag info plain">{i.inference?.source}</span>}><p style={{ margin: 0 }}>{i.inference?.text}</p></Card>
          <Card title="Suggested recovery"><ol style={{ margin: 0, paddingLeft: 18 }}>{i.suggestion?.map((s: string, k: number) => <li key={k}>{s}</li>)}</ol><div className="small faint" style={{ marginTop: 8 }}>Suggestions are never executed automatically.</div></Card>
          {me?.user && canWrite(p.role, 'control') && <Card title="Model explanation (optional)" right={<button className="btn sm" disabled={explaining} onClick={async () => { setExplaining(true); setErr(null); try { await api(`/incidents/${iid}/explain`, { method: 'POST', body: { project: p.id } }); q.reload(); } catch (x) { setErr(x); } finally { setExplaining(false); } }}>{explaining ? 'Asking…' : 'Explain'}</button>}><div className="small muted">Sends only the recorded facts to a configured model. Output is labelled and cannot trigger actions. If no model is configured, the rule diagnosis above is the diagnosis.</div></Card>}
        </div>
        <div className="stack">
          <Card title="Timeline"><ul className="timeline">{i.timeline.map((e: any) => <li key={e.id} className={e.kind === 'resolved' ? 'ok' : e.kind === 'opened' || e.kind === 'reopened' ? 'bad' : 'info'}><b className="small">{e.kind}</b> <span className="small faint">by {e.actor} · <Time t={e.at} /></span>{e.detail?.note && <div className="small">{e.detail.note}</div>}{e.kind === 'explanation' && <div className="small"><span className="tag warn plain">{e.detail.model} · {e.detail.label}</span><p>{e.detail.text}</p></div>}</li>)}</ul></Card>
          <Card title="Affected resources">{i.refs.length ? <ul className="small">{i.refs.map((r: any, k: number) => <li key={k}>{r.type}: {refLink(r) ? <Link to={refLink(r)!}>{r.id}</Link> : r.id}</li>)}</ul> : <span className="small faint">none recorded</span>}</Card>
          <Card title="Notifications">{i.notifications.length ? <ul className="small">{i.notifications.map((n: any) => <li key={n.id}><Tag s={n.status} /> {n.response_code ?? ''} {n.error ?? ''} <Time t={n.at} /></li>)}</ul> : <span className="small faint">No channel matched or none configured.</span>}</Card>
        </div>
      </div>
    </>}</Async></div>
  );
}
