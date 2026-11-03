import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Stat, Tag, Time, ErrorBox, Hash, Src, NetworkBadge, NotDeployed } from '../ui';
import { useSession } from '../session';

export function Projects() {
  const q = useApi<{ items: any[] }>('/projects');
  const nets = useApi<{ items: any[] }>('/networks');
  const { me } = useSession();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', slug: '', description: '', environment: 'development', networkId: '' });
  const [err, setErr] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { const p = await api('/projects', { method: 'POST', body: { ...f, networkId: f.networkId || nets.data?.items[0]?.id } }); nav(`/p/${p.slug}`); } catch (x) { setErr(x); }
  };
  return (
    <div className="content">
      <PageHead title="Projects" sub="Each project groups contracts, workflows, connectors, incidents and evidence on one network." />
      <div className="split">
        <Card title="All projects" right={<input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter projects" />} flush>
          <Async q={q}>{(d) => {
            const rows = d.items.filter((p) => !filter || `${p.name} ${p.slug}`.toLowerCase().includes(filter.toLowerCase()));
            return rows.length ? <div className="table-wrap"><table className="t"><thead><tr><th>Project</th><th>Environment</th><th>Network</th><th>Your role</th><th>Visibility</th><th>Created</th></tr></thead>
              <tbody>{rows.map((p) => <tr key={p.id} className="click" onClick={() => nav(`/p/${p.slug}`)}><td><b>{p.name}</b><div className="small faint">{p.slug}</div></td><td><Tag s="info">{p.environment}</Tag></td><td><NetworkBadge id={p.network_id} /></td><td>{p.role}</td><td>{p.visibility === 'public_readonly' ? <Tag s="info">public read-only</Tag> : <Tag s="">private</Tag>}</td><td><Time t={p.created_at} /></td></tr>)}</tbody></table></div>
              : <div className="empty"><b>No matching projects</b></div>;
          }}</Async>
        </Card>
        <Card title="Create project">
          {me?.user ? (
            <form className="form" onSubmit={create}>
              <label className="f">Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} /></label>
              <label className="f">Slug<input required pattern="[a-z0-9][a-z0-9-]{1,40}" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} /></label>
              <label className="f">Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
              <label className="f">Environment<select value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}><option value="development">Development</option><option value="testnet">Testnet</option><option value="demo">Demo</option></select></label>
              <label className="f">Network<select value={f.networkId} onChange={(e) => setF({ ...f, networkId: e.target.value })}>{nets.data?.items.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
              <ErrorBox error={err} />
              <button className="btn primary">Create project</button>
              <div className="small faint">You become the Owner. Platform roles control PortalForge only; contract permissions stay on-chain.</div>
            </form>
          ) : <div className="muted">Sign in to create projects. Visitors can browse public read-only demo projects.</div>}
        </Card>
      </div>
    </div>
  );
}

export function ProjectHome({ p }: { p: any; reload: () => void }) {
  const ix = useApi<any>(`/projects/${p.id}/indexer`, [p.id], { pollMs: 10_000 });
  const ex = useApi<any>(`/projects/${p.id}/executions?limit=8`, [p.id], { pollMs: 10_000 });
  const inc = useApi<any>(`/projects/${p.id}/incidents?state=open`, [p.id]);
  const audit = useApi<any>(p.role !== 'public' ? `/projects/${p.id}/audit?limit=8` : null, [p.id]);
  const base = `/p/${p.slug}`;
  return (
    <div className="content">
      <PageHead crumbs={<Link to="/projects">Projects</Link>} title={p.name} sub={<>{p.description || 'No description'} · <NetworkBadge id={p.network_id} /> · environment {p.environment} · your role <b>{p.role}</b></>}
        actions={<><Link className="btn" to={`${base}/workflows`}>Workflows</Link><Link className="btn primary" to={`${base}/deployments`}>Deploy</Link></>} />
      {p.stats.contracts === 0 && <NotDeployed networkId={p.network_id} />}
      {p.role === 'public' && <div className="notice" style={{ marginBottom: 14 }}>You are viewing a public read-only project. Data is real for its network; actions that change state are disabled.</div>}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label="Contracts" value={p.stats.contracts} hint={<Link to={`${base}/contracts`}>workspace →</Link>} />
        <Stat label="Workflows" value={p.stats.workflows} hint={<Link to={`${base}/workflows`}>builder →</Link>} />
        <Stat label="Executions" value={p.stats.executions} hint={ex.data ? Object.entries(ex.data.counts).map(([k, v]) => `${k} ${v}`).join(' · ') : ''} />
        <Stat label="Open incidents" value={p.stats.openIncidents} hint={<Link to={`${base}/incidents`}>incidents →</Link>} />
      </div>
      <div className="grid g2">
        <Card title="Indexer coverage" right={<Src kind="live" />} flush>
          <Async q={ix}>{(d) => d.streams.length ? <table className="t"><thead><tr><th>Stream</th><th>Coverage</th><th>Head</th><th>Lag</th><th>Status</th></tr></thead><tbody>
            {d.streams.map((s: any) => <tr key={s.stream_id}><td>{s.interface === 'native' ? 'native events' : s.alias ?? <Hash v={s.address} />}<div className="small faint">{s.interface}</div></td><td className="mono">#{s.coverage.from} → #{s.coverage.to}</td><td className="mono">#{s.head_seen ?? '—'}</td><td>{s.lag ?? '—'}</td><td>{s.last_error && (!s.last_success_at || s.last_error_at > s.last_success_at) ? <Tag s="failed">{s.last_error.slice(0, 60)}</Tag> : <Tag s="alive">ok</Tag>}</td></tr>)}
          </tbody></table> : <div className="empty"><b>No streams yet</b>Register or deploy a contract to start indexing from its deploy block.</div>}</Async>
        </Card>
        <Card title="Recent executions" right={<Link className="btn sm" to={`${base}/executions`}>All</Link>} flush>
          <Async q={ex}>{(d) => d.items.length ? <table className="t"><tbody>{d.items.map((x: any) => <tr key={x.id}><td><Link to={`${base}/executions/${x.id}`}><Hash v={x.id} n={8} /></Link><div className="small faint">{x.workflow} v{x.version}</div></td><td><Tag s={x.state} /></td><td className="small"><Time t={x.created_at} /></td></tr>)}</tbody></table> : <div className="empty"><b>No executions yet</b></div>}</Async>
        </Card>
        <Card title="Open incidents" flush>
          <Async q={inc}>{(d) => d.items.length ? <table className="t"><tbody>{d.items.slice(0, 6).map((i: any) => <tr key={i.id}><td><Link to={`${base}/incidents/${i.id}`}>{i.title}</Link><div className="small faint">{i.kind} · ×{i.count}</div></td><td><Tag s={i.severity} /></td><td className="small"><Time t={i.last_seen} /></td></tr>)}</tbody></table> : <div className="empty"><b>No open incidents</b></div>}</Async>
        </Card>
        {audit.data && <Card title="Activity (audit log)" flush><table className="t"><tbody>{audit.data.items.map((a: any) => <tr key={a.id}><td className="small"><b>{a.action}</b> <span className="faint">{a.target}</span></td><td className="small muted">{a.actor}</td><td className="small"><Time t={a.at} /></td></tr>)}</tbody></table></Card>}
      </div>
    </div>
  );
}
