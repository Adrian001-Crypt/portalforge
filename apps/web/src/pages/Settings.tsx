import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, ErrorBox, toast, downloadJson, Tabs } from '../ui';
import { canWrite, useSession } from '../session';

export function Settings({ p, reload }: { p: any; reload: () => void }) {
  const [tab, setTab] = useState('general');
  const { me } = useSession();
  const owner = !!me?.user && p.role === 'owner';
  const writer = !!me?.user && canWrite(p.role, 'resource');
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Settings" sub="Members and roles, API keys, connectors, executor allowlist, notifications, export/import." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'general', label: 'General & members' }, { id: 'keys', label: 'API keys' }, { id: 'connectors', label: 'Connectors' }, { id: 'policies', label: 'Executor allowlist' }, { id: 'channels', label: 'Notifications' }, { id: 'export', label: 'Export / import' }]} />
      {tab === 'general' && <General p={p} owner={owner} reload={reload} />}
      {tab === 'keys' && (owner ? <Keys p={p} /> : <div className="notice">Only owners manage API keys.</div>)}
      {tab === 'connectors' && <Connectors p={p} writer={writer} />}
      {tab === 'policies' && <Policies p={p} writer={writer} />}
      {tab === 'channels' && <Channels p={p} writer={!!me?.user && canWrite(p.role, 'control')} />}
      {tab === 'export' && <ExportImport p={p} writer={writer} />}
    </div>
  );
}

function General({ p, owner, reload }: { p: any; owner: boolean; reload: () => void }) {
  const [f, setF] = useState({ name: p.name, description: p.description, environment: p.environment, visibility: p.visibility });
  const [m, setM] = useState({ handle: '', role: 'viewer' }); const [err, setErr] = useState<any>(null);
  return <div className="grid g2">
    <Card title="Project">{owner ? <div className="form">
      <label className="f">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="f">Description<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label className="f">Environment<select value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}><option>development</option><option>testnet</option><option>demo</option></select></label>
      <label className="f">Visibility<select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}><option value="private">Private</option><option value="public_readonly">Public read-only demo</option></select></label>
      <button className="btn primary" onClick={async () => { try { await api(`/projects/${p.id}`, { method: 'PATCH', body: f }); toast('Saved'); reload(); } catch (x) { setErr(x); } }}>Save</button></div> : <div className="small muted">{p.name} · {p.environment} · {p.visibility} · network {p.network_id}</div>}</Card>
    <Card title="Members (platform roles)" flush>
      <table className="t"><tbody>{p.members.map((x: any) => <tr key={x.handle}><td>{x.handle}</td><td><Tag s="info">{x.role}</Tag></td><td>{owner && <button className="btn sm danger" onClick={async () => { try { await api(`/projects/${p.id}/members/${x.handle}`, { method: 'DELETE' }); reload(); } catch (e) { setErr(e); } }}>Remove</button>}</td></tr>)}</tbody></table>
      {owner && <form className="row" style={{ padding: 12 }} onSubmit={async (e) => { e.preventDefault(); try { await api(`/projects/${p.id}/members`, { method: 'POST', body: m }); reload(); } catch (x) { setErr(x); } }}><input placeholder="handle" value={m.handle} onChange={(e) => setM({ ...m, handle: e.target.value })} /><select value={m.role} onChange={(e) => setM({ ...m, role: e.target.value })}><option>owner</option><option>developer</option><option>operator</option><option>viewer</option></select><button className="btn">Add / change</button></form>}
      <div className="small faint" style={{ padding: '0 12px 12px' }}>Owner: everything · Developer: contracts, workflows, connectors · Operator: run, approve, cancel, incidents · Viewer: read. These roles do not grant any on-chain permission.</div>
    </Card>
    <ErrorBox error={err} />
  </div>;
}

function Keys({ p }: { p: any }) {
  const q = useApi<{ items: any[] }>(`/projects/${p.id}/api-keys`, [p.id]);
  const [name, setName] = useState(''); const [scopes, setScopes] = useState<string[]>(['read']); const [secret, setSecret] = useState<string | null>(null); const [err, setErr] = useState<any>(null);
  return <div className="split">
    <Card title="Keys" flush><Async q={q}>{(d) => d.items.length ? <table className="t"><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th /></tr></thead><tbody>{d.items.map((k) => <tr key={k.id}><td>{k.name}</td><td className="mono">pf_{k.prefix}_…</td><td className="small">{k.scopes.join(', ')}</td><td><Time t={k.last_used_at} /></td><td>{k.revoked_at ? <Tag s="void">revoked</Tag> : <button className="btn sm danger" onClick={async () => { await api(`/projects/${p.id}/api-keys/${k.id}`, { method: 'DELETE' }); q.reload(); }}>Revoke</button>}</td></tr>)}</tbody></table> : <div className="empty"><b>No API keys</b></div>}</Async></Card>
    <Card title="Create key"><div className="form"><input placeholder="name (e.g. ci)" value={name} onChange={(e) => setName(e.target.value)} />
      {['read', 'events:read', 'workflow:run', 'evidence:write'].map((s) => <label key={s} className="small row"><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />{s}</label>)}
      <button className="btn primary" disabled={!name || !scopes.length} onClick={async () => { setErr(null); try { const r = await api(`/projects/${p.id}/api-keys`, { method: 'POST', body: { name, scopes } }); setSecret(r.secret); q.reload(); } catch (x) { setErr(x); } }}>Create</button>
      {secret && <div className="notice warn small">Copy now — shown once:<div className="mono" style={{ overflowWrap: 'anywhere' }}>{secret}</div></div>}<ErrorBox error={err} /></div></Card>
  </div>;
}

function Connectors({ p, writer }: { p: any; writer: boolean }) {
  const q = useApi<{ items: any[] }>(`/projects/${p.id}/connectors`, [p.id]);
  const [f, setF] = useState({ name: '', url: '', queryUrl: '' }); const [err, setErr] = useState<any>(null);
  return <div className="split">
    <Card title="Connectors (webhook targets)" flush><Async q={q}>{(d) => d.items.length ? <table className="t"><thead><tr><th>Name</th><th>POST URL</th><th>Result query</th><th>Network scope</th></tr></thead><tbody>{d.items.map((c) => <tr key={c.id}><td><b>{c.name}</b></td><td className="mono small">{c.url}</td><td className="mono small">{c.query_url ?? <span className="warn-t">none — unknown outcomes need an operator</span>}</td><td>{c.allow_private_host ? <Tag s="warn">private host (local only)</Tag> : <Tag s="ok">public only</Tag>}</td></tr>)}</tbody></table> : <div className="empty"><b>No connectors</b></div>}</Async></Card>
    {writer && <Card title="Add connector"><div className="form"><input placeholder="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><input placeholder="https://… (POST)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /><input placeholder="https://… (GET {url}/{executionId}) — recommended" value={f.queryUrl} onChange={(e) => setF({ ...f, queryUrl: e.target.value })} />
      <button className="btn primary" onClick={async () => { setErr(null); try { await api(`/projects/${p.id}/connectors`, { method: 'POST', body: { ...f, queryUrl: f.queryUrl || null } }); q.reload(); } catch (x) { setErr(x); } }}>Save</button><ErrorBox error={err} />
      <div className="small faint">Targets are resolved at request time; private, loopback and link-local addresses are refused; redirects are not followed. Receivers get <code>Idempotency-Key</code> = executionId.</div></div></Card>}
  </div>;
}

function Policies({ p, writer }: { p: any; writer: boolean }) {
  const q = useApi<{ items: any[] }>(`/projects/${p.id}/policies`, [p.id]);
  const [f, setF] = useState({ contractAlias: 'jobs', functionName: 'completeJob', maxCallsPerHour: 20, maxFeeWei: '5000000000000000000' }); const [err, setErr] = useState<any>(null);
  return <div className="split">
    <Card title="Allowlisted executor calls" flush><Async q={q}>{(d) => d.items.length ? <table className="t"><thead><tr><th>Contract.function</th><th>Calls / hour</th><th>Max fee (wei)</th><th>Status</th></tr></thead><tbody>{d.items.map((x) => <tr key={x.id}><td className="mono">{x.contract_alias}.{x.function_name}</td><td>{x.max_calls_per_hour}</td><td className="mono small">{x.max_fee_wei}</td><td><Tag s={x.enabled ? 'active' : 'void'}>{x.enabled ? 'enabled' : 'disabled'}</Tag></td></tr>)}</tbody></table> : <div className="empty"><b>Nothing allowlisted</b>Contract write steps will be refused.</div>}</Async></Card>
    {writer && <Card title="Allow a function"><div className="form"><input value={f.contractAlias} onChange={(e) => setF({ ...f, contractAlias: e.target.value })} aria-label="Contract alias" /><input value={f.functionName} onChange={(e) => setF({ ...f, functionName: e.target.value })} aria-label="Function" /><label className="f">Calls / hour<input type="number" value={f.maxCallsPerHour} onChange={(e) => setF({ ...f, maxCallsPerHour: Number(e.target.value) })} /></label><label className="f">Max fee per call (wei, 18 dp)<input value={f.maxFeeWei} onChange={(e) => setF({ ...f, maxFeeWei: e.target.value })} /></label>
      <button className="btn primary" onClick={async () => { setErr(null); try { await api(`/projects/${p.id}/policies`, { method: 'POST', body: f }); q.reload(); } catch (x) { setErr(x); } }}>Save</button><ErrorBox error={err} />
      <div className="small faint">Only nonpayable functions of registered contracts. The executor never calls arbitrary addresses, payable functions, or approvals.</div></div></Card>}
  </div>;
}

function Channels({ p, writer }: { p: any; writer: boolean }) {
  const q = useApi<any>(`/projects/${p.id}/channels`, [p.id]);
  const [f, setF] = useState({ connector: '', minSeverity: 'warning' }); const [err, setErr] = useState<any>(null);
  return <div className="split"><Card title="Channels & deliveries" flush><Async q={q}>{(d) => <>{d.items.length ? <table className="t"><tbody>{d.items.map((c: any) => <tr key={c.id}><td>{c.kind} → {c.connector}</td><td>≥ <Tag s={c.min_severity} /></td></tr>)}</tbody></table> : <div className="empty"><b>No channels</b></div>}
    {d.recent.length > 0 && <table className="t"><thead><tr><th>Delivery</th><th>Code</th><th>When</th></tr></thead><tbody>{d.recent.map((n: any) => <tr key={n.id}><td><Tag s={n.status} /> {n.error}</td><td>{n.response_code}</td><td><Time t={n.at} /></td></tr>)}</tbody></table>}</>}</Async></Card>
    {writer && <Card title="Add webhook channel"><div className="form"><input placeholder="connector name" value={f.connector} onChange={(e) => setF({ ...f, connector: e.target.value })} /><select value={f.minSeverity} onChange={(e) => setF({ ...f, minSeverity: e.target.value })}><option>info</option><option>warning</option><option>critical</option></select><button className="btn primary" onClick={async () => { setErr(null); try { await api(`/projects/${p.id}/channels`, { method: 'POST', body: f }); q.reload(); } catch (x) { setErr(x); } }}>Add</button><ErrorBox error={err} /></div></Card>}</div>;
}

function ExportImport({ p, writer }: { p: any; writer: boolean }) {
  const [cfg, setCfg] = useState(''); const [res, setRes] = useState<any>(null); const [err, setErr] = useState<any>(null);
  return <div className="grid g2">
    <Card title="Export configuration"><p className="small muted">Contracts (with ABI), workflow definitions, connectors and policies. Never includes sessions, key hashes, signed transactions or executor keys.</p><button className="btn" onClick={async () => { try { downloadJson(`${p.slug}-config.json`, await api(`/projects/${p.id}/export`)); } catch (x) { setErr(x); } }}>Download export</button></Card>
    {writer && <Card title="Validate configuration"><textarea rows={8} value={cfg} onChange={(e) => setCfg(e.target.value)} aria-label="Config JSON" /><button className="btn" style={{ marginTop: 8 }} onClick={async () => { setErr(null); try { setRes(await api(`/projects/${p.id}/import/validate`, { method: 'POST', body: JSON.parse(cfg) })); } catch (x) { setErr(x); } }}>Validate</button>
      {res && (res.ok ? <div className="notice ok small">Configuration is valid for this project.</div> : <div className="notice bad small"><ul>{res.issues.map((i: any, k: number) => <li key={k}><code>{i.path}</code> {i.message}</li>)}</ul></div>)}</Card>}
    <ErrorBox error={err} />
  </div>;
}
