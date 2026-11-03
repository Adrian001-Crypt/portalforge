import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, Hash, KV, Json, ErrorBox, toast } from '../ui';
import { canWrite, useSession } from '../session';

const STATES = ['queued', 'running', 'awaiting_approval', 'broadcasting', 'pending', 'unknown', 'succeeded', 'failed', 'cancelled', 'dead_letter'];

export function Executions({ p }: { p: any }) {
  const [sp, setSp] = useSearchParams();
  const state = sp.get('state') ?? '';
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const qs = new URLSearchParams({ limit: '40', ...(state ? { state } : {}), ...(sp.get('q') ? { q: sp.get('q')! } : {}), ...(cursors.at(-1) ? { cursor: String(cursors.at(-1)) } : {}) }).toString();
  const q = useApi<any>(`/projects/${p.id}/executions?${qs}`, [qs], { pollMs: 5000 });
  const nav = useNavigate();
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Executions" sub="Every run is bound to a workflow version, a trigger identity and an input hash." />
      {q.data && <div className="row" style={{ marginBottom: 12 }}>
        <button className={`btn sm ${!state ? 'primary' : ''}`} onClick={() => { setSp({}); setCursors([null]); }}>All</button>
        {STATES.filter((s) => q.data.counts[s]).map((s) => <button key={s} className={`btn sm ${state === s ? 'primary' : ''}`} onClick={() => { setSp({ state: s }); setCursors([null]); }}>{s.replace(/_/g, ' ')} · {q.data.counts[s]}</button>)}
        <span style={{ flex: 1 }} /><button className="btn sm" onClick={() => { setSp({ state: 'dead_letter' }); setCursors([null]); }}>Dead-letter queue</button>
      </div>}
      <Card flush>
        <Async q={q}>{(d) => <>
          {d.items.length ? <div className="table-wrap"><table className="t"><thead><tr><th>Execution</th><th>Workflow</th><th>State</th><th>Trigger</th><th>Attempts</th><th>Created</th><th>Finished</th></tr></thead><tbody>
            {d.items.map((x: any) => <tr key={x.id} className="click" onClick={() => nav(`/p/${p.slug}/executions/${x.id}`)}><td><Hash v={x.id} n={8} />{x.replay_of && <div className="small faint">replay</div>}</td><td>{x.workflow} <span className="faint">v{x.version}</span></td><td><Tag s={x.state} />{x.error && <div className="small bad-t" style={{ maxWidth: 280 }}>{x.error.slice(0, 90)}</div>}</td><td className="small">{x.trigger_type}<div className="faint mono">{x.trigger_key.slice(-24)}</div></td><td>{x.attempts}</td><td><Time t={x.created_at} /></td><td><Time t={x.finished_at} /></td></tr>)}
          </tbody></table></div> : <div className="empty"><b>No executions</b>{state ? `None in state "${state}".` : 'Enable a workflow and trigger it (for example request a job on the Contract page).'}</div>}
          <div className="pager"><button className="btn sm" disabled={cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>← Newer</button><button className="btn sm" disabled={!d.nextCursor} onClick={() => setCursors([...cursors, d.nextCursor])}>Older →</button></div>
        </>}</Async>
      </Card>
    </div>
  );
}

const tone = (s: string) => (s === 'succeeded' ? 'ok' : s === 'failed' ? 'bad' : ['unknown', 'retry_wait'].includes(s) ? 'warn' : s === 'skipped' ? '' : 'info');

export function ExecutionDetail({ p }: { p: any }) {
  const { xid } = useParams();
  const q = useApi<any>(`/executions/${xid}`, [xid], { pollMs: 3000 });
  const { me } = useSession();
  const nav = useNavigate();
  const [err, setErr] = useState<any>(null);
  const act = async (path: string, body: unknown, msg: string) => { setErr(null); try { const r = await api(path, { method: 'POST', body }); toast(msg); q.reload(); return r; } catch (x) { setErr(x); } };
  const control = me?.user && canWrite(p.role, 'control');
  return (
    <div className="content">
      <Async q={q}>{(x) => <>
        <PageHead crumbs={<Link to={`/p/${p.slug}/executions`}>Executions</Link>} title={<>Execution <Hash v={x.id} n={10} /></>} sub={<><Tag s={x.state} /> · {x.workflow} v{x.version} · created <Time t={x.created_at} />{x.finished_at && <> · finished <Time t={x.finished_at} /></>}</>}
          actions={control && <>
            {!['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(x.state) && <button className="btn danger" onClick={() => act(`/executions/${x.id}/cancel`, {}, 'Cancel requested')}>Cancel</button>}
            {['failed', 'dead_letter', 'cancelled', 'succeeded'].includes(x.state) && <><button className="btn" onClick={async () => { const r: any = await act(`/executions/${x.id}/replay`, { mode: 'from-failure' }, 'Replay created'); if (r) nav(`/p/${p.slug}/executions/${r.id}`); }}>Replay from failure</button><button className="btn" onClick={async () => { const r: any = await act(`/executions/${x.id}/replay`, { mode: 'full' }, 'Replay created'); if (r) nav(`/p/${p.slug}/executions/${r.id}`); }}>Full replay</button></>}
          </>} />
        <ErrorBox error={err} />
        {x.error && <div className="notice bad" style={{ marginBottom: 14 }}>{x.error}</div>}
        <div className="split">
          <div className="stack">
            <h3>Step trace</h3>
            <div className="steps">{x.steps.map((s: any) => {
              const attempts = x.attempts.filter((a: any) => a.step_id === s.step_id);
              const intents = x.intents.filter((i: any) => i.step_id === s.step_id);
              const approval = x.approvals.find((a: any) => a.step_id === s.step_id);
              const def = x.definition.steps.find((d: any) => d.id === s.step_id);
              return (
                <details key={s.step_id} className="step" open={['failed', 'unknown', 'awaiting_approval', 'running', 'waiting'].includes(s.state)}>
                  <summary><Tag s={s.state} /><b>{def?.name ?? s.step_id}</b><span className="small faint mono">{s.step_id} · {s.type}</span><span className="small muted" style={{ marginLeft: 'auto' }}>{s.attempts} attempt{s.attempts === 1 ? '' : 's'}{s.reused_from && ' · reused from original'}</span></summary>
                  <div className="body">
                    {s.error && <div className={`notice ${s.state === 'failed' ? 'bad' : 'warn'} small`}>{s.error}</div>}
                    {s.state === 'unknown' && control && <div className="row"><span className="small">Outcome unknown. Decide after checking the target:</span>{['retry', 'mark_succeeded', 'fail'].map((d) => <button key={d} className="btn sm" onClick={() => act(`/executions/${x.id}/steps/${s.step_id}/resolve`, { decision: d, note: 'from console' }, `Step ${d}`)}>{d.replace('_', ' ')}</button>)}</div>}
                    {approval && <div className="row small">Approval: <Tag s={approval.state} /> {approval.prompt} {approval.state === 'pending' && control && <><button className="btn sm primary" onClick={() => act(`/approvals/${approval.id}/decide`, { decision: 'approved' }, 'Approved')}>Approve</button><button className="btn sm danger" onClick={() => act(`/approvals/${approval.id}/decide`, { decision: 'rejected', reason: 'rejected in console' }, 'Rejected')}>Reject</button></>} {approval.decided_by && `by ${approval.decided_by}`}</div>}
                    {intents.map((i: any) => <div key={i.id} className="small"><b>Side-effect intent</b> ({i.kind}) <Tag s={i.state} /> key <span className="mono">{i.idempotency_key.slice(-30)}</span>{i.tx_hash && <> · tx <Hash v={i.tx_hash} /> nonce {i.nonce}</>}{i.error && <div className="faint">last error: {i.error}</div>}</div>)}
                    {attempts.length > 0 && <table className="t"><thead><tr><th>#</th><th>Worker</th><th>State</th><th>Started</th><th>Error</th></tr></thead><tbody>{attempts.map((a: any) => <tr key={a.id}><td>{a.attempt}</td><td className="small mono">{a.worker_id}</td><td><span className={`tag ${tone(a.state)}`}>{a.state}</span></td><td className="small"><Time t={a.started_at} /></td><td className="small">{a.error ?? ''}</td></tr>)}</tbody></table>}
                    {attempts[0]?.input != null && <div><h3>Input</h3><Json v={attempts.at(-1).input} /></div>}
                    {s.output != null && <div><h3>Output</h3><Json v={s.output} /></div>}
                  </div>
                </details>
              );
            })}</div>
          </div>
          <div className="stack">
            <Card title="Binding"><KV items={[['Workflow', <Link to={`/p/${p.slug}/workflows/${x.workflow_id}`}>{x.workflow}</Link>], ['Version', `v${x.version}`], ['Definition hash', <Hash v={x.definitionHash} />], ['Trigger', `${x.trigger_type}`], ['Trigger key', <span className="mono small">{x.trigger_key}</span>], ['Input hash', <Hash v={x.input_hash} />], ['Network', x.network_id], ['Result hash', <Hash v={x.result_hash} />], ['Replay of', x.replay_of ? <Link to={`/p/${p.slug}/executions/${x.replay_of}`}><Hash v={x.replay_of} n={8} /></Link> : '—'], ['Lease', x.lease_owner ? `${x.lease_owner} until ${new Date(x.lease_expires_at).toISOString()}` : 'none']]} /></Card>
            {x.trigger?.eventId && <Card title="Trigger event"><KV items={[['Event', x.trigger.event], ['Block', `#${x.trigger.blockNumber}`], ['Tx', <Hash v={x.trigger.txHash} />], ['Finality at trigger', <Tag s={x.trigger.finality} />]]} /><div style={{ marginTop: 8 }}><Link className="btn sm" to={`/p/${p.slug}/events/${encodeURIComponent(x.trigger.eventId)}`}>Open raw event</Link></div></Card>}
            {x.evidence.length > 0 && <Card title="Evidence">{x.evidence.map((e: any) => <div key={e.id} className="small"><Link to={`/p/${p.slug}/evidence/${e.id}`}><Hash v={e.evidence_id} n={8} /></Link> <Tag s={e.status} />{e.tx_hash && <> tx <Hash v={e.tx_hash} n={6} /></>}</div>)}</Card>}
            {x.incidents.length > 0 && <Card title="Related incidents">{x.incidents.map((i: any) => <div key={i.id} className="small"><Link to={`/p/${p.slug}/incidents/${i.id}`}>{i.title}</Link> <Tag s={i.state} /></div>)}</Card>}
            {x.replays.length > 0 && <Card title="Replays">{x.replays.map((r: any) => <div key={r.id} className="small"><Link to={`/p/${p.slug}/executions/${r.id}`}><Hash v={r.id} n={8} /></Link> <Tag s={r.state} /></div>)}</Card>}
          </div>
        </div>
      </>}</Async>
    </div>
  );
}
