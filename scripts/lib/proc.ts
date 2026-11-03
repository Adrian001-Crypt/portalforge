import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface Svc { name: string; proc: ChildProcess; logFile: string; stop: (sig?: NodeJS.Signals) => Promise<void> }

/** Start a long-running child with logs to a file. */
export function startService(name: string, cmd: string, args: string[], env: Record<string, string>, logDir: string): Svc {
  mkdirSync(logDir, { recursive: true });
  const logFile = `${logDir}/${name}.log`;
  const out = createWriteStream(logFile, { flags: 'a' });
  const proc = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.pipe(out); proc.stderr!.pipe(out);
  const stop = (sig: NodeJS.Signals = 'SIGTERM') => new Promise<void>((res) => {
    if (proc.exitCode !== null || proc.signalCode) return res();
    proc.once('exit', () => res());
    proc.kill(sig);
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } res(); }, 8000);
  });
  return { name, proc, logFile, stop };
}

export const tsx = (file: string) => ({ cmd: process.execPath, args: ['--import', 'tsx', file] });

export async function waitFor(what: string, fn: () => Promise<boolean> | boolean, timeoutMs = 60_000, everyMs = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timeout waiting for ${what}`);
}

export const httpOk = async (url: string, init?: RequestInit) => { const r = await fetch(url, init); return r.ok; };
export const rpcUp = (url: string) => httpOk(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });

/**
 * TCP proxy used to inject RPC outages: `pause()` drops every open connection and refuses new ones
 * (ECONNRESET / ECONNREFUSED seen by the client), `resume()` restores forwarding.
 */
export class FaultProxy {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  paused = false;
  constructor(readonly listenPort: number, readonly targetPort: number) {}
  start() {
    return new Promise<void>((res) => {
      this.server = createServer((c) => {
        if (this.paused) { c.destroy(); return; }
        const u = connect(this.targetPort, '127.0.0.1');
        this.sockets.add(c); this.sockets.add(u);
        c.pipe(u); u.pipe(c);
        const done = () => { c.destroy(); u.destroy(); this.sockets.delete(c); this.sockets.delete(u); };
        c.on('error', done); u.on('error', done); c.on('close', done); u.on('close', done);
      }).listen(this.listenPort, '127.0.0.1', () => res());
    });
  }
  pause() { this.paused = true; for (const s of this.sockets) s.destroy(); this.sockets.clear(); }
  resume() { this.paused = false; }
  close() { this.pause(); return new Promise<void>((r) => this.server?.close(() => r()) ?? r()); }
}
