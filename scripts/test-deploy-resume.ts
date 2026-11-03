/**
 * Deploy journal recovery on a throwaway Anvil (never a public network):
 *  1. crash right after the intent is journaled (before broadcast)  → rerun sends it once
 *  2. crash right after broadcast (hash journaled, receipt unseen)   → rerun finds the receipt, no resend
 *  3. rerun on a complete manifest                                    → nothing sent
 *  4. zero-balance deployer on the live testnet plan                   → refuses to broadcast
 * Asserts the deployer nonce equals the number of contracts. Writes docs/test-results/deploy-resume-latest.json.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, waitFor, rpcUp } from './lib/proc';

const PORT = 19547, url = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'pf-deploy-'));
const results: { id: string; ok: boolean; detail: string }[] = [];
const rec = (id: string, ok: boolean, detail: string) => { results.push({ id, ok, detail }); console.log(`${ok ? '✔' : '✖'} ${id}: ${detail}`); };
const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/deploy.ts', ...args], { env: { ...process.env, PF_EVM_RPC_LOCAL_ANVIL: url, PF_DEPLOYMENTS_DIR: dir, ...extra }, encoding: 'utf8' });
const nonce = async () => Number.parseInt((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 'latest'] }) })).json()).result, 16);
const journal = () => JSON.parse(readFileSync(join(dir, 'local-anvil.journal.json'), 'utf8'));

const anvil = startService('anvil-resume', `${process.env.HOME}/.local/toolchains/foundry/anvil`, ['--port', String(PORT), '--block-time', '1', '--silent'], {}, join(dir, 'logs'));
try {
  await waitFor('anvil', () => rpcUp(url), 20_000);
  let r = run(['apply', 'local-anvil', '--profile', 'minimal', '--confirm'], { PF_DEPLOY_CRASH: 'intent:JobRegistry' });
  rec('crash.after_intent', r.status === 70 && (await nonce()) === 0 && journal()[0].state === 'intent', `exit ${r.status}, nonce ${await nonce()}, journal ${journal()[0].state}`);
  r = run(['apply', 'local-anvil', '--profile', 'minimal', '--confirm'], { PF_DEPLOY_CRASH: 'sent:EvidenceRegistry' });
  const j = journal();
  rec('crash.after_send', r.status === 70 && j.find((e: any) => e.name === 'JobRegistry').state === 'confirmed' && j.find((e: any) => e.name === 'EvidenceRegistry').state === 'sent', `exit ${r.status}, JobRegistry ${j[0].state}, EvidenceRegistry ${j[1]?.state}, nonce ${await nonce()}`);
  await new Promise((res) => setTimeout(res, 2500));
  r = run(['apply', 'local-anvil', '--profile', 'minimal', '--confirm']);
  const m = JSON.parse(readFileSync(join(dir, 'local-anvil.json'), 'utf8'));
  rec('resume.completes', r.status === 0 && m.contracts.length === 2 && (await nonce()) === 2, `exit ${r.status}, ${m.contracts.length} contracts in manifest, deployer nonce ${await nonce()} (2 = no duplicate create)`);
  rec('resume.verified', /pass\s+EvidenceRegistry\.code_hash/.test(r.stdout) && !/^fail/m.test(r.stdout), 'manifest verification after resume: all checks pass');
  r = run(['apply', 'local-anvil', '--profile', 'minimal', '--confirm']);
  rec('rerun.idempotent', r.status === 0 && (await nonce()) === 2 && /already in manifest, skipping/.test(r.stdout), `exit ${r.status}, nonce still ${await nonce()}`);
  r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/deploy.ts', 'apply', 'portaldot-v3-testnet', '--profile', 'minimal', '--confirm'], { env: { ...process.env, PF_DEPLOYMENTS_DIR: dir }, encoding: 'utf8' });
  rec('testnet.insufficient_balance_refuses', r.status === 1 && /BLOCKER: deployer balance/.test(r.stdout) && /plan has blockers; not broadcasting/.test(r.stderr), `exit ${r.status}; "${(r.stdout.match(/BLOCKER: [^\n]+/) ?? [''])[0].slice(0, 80)}…"`);
} finally { await anvil.stop(); }
mkdirSync('docs/test-results', { recursive: true });
writeFileSync('docs/test-results/deploy-resume-latest.json', JSON.stringify({ at: new Date().toISOString(), note: 'Anvil for crash/resume; live testnet only for the read-only balance refusal', results }, null, 2) + '\n');
process.exit(results.every((x) => x.ok) ? 0 : 1);
