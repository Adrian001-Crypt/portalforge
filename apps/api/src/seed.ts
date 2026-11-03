import { existsSync, readFileSync } from 'node:fs';
import { JobRegistryAbi, EvidenceRegistryAbi, WorkflowExecutionRegistryAbi, hashCanonical } from '@portalforge/domain';
import { type Db, type Logger, type PfConfig, newId, now, json } from '@portalforge/store';
import type { WorkflowEngine } from '@portalforge/workflow-engine';

const ABIS: Record<string, unknown> = { JobRegistry: JobRegistryAbi, EvidenceRegistry: EvidenceRegistryAbi, WorkflowExecutionRegistry: WorkflowExecutionRegistryAbi };
const ALIASES: Record<string, string> = { JobRegistry: 'jobs', EvidenceRegistry: 'evidence', WorkflowExecutionRegistry: 'workflow-registry' };

/**
 * Idempotent demo setup for the first configured network: a public read-only project whose contracts come
 * from the real deployment manifest (deployments/<network>.json). Without a manifest no contracts are
 * registered — nothing is invented.
 */
export function seedDemo(db: Db, engine: WorkflowEngine, cfg: PfConfig, log: Logger) {
  const net = cfg.networks[0];
  const slug = net.kind === 'portaldot-testnet' ? 'portaldot-testnet-demo' : 'local-demo';
  if (db.get('SELECT 1 FROM projects WHERE slug = ?', slug)) return;
  const t = now();
  db.tx(() => {
    db.run(`INSERT INTO users (id, handle, display_name, created_at) VALUES ('usr_demo_owner', 'demo-owner', 'Demo owner', ?) ON CONFLICT DO NOTHING`, t);
    const pid = newId('prj');
    db.run(`INSERT INTO projects (id, slug, name, description, environment, visibility, network_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'public_readonly', ?, 'usr_demo_owner', ?, ?)`,
      pid, slug, net.kind === 'portaldot-testnet' ? 'PortalForge Demo (Portaldot V3 testnet)' : 'PortalForge Demo (local Anvil)', 'DemoService job → workflow → on-chain completion → evidence. Read-only for visitors.', net.kind === 'portaldot-testnet' ? 'testnet' : 'development', net.id, t, t);
    db.run(`INSERT INTO members (project_id, user_id, role, added_at) VALUES (?, 'usr_demo_owner', 'owner', ?)`, pid, t);
    const mpath = `${process.env.PF_DEPLOYMENTS_DIR ?? 'deployments'}/${net.id}.json`;
    if (existsSync(mpath)) {
      const m = JSON.parse(readFileSync(mpath, 'utf8'));
      for (const ct of m.contracts) {
        const cid = newId('ctr');
        db.run(`INSERT INTO contracts (id, project_id, alias, network_id, runtime, address, deploy_block, deploy_tx, source_commit, compiler, labels, verification, created_at, updated_at) VALUES (?, ?, ?, ?, 'evm', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          cid, pid, ALIASES[ct.name] ?? ct.name, net.id, ct.address.toLowerCase(), ct.deployBlock, ct.deployTx, m.source.commit, json(m.compiler), json(['template', ct.name]), json({ runtimeCodeHash: ct.runtimeCodeHash, manifestHash: hashCanonical(m), source: 'manifest', checkedAt: t }), t, t);
        db.run('INSERT INTO contract_abis (contract_id, version, abi, abi_hash, note, created_at) VALUES (?, 1, ?, ?, ?, ?)', cid, json(ABIS[ct.name] ?? []), hashCanonical(ABIS[ct.name] ?? []), 'template', t);
      }
      db.run(`INSERT INTO deployments (id, project_id, network_id, manifest, manifest_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'imported', ?)`, newId('dep'), pid, net.id, json(m), hashCanonical(m), t);
      const fee = net.kind === 'portaldot-testnet' ? (5n * 10n ** 18n).toString() : (10n ** 17n).toString();
      for (const [alias, fn] of [['jobs', 'completeJob'], ['evidence', 'register']]) db.run(`INSERT INTO contract_policies (id, project_id, contract_alias, function_name, max_calls_per_hour, max_fee_wei, created_at) VALUES (?, ?, ?, ?, 30, ?, ?)`, newId('pol'), pid, alias, fn, fee, t);
    } else log('no deployment manifest for demo network; contracts not registered', { path: mpath }, 'warn');
    const demoUrl = process.env.PF_DEMO_SERVICE_URL ?? 'http://127.0.0.1:4310';
    db.run(`INSERT INTO connectors (id, project_id, name, url, query_url, allow_private_host, created_at) VALUES (?, ?, 'demo', ?, ?, ?, ?)`, newId('con'), pid, `${demoUrl}/v1/square`, `${demoUrl}/v1/square`, demoUrl.includes('127.0.0.1') || demoUrl.includes('localhost') ? 1 : 0, t);
    const def = JSON.parse(readFileSync('examples/workflows/job-square.json', 'utf8'));
    if (net.kind === 'local-dev') def.trigger.minFinality = 'unconfirmed';
    // Without a deployed EvidenceRegistry the evidence is hashed and kept locally (labelled), not registered.
    if (!db.get(`SELECT 1 FROM contracts WHERE project_id = ? AND alias = 'evidence'`, pid)) { const proof = def.steps.find((s: any) => s.id === 'proof'); if (proof) proof.register = false; }
    const wid = newId('wf');
    const startBlock = db.get(`SELECT MIN(deploy_block) b FROM contracts WHERE project_id = ?`, pid)?.b ?? 0;
    db.run('INSERT INTO workflows (id, project_id, name, enabled, start_block, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', wid, pid, 'job-square', existsSync(mpath) ? 1 : 0, startBlock, t, t);
    const v = engine.saveVersion(wid, def, 'seed');
    db.run('UPDATE workflows SET active_version = ? WHERE id = ?', v.version, wid);
    log('demo project seeded', { slug, network: net.id, contracts: existsSync(mpath) });
  });
}
