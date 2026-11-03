import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from './api';

/** Fetch with loading / error / reload. Aborts on unmount and on dependency change. */
export function useApi<T = any>(path: string | null, deps: unknown[] = [], opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const ctrl = useRef<AbortController | null>(null);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    ctrl.current?.abort();
    const c = new AbortController(); ctrl.current = c;
    if (!quiet) setLoading(true);
    try { const d = await api<T>(path, { signal: c.signal }); setData(d); setError(null); }
    catch (e) { if ((e as Error).name !== 'AbortError') setError(e as ApiError); }
    finally { if (!c.signal.aborted) setLoading(false); }
  }, [path, ...deps]);
  useEffect(() => { load(); return () => ctrl.current?.abort(); }, [load]);
  useEffect(() => { if (!opts.pollMs) return; const t = setInterval(() => load(true), opts.pollMs); return () => clearInterval(t); }, [load, opts.pollMs]);
  return { data, error, loading, reload: load, setData };
}

const STATE_TONE: Record<string, string> = {
  succeeded: 'ok', confirmed: 'ok', finalized: 'ok', verified: 'ok', pass: 'ok', supported: 'ok', registered: 'ok', resolved: 'ok', alive: 'ok', approved: 'ok', active: 'ok', delivered: 'ok',
  running: 'accent', queued: 'accent', broadcasting: 'accent', pending: 'accent', submitted: 'accent', sent: 'accent', safe: 'accent', prepared: 'accent', waiting: 'accent', retry_wait: 'warn', awaiting_signature: 'accent',
  awaiting_approval: 'info', acknowledged: 'info', info: 'info', local: 'info', imported: 'info',
  unknown: 'warn', unconfirmed: 'warn', warning: 'warn', mismatch: 'warn', stale: 'warn', expired: 'warn', replaced: 'warn', open: 'bad',
  failed: 'bad', dead_letter: 'bad', critical: 'bad', error: 'bad', fail: 'bad', orphaned: 'bad', rejected: 'bad', cancelled: '', skipped: '', void: '',
};
export const Tag = ({ s, children }: { s: string; children?: ReactNode }) => <span className={`tag ${STATE_TONE[s] ?? ''}`}>{children ?? s.replace(/_/g, ' ')}</span>;
export const Src = ({ kind }: { kind: 'live' | 'local' | 'sim' | 'hist' }) => <span className={`label-src ${kind}`} title={{ live: 'Read live from chain/RPC', local: 'Local development network — not testnet evidence', sim: 'Simulated — no side effects', hist: 'Stored history' }[kind]}>{{ live: 'live', local: 'local', sim: 'simulated', hist: 'history' }[kind]}</span>;

export function Hash({ v, n = 10, href }: { v?: string | null; n?: number; href?: string }) {
  const [done, setDone] = useState(false);
  if (!v) return <span className="faint">—</span>;
  const short = v.length > n * 2 + 2 ? `${v.slice(0, n)}…${v.slice(-6)}` : v;
  return (
    <span className="hash" title={v}>
      {href ? <Link to={href}>{short}</Link> : short}
      <button aria-label="Copy" onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigator.clipboard?.writeText(v); setDone(true); setTimeout(() => setDone(false), 1000); }}>{done ? '✓' : '⧉'}</button>
    </span>
  );
}

export const Time = ({ t }: { t?: string | number | null }) => {
  if (!t) return <span className="faint">—</span>;
  const d = new Date(t);
  const s = (Date.now() - d.getTime()) / 1000;
  const rel = s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : d.toLocaleDateString();
  return <span title={`${d.toISOString()} (UTC)`}>{rel}</span>;
};

export const Loading = ({ rows = 3 }: { rows?: number }) => <div className="stack" style={{ padding: 16 }}>{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 15}%` }} />)}</div>;
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => <div className="empty"><b>{title}</b>{children}</div>;
export function ErrorBox({ error, retry }: { error: ApiError | Error | null; retry?: () => void }) {
  if (!error) return null;
  const e = error as ApiError;
  return <div className="notice bad" role="alert"><b>{e.code ?? 'Error'}:</b> {e.message}{retry && <> · <button className="btn sm" onClick={retry}>Retry</button></>}{e.details?.issues && <ul className="small">{e.details.issues.map((i: any, k: number) => <li key={k}><code>{i.path}</code> {i.message}</li>)}</ul>}</div>;
}
export function Async<T>({ q, children, rows }: { q: { data: T | null; error: any; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; rows?: number }) {
  if (q.error && !q.data) return <ErrorBox error={q.error} retry={q.reload} />;
  if (!q.data) return <Loading rows={rows} />;
  return <>{children(q.data)}</>;
}

export const Card = ({ title, right, children, flush }: { title?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean }) => (
  <section className={`card ${flush || title ? 'flush' : ''}`}>
    {title && <div className="card-head"><h2>{title}</h2>{right && <div className="right">{right}</div>}</div>}
    {title ? <div style={flush ? undefined : { padding: 16 }}>{children}</div> : children}
  </section>
);
export const Stat = ({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) => <div className="card stat"><div className="label">{label}</div><div className="value">{value}</div>{hint && <div className="hint">{hint}</div>}</div>;
export const KV = ({ items }: { items: [ReactNode, ReactNode][] }) => <dl className="kv">{items.map(([k, v], i) => <Fragment key={i}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>;
export const Json = ({ v }: { v: unknown }) => <pre className="json">{JSON.stringify(v, null, 2)}</pre>;

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}

export function PageHead({ title, sub, crumbs, actions }: { title: ReactNode; sub?: ReactNode; crumbs?: ReactNode; actions?: ReactNode }) {
  return <div className="page-head"><div>{crumbs && <div className="crumbs">{crumbs}</div>}<h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>{actions && <div className="actions">{actions}</div>}</div>;
}

export function useSort<T>(rows: T[], initial: keyof T, dir: 1 | -1 = -1) {
  const [key, setKey] = useState<keyof T>(initial);
  const [d, setD] = useState<1 | -1>(dir);
  const sorted = [...rows].sort((a, b) => { const x = a[key] as any, y = b[key] as any; return (x > y ? 1 : x < y ? -1 : 0) * d; });
  const th = (k: keyof T, label: string) => <th><button onClick={() => { if (k === key) setD((v) => (v === 1 ? -1 : 1)); else { setKey(k); setD(-1); } }}>{label}{k === key ? (d === 1 ? ' ↑' : ' ↓') : ''}</button></th>;
  return { sorted, th };
}

export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

let toastSet: ((s: string | null) => void) | null = null;
export const toast = (s: string) => toastSet?.(s);
export function Toaster() {
  const [s, set] = useState<string | null>(null);
  useEffect(() => { toastSet = set; return () => { toastSet = null; }; }, []);
  useEffect(() => { if (!s) return; const t = setTimeout(() => set(null), 3500); return () => clearTimeout(t); }, [s]);
  return s ? <div className="toast" role="status">{s}</div> : null;
}

/** Sparkline over real samples. Gaps (no data) are drawn as gaps, never interpolated. */
export function Spark({ series, color = 'var(--accent)', height = 120, fmt = (v: number) => String(v) }: { series: (number | null)[]; color?: string; height?: number; fmt?: (v: number) => string }) {
  const vals = series.filter((v): v is number => v !== null);
  if (vals.length < 2) return <div className="empty small" style={{ height, display: 'grid', placeItems: 'center' }}>Insufficient data</div>;
  const max = Math.max(...vals), min = Math.min(...vals, 0);
  const w = 600, pad = 4;
  const x = (i: number) => pad + (i / (series.length - 1)) * (w - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / (max - min || 1)) * (height - pad * 2 - 14);
  let d = ''; let pen = false;
  series.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label={`max ${fmt(max)}`} style={{ height }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      <text x={w - 4} y={12} textAnchor="end" fontSize="11" fill="var(--fg-faint)">max {fmt(max)}</text>
    </svg>
  );
}
