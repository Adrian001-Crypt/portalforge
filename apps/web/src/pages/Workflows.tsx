import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApi, Async, Card, PageHead, Tag, Time, Hash, ErrorBox, Json, Tabs, toast, downloadJson } from '../ui';
import { canWrite, useSession } from '../session';

const TEMPLATE_STEPS: Record<string, any> = {
  condition: { type: 'condition', condition: { op: 'exists', path: 'trigger.args' } },
  map: { type: 'map', output: { value: '{{trigger.args}}' } },
  task: { type: 'task', task: 'math.square', input: { value: '{{trigger.args.input}}' } },
  http: { type: 'http', connector: 'demo', idempotency: 'query-before-retry', body: { jobId: '{{trigger.args.jobId}}', input: '{{trigger.args.input}}' }, retry: { maxAttempts: 3, backoffMs: 1000, maxBackoffMs: 10000, jitter: true } },
  validate: { type: 'validate', value: 'trigger.args', schema: { type: 'object', required: [], properties: {} } },
  approval: { type: 'approval', prompt: 'Approve this step?', expiresInSec: 3600 },
  wait: { type: 'wait', seconds: 30 },
  contract_call: { type: 'contract_call', contract: 'jobs', function: 'completeJob', mode: 'simulate', args: [] },
  evidence: { type: 'evidence', kind: 'execution', include: ['trigger.eventId'], register: false },
};
const NEW_WORKFLOW = { schema: 'portalforge.workflow/v1', name: 'new-workflow', description: '', trigger: { type: 'manual' }, concurrency: 4, steps: [{ id: 'start', type: 'map', needs: [], output: { received: '{{trigger}}' }, ui: { x: 40, y: 120 } }] };

export function Workflows({ p }: { p: any }) {
  const q = useApi<{ items: any[] }>(`/projects/${p.id}/workflows`, [p.id]);
  const { me } = useSession();
  const nav = useNavigate();
  const [name, setName] = useState(''); const [err, setErr] = useState<any>(null);
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}`}>{p.name}</Link>} title="Workflows" sub="Directed workflows over indexed events. Definitions are versioned and immutable; running executions keep their version."
        actions={me?.user && canWrite(p.role, 'workflow') && <form className="row" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const r = await api(`/projects/${p.id}/workflows`, { method: 'POST', body: { name, definition: { ...NEW_WORKFLOW, name } } }); nav(`/p/${p.slug}/workflows/${r.id}`); } catch (x) { setErr(x); } }}>
          <input placeholder="new-workflow-name" pattern="[a-z0-9][a-z0-9-]{1,40}" value={name} onChange={(e) => setName(e.target.value)} aria-label="Workflow name" /><button className="btn primary" disabled={!name}>New workflow</button></form>} />
      <ErrorBox error={err} />
      <Card flush><Async q={q}>{(d) => d.items.length ? <table className="t"><thead><tr><th>Workflow</th><th>Trigger</th><th>Active version</th><th>Status</th><th>Executions</th><th>Updated</th></tr></thead><tbody>
        {d.items.map((w) => <tr key={w.id} className="click" onClick={() => nav(`/p/${p.slug}/workflows/${w.id}`)}><td><b>{w.name}</b><div className="small faint">{w.definition?.description?.slice(0, 90)}</div></td>
          <td className="small">{w.definition?.trigger.type === 'event' ? `${w.definition.trigger.contract}.${w.definition.trigger.event} (≥ ${w.definition.trigger.minFinality})` : w.definition?.trigger.type === 'schedule' ? `every ${w.definition.trigger.everySeconds}s` : 'manual'}</td>
          <td>v{w.active_version} <span className="faint small">of {w.latest_version}</span> <Hash v={w.definition_hash} n={6} /></td><td><Tag s={w.enabled ? 'active' : 'void'}>{w.enabled ? 'enabled' : 'disabled'}</Tag></td>
          <td className="small">{w.executions} · <span className="ok-t">{w.succeeded} ok</span> · <span className="bad-t">{w.failed} failed</span></td><td><Time t={w.updated_at} /></td></tr>)}
      </tbody></table> : <div className="empty"><b>No workflows</b>Create one, or import <code>examples/workflows/job-square.json</code>.</div>}</Async></Card>
    </div>
  );
}

export function WorkflowBuilder({ p }: { p: any }) {
  const { wid } = useParams();
  const q = useApi<any>(`/workflows/${wid}`, [wid]);
  const [def, setDef] = useState<any>(null);
  const [versionShown, setVersionShown] = useState<number | null>(null);
  const [json, setJson] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState('canvas');
  const [validation, setValidation] = useState<any>(null);
  const [sim, setSim] = useState<any>(null);
  const [trigger, setTrigger] = useState('{\n  "eventId": "sample",\n  "args": { "jobId": "1", "input": "12" }\n}');
  const [stubs, setStubs] = useState('{\n  "compute": { "result": "144", "resultHash": "0x' + 'a'.repeat(64) + '" }\n}');
  const [err, setErr] = useState<any>(null);
  const { me } = useSession();
  const writable = !!me?.user && canWrite(p.role, 'workflow');

  useEffect(() => { if (q.data && def === null) { const v = q.data.versions.find((x: any) => x.version === q.data.active_version) ?? q.data.versions[0]; setDef(v.definition); setVersionShown(v.version); } }, [q.data]);
  useEffect(() => { if (def) { setJson(JSON.stringify(def, null, 2)); setJsonErr(null); } }, [def]);
  useEffect(() => { if (!def) return; const t = setTimeout(async () => { try { setValidation(await api('/workflows/validate', { method: 'POST', body: { definition: def } })); } catch (x) { setValidation({ ok: false, issues: [{ path: '$', message: (x as Error).message }] }); } }, 300); return () => clearTimeout(t); }, [def]);

  const savedHash = q.data?.versions.find((v: any) => v.version === versionShown)?.definition_hash;
  const dirty = validation?.definitionHash && savedHash && validation.definitionHash !== savedHash;
  const update = (fn: (d: any) => any) => setDef((d: any) => fn(structuredClone(d)));
  const step = def?.steps.find((s: any) => s.id === sel);

  const save = async (activate: boolean) => {
    setErr(null);
    try { const r = await api(`/workflows/${wid}/versions`, { method: 'POST', body: { definition: def, activate } }); toast(`Saved as v${r.version}${activate ? ' and activated' : ''}`); setVersionShown(r.version); q.reload(); }
    catch (x) { setErr(x); }
  };
  if (!q.data || !def) return <div className="content"><Async q={q}>{() => null}</Async></div>;
  const w = q.data;
  return (
    <div className="content">
      <PageHead crumbs={<Link to={`/p/${p.slug}/workflows`}>Workflows</Link>} title={w.name}
        sub={<>{w.enabled ? <Tag s="active">enabled</Tag> : <Tag s="void">disabled</Tag>} · active v{w.active_version} · editing from v{versionShown} {dirty && <Tag s="warn">unsaved changes</Tag>} {validation && (validation.ok ? <Tag s="pass">valid</Tag> : <Tag s="fail">{validation.issues.length} issue(s)</Tag>)}</>}
        actions={<>
          <select aria-label="Version" value={versionShown ?? ''} onChange={(e) => { const v = w.versions.find((x: any) => x.version === Number(e.target.value)); setDef(v.definition); setVersionShown(v.version); }}>{w.versions.map((v: any) => <option key={v.version} value={v.version}>v{v.version} · {v.definition_hash.slice(0, 8)}</option>)}</select>
          <button className="btn" onClick={() => downloadJson(`${w.name}.json`, def)}>Export JSON</button>
          {writable && <><button className="btn" disabled={!validation?.ok || !dirty} onClick={() => save(false)}>Save version</button><button className="btn primary" disabled={!validation?.ok || (!dirty && versionShown === w.active_version)} onClick={() => (dirty ? save(true) : api(`/workflows/${wid}/activate`, { method: 'POST', body: { version: versionShown, enabled: w.enabled } }).then(() => { toast('Activated'); q.reload(); }).catch(setErr))}>{dirty ? 'Save & activate' : 'Activate this version'}</button>
            <button className="btn" onClick={() => api(`/workflows/${wid}/activate`, { method: 'POST', body: { enabled: !w.enabled } }).then(() => { toast(w.enabled ? 'Trigger disabled' : 'Trigger enabled from the current indexed block'); q.reload(); }).catch(setErr)}>{w.enabled ? 'Disable trigger' : 'Enable trigger'}</button>
            {def.trigger.type === 'manual' && <button className="btn" onClick={() => api(`/workflows/${wid}/run`, { method: 'POST', body: { payload: JSON.parse(trigger) } }).then((r: any) => toast(`Execution ${r.id.slice(0, 10)}… ${r.created ? 'created' : 'already existed'}`)).catch(setErr)}>Run now</button>}
          </>}
        </>} />
      <ErrorBox error={err} />
      {validation && !validation.ok && <div className="notice bad small" style={{ marginBottom: 12 }}><b>Validation</b><ul style={{ margin: '4px 0 0' }}>{validation.issues.map((i: any, k: number) => <li key={k}><code>{i.path}</code> {i.message}</li>)}</ul></div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'canvas', label: 'Visual editor' }, { id: 'json', label: 'JSON definition' }, { id: 'simulate', label: 'Simulate' }, { id: 'versions', label: `Versions (${w.versions.length})` }]} />
      {tab === 'canvas' && <div className="split">
        <div className="stack">
          <TriggerEditor def={def} update={update} readOnly={!writable} />
          <Canvas def={def} sel={sel} setSel={setSel} update={update} readOnly={!writable} />
          {writable && <div className="row"><span className="small muted">Add step:</span>{Object.keys(TEMPLATE_STEPS).map((t) => <button key={t} className="btn sm" onClick={() => update((d) => { let id = t.replace(/[^a-z]/g, '').slice(0, 8); let n = 1; while (d.steps.some((s: any) => s.id === `${id}${n}`)) n++; id = `${id}${n}`; const last = d.steps.at(-1); d.steps.push({ id, needs: sel ? [sel] : last ? [last.id] : [], ...structuredClone(TEMPLATE_STEPS[t]), ui: { x: (last?.ui?.x ?? 0) + 220, y: last?.ui?.y ?? 120 } }); setSel(id); return d; })}>+ {t.replace('_', ' ')}</button>)}</div>}
        </div>
        <Card title={step ? `Step · ${step.id}` : 'Step inspector'}>
          {step ? <StepEditor key={step.id} step={step} all={def.steps} readOnly={!writable} onChange={(s) => update((d) => { const i = d.steps.findIndex((x: any) => x.id === step.id); d.steps[i] = s; if (s.id !== step.id) { d.steps.forEach((x: any) => { x.needs = (x.needs ?? []).map((n: string) => (n === step.id ? s.id : n)); }); setSel(s.id); } return d; })}
            onDelete={() => update((d) => { d.steps = d.steps.filter((x: any) => x.id !== step.id); d.steps.forEach((x: any) => { x.needs = (x.needs ?? []).filter((n: string) => n !== step.id); }); setSel(null); return d; })} /> : <div className="muted small">Select a node on the canvas. Drag nodes to arrange; dependencies are edited with “Runs after”.</div>}
        </Card>
      </div>}
      {tab === 'json' && <Card title="Definition (portalforge.workflow/v1)" right={jsonErr ? <Tag s="fail">{jsonErr}</Tag> : <Tag s="pass">in sync with visual editor</Tag>}>
        <textarea rows={28} value={json} readOnly={!writable} aria-label="Workflow JSON" onChange={(e) => { setJson(e.target.value); try { setDef(JSON.parse(e.target.value)); setJsonErr(null); } catch (x) { setJsonErr('invalid JSON'); } }} />
      </Card>}
      {tab === 'simulate' && <div className="split">
        <Card title="Trace (no side effects)" right={<button className="btn primary sm" onClick={async () => { setErr(null); try { setSim(await api('/workflows/simulate', { method: 'POST', body: { definition: def, trigger: JSON.parse(trigger), stubs: JSON.parse(stubs || '{}') } })); } catch (x) { setErr(x); } }}>Run simulation</button>} flush>
          {sim ? sim.matched === false ? <div className="empty"><b>Trigger filter did not match</b></div> : <table className="t"><thead><tr><th>Step</th><th>Type</th><th>Result</th><th>Detail</th></tr></thead><tbody>{sim.trace.map((t: any) => <tr key={t.step}><td className="mono">{t.step}</td><td className="small">{t.type}</td><td><Tag s={t.state === 'succeeded' || t.state === 'stubbed' ? 'succeeded' : t.state === 'failed' ? 'failed' : t.state === 'skipped' ? 'skipped' : 'info'}>{t.state.replace('_', ' ')}</Tag></td><td className="small mono" style={{ maxWidth: 420, overflowWrap: 'anywhere' }}>{t.note ?? JSON.stringify(t.output)}</td></tr>)}</tbody></table> : <div className="empty"><b>Simulate before enabling</b>Pure steps run for real; HTTP, contract calls, approvals and evidence are reported as what they would do.</div>}
        </Card>
        <div className="stack"><Card title="Sample trigger payload"><textarea rows={8} value={trigger} onChange={(e) => setTrigger(e.target.value)} aria-label="Trigger payload" /></Card><Card title="Stub outputs for side-effect steps"><textarea rows={6} value={stubs} onChange={(e) => setStubs(e.target.value)} aria-label="Stubs" /></Card></div>
      </div>}
      {tab === 'versions' && <Card flush><table className="t"><thead><tr><th>Version</th><th>Definition hash</th><th>Steps</th><th>Author</th><th>Created</th></tr></thead><tbody>{w.versions.map((v: any) => <tr key={v.version}><td>v{v.version} {v.version === w.active_version && <Tag s="active">active</Tag>}</td><td><Hash v={v.definition_hash} /></td><td>{v.definition.steps.length}</td><td className="small">{v.created_by}</td><td><Time t={v.created_at} /></td></tr>)}</tbody></table></Card>}
    </div>
  );
}

function TriggerEditor({ def, update, readOnly }: { def: any; update: (f: (d: any) => any) => void; readOnly: boolean }) {
  const t = def.trigger;
  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="row">
        <b>Trigger</b>
        <select disabled={readOnly} value={t.type} onChange={(e) => update((d) => { d.trigger = e.target.value === 'event' ? { type: 'event', contract: 'jobs', event: 'JobRequested', minFinality: 'safe' } : e.target.value === 'schedule' ? { type: 'schedule', everySeconds: 300 } : { type: 'manual' }; return d; })} aria-label="Trigger type"><option value="event">Contract event</option><option value="schedule">Schedule (worker)</option><option value="manual">Manual / API</option></select>
        {t.type === 'event' && <>
          <input disabled={readOnly} aria-label="Contract alias" value={t.contract} onChange={(e) => update((d) => { d.trigger.contract = e.target.value; return d; })} style={{ width: 110 }} />
          <input disabled={readOnly} aria-label="Event name" value={t.event} onChange={(e) => update((d) => { d.trigger.event = e.target.value; return d; })} style={{ width: 150 }} />
          <label className="small row">min finality<select disabled={readOnly} value={t.minFinality} onChange={(e) => update((d) => { d.trigger.minFinality = e.target.value; return d; })}><option>unconfirmed</option><option>safe</option><option>finalized</option></select></label>
        </>}
        {t.type === 'schedule' && <label className="small row">every<input disabled={readOnly} type="number" min={10} value={t.everySeconds} onChange={(e) => update((d) => { d.trigger.everySeconds = Number(e.target.value); return d; })} style={{ width: 90 }} />s</label>}
        <label className="small row">concurrency<input disabled={readOnly} type="number" min={1} max={50} value={def.concurrency ?? 4} onChange={(e) => update((d) => { d.concurrency = Number(e.target.value); return d; })} style={{ width: 64 }} /></label>
      </div>
      {t.type === 'schedule' && <div className="small faint" style={{ marginTop: 6 }}>Runs while the PortalForge worker runs; contracts do not execute themselves on a timer.</div>}
    </div>
  );
}

function Canvas({ def, sel, setSel, update, readOnly }: { def: any; sel: string | null; setSel: (s: string | null) => void; update: (f: (d: any) => any) => void; readOnly: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const pos = useMemo(() => Object.fromEntries(def.steps.map((s: any, i: number) => [s.id, s.ui ?? { x: 40 + i * 220, y: 120 }])), [def]);
  const W = Math.max(900, ...Object.values(pos).map((p: any) => p.x + 240));
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || readOnly) return;
    const r = ref.current!.getBoundingClientRect();
    const x = Math.max(0, Math.round((e.clientX - r.left + ref.current!.scrollLeft - drag.current.dx) / 10) * 10);
    const y = Math.max(0, Math.round((e.clientY - r.top + ref.current!.scrollTop - drag.current.dy) / 10) * 10);
    const id = drag.current.id;
    update((d) => { const s = d.steps.find((x: any) => x.id === id); s.ui = { x, y }; return d; });
  };
  return (
    <div className="canvas" ref={ref} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }} onClick={(e) => { if (e.target === ref.current) setSel(null); }} role="application" aria-label="Workflow graph">
      <svg width={W} height={420} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--fg-faint)" /></marker></defs>
        {def.steps.flatMap((s: any) => (s.needs ?? []).filter((n: string) => pos[n]).map((n: string) => {
          const a = pos[n] as any, b = pos[s.id] as any;
          const x1 = a.x + 180, y1 = a.y + 28, x2 = b.x, y2 = b.y + 28, mx = (x1 + x2) / 2;
          return <path key={`${n}-${s.id}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} stroke="var(--fg-faint)" strokeWidth="1.5" fill="none" markerEnd="url(#arr)" />;
        }))}
      </svg>
      {def.steps.map((s: any) => {
        const p = pos[s.id] as any;
        return (
          <div key={s.id} className={`node ${sel === s.id ? 'sel' : ''}`} style={{ left: p.x, top: p.y }} tabIndex={0} role="button" aria-label={`Step ${s.id}`}
            onKeyDown={(e) => { if (e.key === 'Enter') setSel(s.id); }}
            onPointerDown={(e) => { setSel(s.id); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); drag.current = { id: s.id, dx: e.clientX - r.left, dy: e.clientY - r.top }; }}>
            <div className="ty">{s.type.replace('_', ' ')}{s.type === 'contract_call' && ` · ${s.mode}`}</div>
            <div className="nm">{s.name ?? s.id}</div>
            <div className="small faint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.type === 'http' ? `→ ${s.connector}` : s.type === 'contract_call' ? `${s.contract}.${s.function}` : s.type === 'task' ? s.task : s.type === 'approval' ? 'human approval' : s.type === 'evidence' ? (s.register ? 'register on-chain' : 'local hash') : s.id}</div>
          </div>
        );
      })}
    </div>
  );
}

function StepEditor({ step, all, onChange, onDelete, readOnly }: { step: any; all: any[]; onChange: (s: any) => void; onDelete: () => void; readOnly: boolean }) {
  const { id, type, name, needs, ui, timeoutMs, retry, ...config } = step;
  const [cfg, setCfg] = useState(JSON.stringify(config, null, 2));
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const others = all.filter((s) => s.id !== id);
  return (
    <div className="form">
      <div className="row"><Tag s="info">{type}</Tag>{!readOnly && <button className="btn sm danger" style={{ marginLeft: 'auto' }} onClick={onDelete}>Delete step</button>}</div>
      <label className="f">Step id<input disabled={readOnly} value={id} pattern="[a-z][a-z0-9_]{0,39}" onChange={(e) => onChange({ ...step, id: e.target.value })} /></label>
      <label className="f">Display name<input disabled={readOnly} value={name ?? ''} onChange={(e) => onChange({ ...step, name: e.target.value || undefined })} /></label>
      <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}><legend className="small muted">Runs after</legend>
        {others.length ? others.map((o) => <label key={o.id} className="small row" style={{ marginRight: 10 }}><input disabled={readOnly} type="checkbox" checked={(needs ?? []).includes(o.id)} onChange={(e) => onChange({ ...step, needs: e.target.checked ? [...(needs ?? []), o.id] : needs.filter((n: string) => n !== o.id) })} />{o.id}</label>) : <span className="small faint">no other steps</span>}
      </fieldset>
      <div className="grid g2">
        <label className="f">Timeout (ms)<input disabled={readOnly} type="number" min={100} value={timeoutMs ?? 30000} onChange={(e) => onChange({ ...step, timeoutMs: Number(e.target.value) })} /></label>
        <label className="f">Max attempts<input disabled={readOnly} type="number" min={1} max={20} value={retry?.maxAttempts ?? 3} onChange={(e) => onChange({ ...step, retry: { backoffMs: 1000, maxBackoffMs: 60000, jitter: true, ...(retry ?? {}), maxAttempts: Number(e.target.value) } })} /></label>
      </div>
      <label className="f">Configuration (JSON)<textarea disabled={readOnly} rows={12} value={cfg} onChange={(e) => { setCfg(e.target.value); try { const c = JSON.parse(e.target.value); setCfgErr(null); onChange({ id, type, name, needs, ui, timeoutMs, retry, ...c }); } catch { setCfgErr('invalid JSON'); } }} /></label>
      {cfgErr && <span className="bad-t small">{cfgErr}</span>}
      <div className="small faint">Templates: <code>{'{{trigger.args.x}}'}</code>, <code>{'{{steps.<id>.output.x}}'}</code>, <code>{'{{execution.id}}'}</code>. HTTP steps reference a project connector, never a raw URL. Contract writes must be on the executor allowlist.</div>
    </div>
  );
}
void Json;
