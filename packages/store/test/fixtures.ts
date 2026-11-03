import { Db, newId, now, json } from '@portalforge/store';
import { LOCAL_ANVIL, hashCanonical, type NetworkProfile } from '@portalforge/domain';

/** Fresh in-memory database with one project, owner user, and the local network seeded. */
export function seed(opts: { profile?: NetworkProfile; path?: string } = {}) {
  const db = new Db(opts.path ?? ':memory:').migrate();
  const profile = opts.profile ?? LOCAL_ANVIL;
  const t = now();
  db.run('INSERT INTO networks (id, profile, builtin, created_at) VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING', profile.id, json(profile), t);
  const userId = newId('usr');
  db.run('INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)', userId, `owner-${userId.slice(-4)}`, 'Owner', t);
  const projectId = newId('prj');
  db.run(`INSERT INTO projects (id, slug, name, description, environment, network_id, created_by, created_at, updated_at) VALUES (?, ?, ?, '', 'development', ?, ?, ?, ?)`, projectId, `p-${projectId.slice(-6).toLowerCase()}`, 'Test project', profile.id, userId, t, t);
  db.run(`INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)`, projectId, userId, t);
  return { db, profile, userId, projectId };
}

export function addContract(db: Db, projectId: string, networkId: string, alias: string, address: string, abi: unknown, deployBlock: number) {
  const id = newId('ctr');
  const t = now();
  db.run(`INSERT INTO contracts (id, project_id, alias, network_id, runtime, address, deploy_block, created_at, updated_at) VALUES (?, ?, ?, ?, 'evm', ?, ?, ?, ?)`, id, projectId, alias, networkId, address.toLowerCase(), deployBlock, t, t);
  db.run(`INSERT INTO contract_abis (contract_id, version, abi, abi_hash, created_at) VALUES (?, 1, ?, ?, ?)`, id, json(abi), hashCanonical(abi), t);
  return id;
}
