import { BUILTIN_NETWORKS, NetworkProfile, PfError } from '@portalforge/domain';
import { type Db, json, now } from './db';

/** Runtime configuration from environment. Missing config disables the dependent feature explicitly. */
export interface PfConfig {
  dbPath: string;
  networks: NetworkProfile[];
  mode: 'local' | 'testnet' | 'demo';
  publicReadOnly: boolean;
}

export function loadConfig(env = process.env): PfConfig {
  const mode = (env.PF_MODE ?? 'local') as PfConfig['mode'];
  if (!['local', 'testnet', 'demo'].includes(mode)) throw new PfError('NOT_CONFIGURED', `PF_MODE must be local|testnet|demo, got ${mode}`);
  const ids = (env.PF_NETWORKS ?? (mode === 'testnet' ? 'portaldot-v3-testnet' : 'local-anvil')).split(',').map((s) => s.trim()).filter(Boolean);
  const networks = ids.map((id) => {
    const base = BUILTIN_NETWORKS[id];
    if (!base) throw new PfError('NOT_CONFIGURED', `unknown network ${id}`);
    const key = id.toUpperCase().replace(/-/g, '_');
    const p: NetworkProfile = { ...base, evm: { ...base.evm, rpcUrl: env[`PF_EVM_RPC_${key}`] ?? base.evm.rpcUrl } };
    if (p.native && env[`PF_NATIVE_WS_${key}`]) p.native = { ...p.native, wsUrl: env[`PF_NATIVE_WS_${key}`]! };
    return NetworkProfile.parse(p);
  });
  return { dbPath: env.PF_DB ?? 'data/portalforge.db', networks, mode, publicReadOnly: env.PF_PUBLIC_READONLY === '1' };
}

/** Seed built-in networks and their default RPC endpoints (idempotent). */
export function seedNetworks(db: Db, networks: NetworkProfile[]) {
  for (const n of networks) {
    db.run('INSERT INTO networks (id, profile, builtin, created_at) VALUES (?, ?, 1, ?) ON CONFLICT (id) DO UPDATE SET profile = excluded.profile', n.id, json(n), now());
    db.run(`INSERT INTO rpc_endpoints (id, network_id, interface, url, label, builtin, created_at) VALUES (?, ?, 'evm', ?, ?, 1, ?) ON CONFLICT (network_id, url) DO NOTHING`, `rpc_${n.id}_evm`, n.id, n.evm.rpcUrl, `${n.name} EVM RPC`, now());
    if (n.native) db.run(`INSERT INTO rpc_endpoints (id, network_id, interface, url, label, builtin, created_at) VALUES (?, ?, 'native', ?, ?, 1, ?) ON CONFLICT (network_id, url) DO NOTHING`, `rpc_${n.id}_native`, n.id, n.native.wsUrl, `${n.name} native WS`, now());
  }
}
