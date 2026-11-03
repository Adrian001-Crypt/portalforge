import { Link } from 'react-router-dom';
import { useApi, Async, Card, PageHead, Stat, Tag, Time, Src, Hash } from '../ui';
import { useSession } from '../session';

export function Overview() {
  const projects = useApi<{ items: any[] }>('/projects');
  const networks = useApi<{ items: any[] }>('/networks', [], { pollMs: 20_000 });
  const health = useApi<any>('/health', [], { pollMs: 15_000 });
  const { me } = useSession();
  return (
    <div className="content">
      <PageHead title="Overview" sub="Develop, observe and automate Portaldot applications — from deployment to verifiable execution evidence." />
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Stat label="Projects visible" value={projects.data?.items.length ?? '…'} hint={me?.user ? `signed in as ${me.user.handle}` : 'public projects only'} />
        <Stat label="Executions" value={projects.data?.items.reduce((s, p) => s + p.stats.executions, 0) ?? '…'} hint="across visible projects" />
        <Stat label="Open incidents" value={projects.data?.items.reduce((s, p) => s + p.stats.openIncidents, 0) ?? '…'} />
        <Stat label="Services" value={health.data ? `${health.data.services.filter((s: any) => s.alive).length}/${health.data.services.length}` : '…'} hint="alive by heartbeat" />
      </div>
      <div className="split">
        <Card title="Projects" right={<Link className="btn sm" to="/projects">All projects</Link>} flush>
          <Async q={projects}>{(d) => d.items.length ? (
            <table className="t"><thead><tr><th>Name</th><th>Network</th><th>Role</th><th>Contracts</th><th>Workflows</th><th>Incidents</th></tr></thead><tbody>
              {d.items.map((p) => <tr key={p.id}><td><Link to={`/p/${p.slug}`}>{p.name}</Link><div className="small faint">{p.environment}</div></td><td className="small">{p.network_id}</td><td><Tag s={p.role === 'public' ? 'info' : 'active'}>{p.role}</Tag></td><td>{p.stats.contracts}</td><td>{p.stats.workflows}</td><td>{p.stats.openIncidents ? <Tag s="open">{p.stats.openIncidents}</Tag> : 0}</td></tr>)}
            </tbody></table>) : <div className="empty"><b>No projects yet</b>Sign in and create one on the Projects page.</div>}</Async>
        </Card>
        <Card title="Networks" right={<Link className="btn sm" to="/network">Health</Link>}>
          <Async q={networks}>{(d) => <div className="stack">{d.items.map((n) => (
            <div key={n.id}>
              <div className="row"><b>{n.name}</b>{n.kind === 'local-dev' ? <Src kind="local" /> : <Src kind="live" />}</div>
              <div className="small muted">EVM chainId {n.evm.chainId}{n.native && <> · native {n.native.token.symbol} ({n.native.token.decimals} dp) · ss58 {n.native.ss58Format}</>}</div>
              {n.endpoints.map((e: any) => <div key={e.id} className="row small" style={{ marginTop: 4 }}><Tag s={e.stats.insufficient ? 'unknown' : e.stats.availability > 0.95 ? 'alive' : 'failed'}>{e.interface}</Tag><span className="muted">{e.stats.insufficient ? 'insufficient data' : `head #${e.stats.head} · p50 ${e.stats.p50}ms · ${(e.stats.availability * 100).toFixed(0)}% ok`}</span></div>)}
              {n.native && <div className="small faint" style={{ marginTop: 4 }}>genesis <Hash v={n.native.genesisHash} n={8} /> · last probe <Time t={n.lastProbeAt} /></div>}
            </div>))}</div>}</Async>
        </Card>
      </div>
      <Card title="How PortalForge works">
        <ol className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li><b>Deploy & register</b> template contracts with live simulation, exact storage-deposit preview and a verifiable manifest.</li>
          <li><b>Index</b> EVM logs and native Revive events from the deploy block with persisted cursors, reorg handling and finality.</li>
          <li><b>Automate</b> with versioned workflows: events → conditions → idempotent HTTP → allowlisted contract writes → evidence.</li>
          <li><b>Recover</b> from RPC outages, lost responses and worker crashes: intents are persisted first and outcomes reconciled, never blindly resent.</li>
          <li><b>Verify</b> deployments and evidence against the chain from the console or with <code>pf</code>.</li>
        </ol>
      </Card>
    </div>
  );
}
