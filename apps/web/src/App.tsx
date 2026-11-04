import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate, useParams, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { Toaster, useApi, ErrorBox, NetworkBadge } from './ui';
import { Overview } from './pages/Overview';
import { Projects, ProjectHome } from './pages/Projects';
import { NetworkHealth, IntegrationHealth } from './pages/Health';
import { Deployments, DeploymentDetail } from './pages/Deployments';
import { Contracts, ContractDetail } from './pages/Contracts';
import { Events, EventDetail } from './pages/Events';
import { Workflows, WorkflowBuilder } from './pages/Workflows';
import { Executions, ExecutionDetail } from './pages/Executions';
import { Incidents, IncidentDetail } from './pages/Incidents';
import { EvidenceList, EvidenceDetail } from './pages/Evidence';
import { Developers } from './pages/Developers';
import { Settings } from './pages/Settings';
import { SNAPSHOT, loadSnapshot } from './api';

function Sidebar({ open, close }: { open: boolean; close: () => void }) {
  const loc = useLocation();
  const m = /^\/p\/([^/]+)/.exec(loc.pathname);
  const pid = m?.[1] ?? localStorageGet('pf.project');
  const { me } = useSession();
  const projects = useApi<{ items: any[] }>('/projects', [loc.pathname.startsWith('/projects'), me?.user?.id]);
  const project = projects.data?.items.find((p) => p.id === pid || p.slug === pid);
  const nav = useNavigate();
  useEffect(() => { if (m?.[1]) localStorageSet('pf.project', m[1]); }, [m?.[1]]);
  useEffect(close, [loc.pathname]);
  const link = (to: string, label: string, icon: string, count?: number) => <NavLink to={to} end={to === '/' || /^\/p\/[^/]+$/.test(to)}><span aria-hidden>{icon}</span>{label}{count ? <span className="count">{count}</span> : null}</NavLink>;
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Navigation">
      <div className="brand"><img src="/favicon.svg" width={26} height={26} alt="" /><div>PortalForge<small>Build · observe · automate on Portaldot</small></div></div>
      <nav className="nav">
        {link('/', 'Overview', '◎')}
        {link('/projects', 'Projects', '▦')}
        {link('/network', 'Network Health', '◉')}
        {link('/integrations', 'Integration Health', '⇄')}
        {link('/developers', 'Developer API / CLI', '⌘')}
        <div className="nav-section">Project</div>
        <div style={{ padding: '2px 8px 8px' }}>
          <select aria-label="Project" style={{ width: '100%' }} value={project?.slug ?? ''} onChange={(e) => e.target.value && nav(`/p/${e.target.value}`)}>
            <option value="">Select project…</option>
            {projects.data?.items.map((p) => <option key={p.id} value={p.slug}>{p.name}{p.role === 'public' ? ' (public demo)' : ''}</option>)}
          </select>
        </div>
        {project && <>
          <div style={{ padding: '0 8px 8px' }}><NetworkBadge id={project.network_id} /></div>
          {link(`/p/${project.slug}`, 'Project home', '⌂')}
          {link(`/p/${project.slug}/deployments`, 'Deployments', '⇪')}
          {link(`/p/${project.slug}/contracts`, 'Contract Workspace', '{}')}
          {link(`/p/${project.slug}/events`, 'Event Explorer', '≋')}
          {link(`/p/${project.slug}/workflows`, 'Workflow Builder', '⟴')}
          {link(`/p/${project.slug}/executions`, 'Executions', '▶')}
          {link(`/p/${project.slug}/incidents`, 'Incidents', '⚠', project.stats?.openIncidents)}
          {link(`/p/${project.slug}/evidence`, 'Evidence', '✓')}
          {link(`/p/${project.slug}/settings`, 'Settings', '⚙')}
        </>}
      </nav>
    </aside>
  );
}

const localStorageGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const localStorageSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function SnapshotNotice() {
  const [s, setS] = useState<{ capturedAt: string; source?: string } | null>(null);
  useEffect(() => { loadSnapshot().then(setS).catch(() => {}); }, []);
  return <div className="notice warn small" role="note" style={{ margin: '12px 24px 0' }}>Static snapshot{s && ` captured ${s.capturedAt.slice(0, 10)}`}{s?.source && ` of ${s.source}`}, for reading only. It is not live, and buttons that send data do nothing. <a href="https://github.com/Adrian001-Crypt/portalforge#quick-start-from-a-fresh-clone">Run it yourself</a>.</div>;
}

function TopBar({ menu }: { menu: () => void }) {
  const { me, login, logout } = useSession();
  const [handle, setHandle] = useState('');
  const [err, setErr] = useState<any>(null);
  const [theme, setTheme] = useState(localStorageGet('pf.theme') ?? 'system');
  useEffect(() => { if (theme === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = theme; localStorageSet('pf.theme', theme); }, [theme]);
  const health = useApi<any>('/health', [], { pollMs: 15_000 });
  return (
    <header className="topbar">
      <button className="btn ghost menu-btn" onClick={menu} aria-label="Open navigation">☰</button>
      <span className="small muted topbar-status">
        {health.data ? <>API <span className="ok-t">●</span> · mode <b>{health.data.mode}</b> · {health.data.networks.join(', ')}{health.data.publicReadOnly && <> · <span className="tag info plain">public read-only</span></>}</> : health.error ? <span className="bad-t">API unreachable</span> : '…'}
      </span>
      <span className="spacer" />
      <select aria-label="Theme" className="small topbar-theme" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
      {me?.user ? (
        <><span className="small">Signed in as <b>{me.user.handle}</b></span><button className="btn sm" onClick={logout}>Sign out</button></>
      ) : me?.devLogin ? (
        <form className="row" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await login(handle.trim().toLowerCase()); } catch (x) { setErr(x); } }}>
          <input aria-label="Handle" placeholder="handle (dev sign-in)" value={handle} onChange={(e) => setHandle(e.target.value)} style={{ width: 170 }} />
          <button className="btn sm primary" disabled={!handle}>Sign in</button>
          {err && <span className="bad-t small">{err.message}</span>}
        </form>
      ) : <span className="small faint">Read-only visitor</span>}
    </header>
  );
}

function ProjectRoutes() {
  const { pid } = useParams();
  const { me } = useSession();
  const q = useApi<any>(`/projects/${pid}`, [pid, me?.user?.id]);
  if (q.error) return <div className="content"><ErrorBox error={q.error} retry={q.reload} /></div>;
  if (!q.data) return <div className="content" />;
  const p = q.data;
  return (
    <Routes>
      <Route index element={<ProjectHome p={p} reload={q.reload} />} />
      <Route path="deployments" element={<Deployments p={p} />} />
      <Route path="deployments/:id" element={<DeploymentDetail p={p} />} />
      <Route path="contracts" element={<Contracts p={p} />} />
      <Route path="contracts/:cid" element={<ContractDetail p={p} />} />
      <Route path="events" element={<Events p={p} />} />
      <Route path="events/:eid" element={<EventDetail p={p} />} />
      <Route path="workflows" element={<Workflows p={p} />} />
      <Route path="workflows/:wid" element={<WorkflowBuilder p={p} />} />
      <Route path="executions" element={<Executions p={p} />} />
      <Route path="executions/:xid" element={<ExecutionDetail p={p} />} />
      <Route path="incidents" element={<Incidents p={p} />} />
      <Route path="incidents/:iid" element={<IncidentDetail p={p} />} />
      <Route path="evidence" element={<EvidenceList p={p} />} />
      <Route path="evidence/:id" element={<EvidenceDetail p={p} />} />
      <Route path="settings" element={<Settings p={p} reload={q.reload} />} />
      <Route path="*" element={<Navigate to="." />} />
    </Routes>
  );
}

export function App() {
  const [open, setOpen] = useState(false);
  return (
    <SessionProvider>
      <div className="layout">
        <Sidebar open={open} close={() => setOpen(false)} />
        <div className="main">
          <TopBar menu={() => setOpen(true)} />
          {SNAPSHOT && <SnapshotNotice />}
          <main>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/network" element={<NetworkHealth />} />
              <Route path="/integrations" element={<IntegrationHealth />} />
              <Route path="/developers" element={<Developers />} />
              <Route path="/p/:pid/*" element={<ProjectRoutes />} />
              <Route path="*" element={<div className="content"><h1>Not found</h1></div>} />
            </Routes>
          </main>
        </div>
      </div>
      <Toaster />
    </SessionProvider>
  );
}
