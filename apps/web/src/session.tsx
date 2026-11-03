import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrf } from './api';

interface Me { user: { id: string; handle: string } | null; memberships?: { project_id: string; role: string; name: string; slug: string }[]; devLogin?: boolean; publicReadOnly?: boolean }
const Ctx = createContext<{ me: Me | null; refresh: () => Promise<void>; login: (h: string) => Promise<void>; logout: () => Promise<void>; roleIn: (pid: string) => string | null }>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    try { const m = await api<Me & { csrfToken?: string }>('/auth/me'); setCsrf(m.csrfToken ?? null); setMe(m); }
    catch { setMe({ user: null }); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const login = async (handle: string) => { const r = await api<{ csrfToken: string }>('/auth/dev-login', { method: 'POST', body: { handle } }); setCsrf(r.csrfToken); await refresh(); };
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); setCsrf(null); await refresh(); };
  const roleIn = (pid: string) => me?.memberships?.find((m) => m.project_id === pid || m.slug === pid)?.role ?? null;
  return <Ctx.Provider value={{ me, refresh, login, logout, roleIn }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);
export const canWrite = (role: string | null, perm: 'resource' | 'workflow' | 'run' | 'control' | 'owner') =>
  !!role && ({ resource: ['owner', 'developer'], workflow: ['owner', 'developer'], run: ['owner', 'developer', 'operator'], control: ['owner', 'operator'], owner: ['owner'] } as Record<string, string[]>)[perm].includes(role);
