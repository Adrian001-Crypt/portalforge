import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, Hash, ErrorBox, KV, Json, toast, Src, downloadJson } from '../ui';
import { canWrite, useSession } from '../session';
import { connect, sendWithIntent, switchChain } from '../wallet';
import { formatUnits } from '../units';

export function Deployments({ p }: { p: any }) {
  const list = useApi<{ items: any[] }>(`/projects/${p.id}/deployments`, [p.id]);
  const intents = useApi<{ items: any[] }>(`/projects/${p.id}/wallet-intents`, [p.id]);
  const { me } = useSession();
  const writable = !!me?.user && canWrite(p.role, 'resource');
  const [manifest, setManifest] = useState('');
  const [err, setErr] = useState<any>(null);
  const importManifest = async () => {
    setErr(null);
    try { const m = JSON.parse(manifest); const r = await api(`/projects/${p.id}/deployments`, { method: 'POST', body: { manifest: m } }); toast(r.verification.ok ? 'Manifest verified against chain and imported' : 'Imported, but verification failed'); list.reload(); setManifest(''); }
    catch (x) { setErr(x); }
  };
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Deployments" sub="Template deploys with live simulation and exact storage-deposit preview; manifests verified against the chain." />
      {writable && <Workbench p={p} onDone={() => { list.reload(); intents.reload(); }} />}
      <div style={{ height: 14 }} />
      <Card title="Deployment records" flush>
        <Async q={list}>{(d) => d.items.length ? <table className="t"><thead><tr><th>Manifest</th><th>Contracts</th><th>Source</th><th>Status</th><th>Verified</th></tr></thead><tbody>
          {d.items.map((x) => <tr key={x.id}><td><Link to={`/p/${p.slug}/deployments/${x.id}`}><Hash v={x.manifest_hash} n={8} /></Link></td><td className="small">{x.manifest.contracts.map((c: any) => c.name).join(', ')}</td><td className="small mono">{x.manifest.source.commit.slice(0, 10)}</td><td><Tag s={x.status} /></td><td><Time t={x.verified_at} /></td></tr>)}
        </tbody></table> : <div className="empty"><b>No deployments recorded</b>Deploy a template above, or import a manifest produced by <code>npm run deploy:apply</code>.</div>}</Async>
      </Card>
      <div style={{ height: 14 }} />
      <div className="grid g2">
        <Card title="Browser signing requests" flush>
          <Async q={intents}>{(d) => d.items.length ? <table className="t"><tbody>{d.items.map((w) => <tr key={w.id}><td className="small"><b>{w.kind}</b> {w.contract_alias ? `${w.contract_alias}.${w.function_name}` : ''}<div className="faint">{w.note}</div></td><td><Tag s={w.state} /></td><td><Hash v={w.tx_hash} n={8} /></td><td>{['awaiting_signature', 'submitted', 'unknown'].includes(w.state) && <button className="btn sm" onClick={async () => { await api(`/wallet-intents/${w.id}/refresh`, { method: 'POST' }); intents.reload(); }}>Reconcile</button>}</td></tr>)}</tbody></table> : <div className="empty"><b>No signing requests</b></div>}</Async>
        </Card>
        {writable && <Card title="Import manifest">
          <textarea rows={7} placeholder='{"schema":"portalforge.deployment/v1", …}' value={manifest} onChange={(e) => setManifest(e.target.value)} aria-label="Manifest JSON" />
          <ErrorBox error={err} />
          <div className="row" style={{ marginTop: 8 }}><button className="btn primary" disabled={!manifest} onClick={importManifest}>Verify & import</button><span className="small faint">Every claim is re-read from RPC before it is stored.</span></div>
        </Card>}
      </div>
    </div>
  );
}

function Workbench({ p, onDone }: { p: any; onDone: () => void }) {
  const tpl = useApi<{ items: any[] }>('/templates');
  const nets = useApi<{ items: any[] }>('/networks');
  const net = nets.data?.items.find((n) => n.id === p.network_id);
  const [t, setT] = useState('JobRegistry');
  const [from, setFrom] = useState('');
  const [executor, setExecutor] = useState('');
  const [plan, setPlan] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [phase, setPhase] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const tmpl = tpl.data?.items.find((x) => x.name === t);
  const doPlan = async () => {
    setErr(null); setPlan(null); setBusy('Simulating on chain…');
    try { setPlan(await api(`/projects/${p.id}/deploy/plan`, { method: 'POST', body: { template: t, from, executor: executor || from } })); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const deploy = async () => {
    setErr(null); setResult(null);
    try {
      const r = await sendWithIntent({ projectId: p.id, kind: 'deploy', data: plan.initCode, note: `deploy ${t}`, expectedChainId: plan.network.chainId }, setPhase);
      if (r.state === 'confirmed') {
        const m = await api(`/wallet-intents/${r.intentId}/manifest`, { method: 'POST', body: { template: t, constructorArgs: plan.constructorArgs } });
        setResult(m); toast(m.verification.ok ? 'Deployed and verified' : 'Deployed; verification reported failures'); onDone();
      }
    } catch (x) { setErr(x); }
  };
  return (
    <Card title="Deployment Workbench" right={<Src kind={net?.kind === 'local-dev' ? 'local' : 'live'} />}>
      <div className="grid g3">
        <div className="form">
          <label className="f">Template<select value={t} onChange={(e) => { setT(e.target.value); setPlan(null); }}>{tpl.data?.items.map((x) => <option key={x.name} value={x.name}>{x.title}{x.compiled ? '' : ' (not compiled)'}</option>)}</select></label>
          <div className="small muted">{tmpl?.description}</div>
          <label className="f">Owner / deployer (your wallet)<div className="row"><input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="0x…" style={{ flex: 1 }} /><button className="btn sm" type="button" onClick={async () => { try { const w = await connect(); setFrom(w.account); } catch (x) { setErr(x); } }}>Use wallet</button></div></label>
          <label className="f">{tmpl?.constructor[1] ?? 'executor'} address (PortalForge executor)<input value={executor} onChange={(e) => setExecutor(e.target.value)} placeholder="0x… (defaults to owner)" /></label>
          <button className="btn" disabled={!from || !!busy} onClick={doPlan}>{busy ?? 'Plan (simulate + estimate)'}</button>
          {net && <button className="btn ghost sm" type="button" onClick={() => switchChain({ chainId: net.evm.chainId, name: net.name, rpcUrl: net.evm.rpcUrl, symbol: net.evm.nativeCurrency.symbol }).catch(setErr)}>Add / switch wallet to {net.name}</button>}
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          {!plan ? <div className="empty"><b>Plan before you sign</b>The plan runs the create through <code>eth_call</code> on the live network, checks the runtime code equals the compiled artifact, and asks the runtime for the exact storage deposit.</div> : (
            <div className="stack">
              <KV items={[
                ['Network', `${p.network_id} (chainId ${plan.network.chainId})`],
                ['Simulation', plan.simulation.ok ? (plan.simulation.runtimeMatches ? <Tag s="pass">runtime matches artifact</Tag> : <Tag s="fail">runtime differs</Tag>) : <Tag s="fail">{plan.simulation.error}</Tag>],
                ['Runtime size', `${plan.runtimeBytes} bytes`],
                ['Constructor', <span className="mono small">{plan.constructorArgs.join(', ')}</span>],
                ['Init code hash', <Hash v={plan.initCodeHash} />],
                ['Artifact runtime hash', <Hash v={plan.artifactRuntimeHash} />],
                ['Compiler', `solc ${plan.compiler.solc} · optimizer ${plan.compiler.optimizer ? `on (${plan.compiler.runs} runs)` : 'off'} · evm ${plan.compiler.evmVersion}`],
                ['Max fee (gas × price)', plan.maxFee ? `${formatUnits(BigInt(plan.maxFee), 18, 4)} ${net?.evm.nativeCurrency.symbol}` : '—'],
                ['Storage deposit (exact)', plan.deposit ? (plan.deposit.ok ? <b>{formatUnits(BigInt(plan.deposit.amount), plan.deposit.decimals, 4)} {plan.deposit.symbol}</b> : <span className="warn-t">dry-run failed: {plan.deposit.error}</span>) : 'not applicable (no native interface)'],
                ['Your balance', plan.balance != null ? `${formatUnits(BigInt(plan.balance), 18, 4)} ${net?.evm.nativeCurrency.symbol}` : '—'],
              ]} />
              {plan.warnings.map((w: string, i: number) => <div key={i} className="notice warn small">{w}</div>)}
              {plan.blockers.map((b: string, i: number) => <div key={i} className="notice bad small">{b}</div>)}
              <div className="row">
                <button className="btn primary" disabled={plan.blockers.length > 0 || (phase && ['checking', 'persisting', 'signing', 'submitted'].includes(phase.phase))} onClick={deploy}>Sign & deploy with wallet</button>
                {phase && <span className="small"><Tag s={phase.phase === 'confirmed' ? 'confirmed' : ['failed', 'rejected'].includes(phase.phase) ? 'failed' : phase.phase === 'unknown' ? 'unknown' : 'pending'}>{phase.phase}</Tag> {phase.txHash && <Hash v={phase.txHash} />} {phase.message}</span>}
              </div>
            </div>)}
          <ErrorBox error={err} />
          {result && <div className="stack" style={{ marginTop: 12 }}>
            <div className={`notice ${result.verification.ok ? 'ok' : 'bad'}`}>Manifest {result.verification.ok ? 'verified' : 'failed verification'} — {result.verification.checks.filter((c: any) => c.status === 'pass').length}/{result.verification.checks.length} checks passed. <button className="btn sm" onClick={() => downloadJson('deployment-manifest.json', result.manifest)}>Download manifest</button></div>
          </div>}
        </div>
      </div>
    </Card>
  );
}

export function DeploymentDetail({ p }: { p: any }) {
  const { id } = useParams();
  const q = useApi<any>(`/deployments/${id}`, [id]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<any>(null);
  const { me } = useSession();
  return (
    <div className="content">
      <Async q={q}>{(d) => <>
        <PageHead crumbs={<><Link to={`/p/${p.slug}/deployments`}>Deployments</Link></>} title={<>Deployment <Hash v={d.manifest_hash} n={8} /></>} sub={<><Tag s={d.status} /> · {d.network_id} · verified <Time t={d.verified_at} /></>}
          actions={<>{me?.user && canWrite(p.role, 'resource') && <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { await api(`/deployments/${d.id}/verify`, { method: 'POST' }); q.reload(); toast('Re-verified against chain'); } catch (x) { setErr(x); } finally { setBusy(false); } }}>{busy ? 'Verifying…' : 'Re-verify on chain'}</button>}<button className="btn" onClick={() => downloadJson('manifest.json', d.manifest)}>Export manifest</button></>} />
        <ErrorBox error={err} />
        <div className="split">
          <div className="stack">
            {d.manifest.contracts.map((c: any) => <Card key={c.address} title={c.name} right={<Src kind="hist" />}>
              <KV items={[['Address', <Hash v={c.address} />], ['Deploy tx', <Hash v={c.deployTx} />], ['Block', <span className="mono">#{c.deployBlock} <Hash v={c.deployBlockHash} n={8} /></span>], ['Deployer', <Hash v={c.deployer} />], ['Runtime code hash', <Hash v={c.runtimeCodeHash} />], ['Artifact runtime hash', <Hash v={c.artifactRuntimeHash} />], ['ABI hash', <Hash v={c.abiHash} />], ['Constructor', <span className="mono small">{c.constructorArgs.join(', ')}</span>], ['Version', c.version]]} />
            </Card>)}
            <Card title="Source & compiler"><KV items={[['Commit', <span className="mono">{d.manifest.source.commit}</span>], ['Dirty tree', String(d.manifest.source.dirty)], ['solc', d.manifest.compiler.solc], ['Optimizer', `${d.manifest.compiler.optimizer} (${d.manifest.compiler.runs} runs)`], ['EVM version', d.manifest.compiler.evmVersion], ['Network', `${d.manifest.network.id} · chainId ${d.manifest.network.chainId}`], ['Genesis', <Hash v={d.manifest.network.genesisHash} />]]} /></Card>
          </div>
          <Card title="Verification checks" right={<Src kind="live" />} flush>
            {d.verification ? <table className="t"><tbody>{d.verification.checks.map((c: any) => <tr key={c.id}><td><Tag s={c.status} /></td><td className="small"><div className="mono">{c.id}</div><div className="faint">{c.detail}</div></td></tr>)}</tbody></table> : <div className="empty"><b>Not verified yet</b></div>}
          </Card>
        </div>
        <div style={{ height: 14 }} /><Card title="Raw manifest"><Json v={d.manifest} /></Card>
      </>}</Async>
    </div>
  );
}
