import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { encodeFunctionData, type Abi } from 'viem';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, Hash, ErrorBox, KV, Json, Tabs, toast, Src, useSort, NotDeployed, NetworkBadge } from '../ui';
import { canWrite, useSession } from '../session';
import { sendWithIntent, onWalletBroadcast } from '../wallet';

export function Contracts({ p }: { p: any }) {
  const q = useApi<{ items: any[] }>(`/projects/${p.id}/contracts`, [p.id]);
  const nav = useNavigate();
  const { me } = useSession();
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ alias: '', address: '', deployBlock: '', abi: '' });
  const [err, setErr] = useState<any>(null);
  const { sorted, th } = useSort(q.data?.items ?? [], 'created_at' as any);
  const register = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { const abi = JSON.parse(f.abi); const r = await api(`/projects/${p.id}/contracts`, { method: 'POST', body: { alias: f.alias, address: f.address, deployBlock: Number(f.deployBlock), abi: Array.isArray(abi) ? abi : abi.abi } }); toast('Contract registered; indexing starts at its deploy block'); nav(`/p/${p.slug}/contracts/${r.id}`); }
    catch (x) { setErr(x); }
  };
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Contract Workspace" sub="Registered contracts, their ABI versions, live on-chain permissions and indexed events."
        actions={me?.user && canWrite(p.role, 'resource') ? <button className="btn" onClick={() => setShow(!show)}>{show ? 'Close' : 'Register existing contract'}</button> : null} />
      {q.data && q.data.items.length === 0 && <NotDeployed networkId={p.network_id} />}
      {show && <Card title="Register existing contract"><form className="form" onSubmit={register}>
        <div className="grid g3"><label className="f">Alias<input required pattern="[a-z][a-z0-9_-]{1,30}" value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} /></label>
          <label className="f">Address<input required pattern="0x[0-9a-fA-F]{40}" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
          <label className="f">Deploy block (index start)<input required type="number" min={0} value={f.deployBlock} onChange={(e) => setF({ ...f, deployBlock: e.target.value })} /></label></div>
        <label className="f">ABI JSON (array or Foundry artifact)<textarea rows={5} required value={f.abi} onChange={(e) => setF({ ...f, abi: e.target.value })} /></label>
        <ErrorBox error={err} /><div><button className="btn primary">Register (code is checked on chain)</button></div>
      </form></Card>}
      <div style={{ height: show ? 14 : 0 }} />
      <Card title="Contracts" flush>
        <Async q={q}>{() => sorted.length ? <div className="table-wrap"><table className="t"><thead><tr>{th('alias' as any, 'Alias')}<th>Address</th><th>Runtime</th>{th('deploy_block' as any, 'Deploy block')}<th>ABI</th>{th('events' as any, 'Events')}<th>Verification</th></tr></thead><tbody>
          {sorted.map((c: any) => <tr key={c.id} className="click" onClick={() => nav(`/p/${p.slug}/contracts/${c.id}`)}><td><b>{c.alias}</b><div className="small faint">{(c.labels ?? []).join(' · ')}</div></td><td><Hash v={c.address} /></td><td><Tag s="info">{c.runtime}</Tag></td><td className="mono">#{c.deploy_block}</td><td className="small">v{c.active_abi_version} <Hash v={c.abi_hash} n={6} /></td><td>{c.events}{c.decode_errors > 0 && <Tag s="warn">{c.decode_errors} undecoded</Tag>}</td><td>{c.verification ? <Tag s="verified">{c.verification.source}</Tag> : <Tag s="unknown">unverified</Tag>}</td></tr>)}
        </tbody></table></div> : <div className="empty"><b>No contracts registered</b>Deploy a template from Deployments or register an existing address.</div>}</Async>
      </Card>
    </div>
  );
}

export function ContractDetail({ p }: { p: any }) {
  const { cid } = useParams();
  const q = useApi<any>(`/contracts/${cid}`, [cid]);
  const [tab, setTab] = useState('interface');
  return (
    <div className="content">
      <Async q={q}>{(c) => <>
        <PageHead crumbs={<Link to={`/p/${p.slug}/contracts`}>Contract Workspace</Link>} title={c.alias} sub={<><Hash v={c.address} n={20} /> · <NetworkBadge id={c.network_id} /> · deploy block #{c.deploy_block} {c.templateKind && <Tag s="info">{c.templateKind}</Tag>}</>}
          actions={<Link className="btn" to={`/p/${p.slug}/events?contract=${c.alias}`}>Events</Link>} />
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'interface', label: 'Read / write' }, { id: 'permissions', label: 'Permissions' }, { id: 'abi', label: `ABI versions (${c.abis.length})` }, { id: 'meta', label: 'Deployment metadata' }]} />
        {tab === 'interface' && <Interface p={p} c={c} />}
        {tab === 'permissions' && <div className="grid g2">
          <Card title="Who can operate PortalForge" right={<span className="small faint">application roles</span>}>
            <div className="small muted" style={{ marginBottom: 8 }}>{c.permissions.platform.note}</div>
            {c.permissions.platform.members.length ? <table className="t"><tbody>{c.permissions.platform.members.map((m: any) => <tr key={m.handle}><td>{m.handle}</td><td><Tag s="info">{m.role}</Tag></td></tr>)}</tbody></table> : <div className="faint small">Hidden for public visitors.</div>}
          </Card>
          <Card title="Who the contract authorises" right={<Src kind="live" />}>
            <div className="small muted" style={{ marginBottom: 8 }}>{c.permissions.chain.note}</div>
            <KV items={c.permissions.chain.reads.map((r: any) => [r.fn, r.error ? <span className="bad-t small">{r.error}</span> : /^0x0{40}$/i.test(String(r.value)) ? <span className="faint">none</span> : <Hash v={String(r.value)} />])} />
            <h3 style={{ marginTop: 14 }}>Executor allowlist (PortalForge policy)</h3>
            {c.permissions.chain.executorPolicies.length ? <table className="t"><tbody>{c.permissions.chain.executorPolicies.map((x: any) => <tr key={x.function_name}><td className="mono">{x.function_name}</td><td className="small">{x.max_calls_per_hour}/h · max fee {x.max_fee_wei} wei</td><td><Tag s={x.enabled ? 'active' : 'void'}>{x.enabled ? 'enabled' : 'disabled'}</Tag></td></tr>)}</tbody></table> : <div className="small faint">No function of this contract is callable by the executor.</div>}
            <div className="small faint" style={{ marginTop: 8 }}>Executors configured on worker: {c.permissions.chain.executorsConfigured.join(', ') || 'none'} · read at <Time t={c.onchain.readAt} /></div>
          </Card>
        </div>}
        {tab === 'abi' && <AbiVersions p={p} c={c} reload={q.reload} />}
        {tab === 'meta' && <Card title="Registry metadata"><KV items={[['Deploy tx', <Hash v={c.deploy_tx} />], ['Source commit', <span className="mono">{c.source_commit ?? '—'}</span>], ['Compiler', c.compiler ? `solc ${c.compiler.solc} · runs ${c.compiler.runs} · ${c.compiler.evmVersion}` : '—'], ['Verification', c.verification ? <Json v={c.verification} /> : 'none'], ['Labels', (c.labels ?? []).join(', ') || '—'], ['Responsible', c.responsible ?? '—'], ['Notes', c.notes || '—'], ['Registered', <Time t={c.created_at} />]]} /></Card>}
      </>}</Async>
    </div>
  );
}

function Interface({ p, c }: { p: any; c: any }) {
  const abi: Abi = c.abis.find((a: any) => a.version === c.active_abi_version).abi;
  const fns = useMemo(() => (abi as any[]).filter((x) => x.type === 'function'), [abi]);
  const { me } = useSession();
  const nets = useApi<{ items: any[] }>('/networks');
  const chainId = nets.data?.items.find((n) => n.id === c.network_id)?.evm.chainId;
  return (
    <div className="grid g2">
      <Card title="Read (eth_call)" right={<Src kind="live" />}>
        <div className="stack">{fns.filter((f) => ['view', 'pure'].includes(f.stateMutability)).map((f) => <FnForm key={f.name} f={f} onRun={async (args) => (await api(`/contracts/${c.id}/read`, { method: 'POST', body: { function: f.name, args } })).result} />)}</div>
      </Card>
      <Card title="Write (your wallet)" right={<span className="small faint">intent saved before signing</span>}>
        {!me?.user || !canWrite(p.role, 'run') ? <div className="muted small">Sign in as Owner, Developer or Operator to send transactions. Public visitors are read-only.</div> : (
          <div className="stack">{fns.filter((f) => f.stateMutability === 'nonpayable').map((f) => <FnForm key={f.name} f={f} write onRun={async (args, progress) => {
            const data = encodeFunctionData({ abi, functionName: f.name, args: f.inputs.map((i: any, k: number) => (/int/.test(i.type) ? BigInt(args[k]) : args[k])) } as any);
            const r = await sendWithIntent({ projectId: p.id, kind: 'call', to: c.address, data, contractAlias: c.alias, functionName: f.name, args, expectedChainId: chainId, note: `${c.alias}.${f.name}` }, progress!);
            return r;
          }} />)}
            <div className="small faint">Payable functions are not offered. Only this project’s registered contracts can be targets.</div>
          </div>)}
      </Card>
    </div>
  );
}

function FnForm({ f, onRun, write }: { f: any; write?: boolean; onRun: (args: string[], progress?: (s: any) => void) => Promise<any> }) {
  const [args, setArgs] = useState<string[]>(f.inputs.map(() => ''));
  const [out, setOut] = useState<any>(undefined);
  const [err, setErr] = useState<any>(null);
  const [phase, setPhase] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useMemo(() => onWalletBroadcast((m) => { if (m.type === 'intent-open' && write) setPhase((p: any) => p ?? { phase: 'other tab', message: 'Another tab opened a signing request for this account.' }); }), []);
  return (
    <form className="step" style={{ padding: 10 }} onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); setOut(undefined); try { setOut(await onRun(args, setPhase)); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
      <div className="row"><b className="mono">{f.name}</b><span className="small faint">({f.inputs.map((i: any) => `${i.type} ${i.name}`).join(', ')}){f.outputs?.length ? ` → ${f.outputs.map((o: any) => o.type).join(', ')}` : ''}</span></div>
      {f.inputs.length > 0 && <div className="row" style={{ marginTop: 6 }}>{f.inputs.map((i: any, k: number) => <input key={k} aria-label={i.name} placeholder={`${i.name} (${i.type})`} value={args[k]} onChange={(e) => setArgs(args.map((a, j) => (j === k ? e.target.value : a)))} style={{ flex: 1, minWidth: 120 }} />)}</div>}
      <div className="row" style={{ marginTop: 6 }}><button className={`btn sm ${write ? 'primary' : ''}`} disabled={busy}>{busy ? '…' : write ? 'Sign & send' : 'Read'}</button>
        {phase && <span className="small"><Tag s={phase.phase === 'confirmed' ? 'confirmed' : ['failed', 'rejected', 'replaced'].includes(phase.phase) ? 'failed' : phase.phase === 'unknown' ? 'unknown' : 'pending'}>{phase.phase}</Tag> {phase.txHash && <Hash v={phase.txHash} />} {phase.message}</span>}</div>
      <ErrorBox error={err} />
      {out !== undefined && !write && <pre className="json" style={{ marginTop: 6 }}>{JSON.stringify(out, null, 2)}</pre>}
    </form>
  );
}

function AbiVersions({ p, c, reload }: { p: any; c: any; reload: () => void }) {
  const { me } = useSession();
  const [abi, setAbi] = useState(''); const [note, setNote] = useState(''); const [err, setErr] = useState<any>(null);
  const can = me?.user && canWrite(p.role, 'resource');
  return (
    <div className="split">
      <Card title="Versions" flush><table className="t"><thead><tr><th>Version</th><th>Hash</th><th>Items</th><th>Note</th><th>Added</th><th /></tr></thead><tbody>
        {c.abis.map((a: any) => <tr key={a.version}><td>v{a.version} {a.version === c.active_abi_version && <Tag s="active">active</Tag>}</td><td><Hash v={a.abi_hash} n={8} /></td><td>{a.abi.length}</td><td className="small">{a.note}</td><td><Time t={a.created_at} /></td>
          <td>{can && a.version !== c.active_abi_version && <button className="btn sm" onClick={async () => { try { const r = await api(`/contracts/${c.id}/abi/activate`, { method: 'POST', body: { version: a.version } }); toast(`Activated v${a.version}; re-decoded ${r.redecoded} events`); reload(); } catch (x) { setErr(x); } }}>Activate</button>}</td></tr>)}
      </tbody></table></Card>
      {can && <Card title="Add ABI version"><div className="form"><textarea rows={6} value={abi} onChange={(e) => setAbi(e.target.value)} aria-label="ABI JSON" /><input placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} /><ErrorBox error={err} />
        <button className="btn primary" disabled={!abi} onClick={async () => { setErr(null); try { await api(`/contracts/${c.id}/abi`, { method: 'POST', body: { abi: JSON.parse(abi), note, activate: false } }); setAbi(''); reload(); } catch (x) { setErr(x); } }}>Save version</button>
        <div className="small faint">Switching versions re-decodes stored events; raw log evidence is never modified.</div></div></Card>}
    </div>
  );
}
