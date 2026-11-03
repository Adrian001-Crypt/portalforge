import { spawn, type ChildProcess } from 'node:child_process';
import { createPublicClient, createWalletClient, http, defineChain, encodeDeployData, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { LOCAL_ANVIL, JobRegistryAbi, EvidenceRegistryAbi, type NetworkProfile, type WorkflowDefinition } from '@portalforge/domain';
import { loadFoundryArtifact } from '@portalforge/sdk';
import { type Db, newId, now, json } from '@portalforge/store';
import { addContract } from '../../store/test/fixtures';
import { WorkflowEngine } from '../src/engine';

export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
export const deployerAcct = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 });
export const executorAcct = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
export const userAcct = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 2 });

export async function startAnvil(): Promise<{ url: string; profile: NetworkProfile; proc: ChildProcess; stop: () => void }> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const bin = `${process.env.HOME}/.local/toolchains/foundry/anvil`;
  const proc = spawn(bin, ['--port', String(port), '--silent', '--block-time', '1'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const profile: NetworkProfile = { ...LOCAL_ANVIL, id: 'local-anvil', evm: { ...LOCAL_ANVIL.evm, rpcUrl: url, confirmations: 0 } };
  return { url, profile, proc, stop: () => proc.kill('SIGKILL') };
}

export async function deployDemo(profile: NetworkProfile) {
  const chain = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [profile.evm.rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(profile.evm.rpcUrl) });
  const wallet = createWalletClient({ account: deployerAcct, chain, transport: http(profile.evm.rpcUrl) });
  const out = {} as Record<'JobRegistry' | 'EvidenceRegistry', { address: Hex; block: number }>;
  for (const name of ['JobRegistry', 'EvidenceRegistry'] as const) {
    const a = loadFoundryArtifact('contracts/evm/out', name);
    const hash = await wallet.sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: [deployerAcct.address, executorAcct.address] }) });
    const r = await pub.waitForTransactionReceipt({ hash });
    out[name] = { address: r.contractAddress!, block: Number(r.blockNumber) };
  }
  const user = createWalletClient({ account: userAcct, chain, transport: http(profile.evm.rpcUrl) });
  const requestJob = async (input: bigint) => {
    const hash = await user.writeContract({ address: out.JobRegistry.address, abi: JobRegistryAbi, functionName: 'requestJob', args: [input] });
    return pub.waitForTransactionReceipt({ hash });
  };
  return { ...out, pub, wallet, requestJob, chain };
}

export function registerDemoContracts(db: Db, projectId: string, networkId: string, jobs: { address: string; block: number }, evidence: { address: string; block: number }) {
  addContract(db, projectId, networkId, 'jobs', jobs.address, JobRegistryAbi, jobs.block);
  addContract(db, projectId, networkId, 'evidence', evidence.address, EvidenceRegistryAbi, evidence.block);
  for (const [alias, fn] of [['jobs', 'completeJob'], ['evidence', 'register']]) {
    db.run(`INSERT INTO contract_policies (id, project_id, contract_alias, function_name, max_calls_per_hour, max_fee_wei, created_at) VALUES (?, ?, ?, ?, 50, ?, ?)`, newId('pol'), projectId, alias, fn, (10n ** 18n).toString(), now());
  }
}

export function addConnector(db: Db, projectId: string, name: string, url: string, queryUrl: string | null) {
  db.run(`INSERT INTO connectors (id, project_id, name, url, query_url, allow_private_host, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`, newId('con'), projectId, name, url, queryUrl, now());
}

export function createWorkflow(engine: WorkflowEngine, projectId: string, def: WorkflowDefinition | unknown, opts: { enabled?: boolean; startBlock?: number } = {}) {
  const id = newId('wf');
  engine.db.run('INSERT INTO workflows (id, project_id, name, enabled, start_block, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, projectId, (def as any).name + '-' + id.slice(-4), opts.enabled === false ? 0 : 1, opts.startBlock ?? 0, now(), now());
  const v = engine.saveVersion(id, def, 'test');
  engine.db.run('UPDATE workflows SET active_version = ? WHERE id = ?', v.version, id);
  return { id, ...v };
}

export const squareWorkflow = (opts: { write?: boolean; evidence?: boolean } = {}): WorkflowDefinition => ({
  schema: 'portalforge.workflow/v1',
  name: 'job-square',
  description: 'Square the requested input with the demo service and complete the job on-chain.',
  trigger: { type: 'event', contract: 'jobs', event: 'JobRequested', minFinality: 'unconfirmed' },
  concurrency: 4,
  steps: [
    { id: 'guard', type: 'condition', needs: [], timeoutMs: 5000, condition: { op: 'lte', left: 'trigger.args.input', right: 4294967295 } },
    { id: 'compute', type: 'http', needs: ['guard'], timeoutMs: 5000, connector: 'demo', idempotency: 'query-before-retry', body: { jobId: '{{trigger.args.jobId}}', input: '{{trigger.args.input}}' }, retry: { maxAttempts: 4, backoffMs: 10, maxBackoffMs: 50, jitter: false } },
    { id: 'check', type: 'validate', needs: ['compute'], timeoutMs: 5000, value: 'steps.compute.output', schema: { type: 'object', required: ['result', 'resultHash'], properties: { result: { type: 'integer', min: 0 }, resultHash: { type: 'string', pattern: '^0x[0-9a-f]{64}$' } } } },
    ...(opts.write ? [{ id: 'complete', type: 'contract_call' as const, needs: ['check'], timeoutMs: 20000, contract: 'jobs', function: 'completeJob', mode: 'write' as const, args: ['{{trigger.args.jobId}}', '{{execution.id}}', '{{steps.compute.output.result}}', '{{steps.compute.output.resultHash}}'], retry: { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 50, jitter: false } }] : []),
    ...(opts.evidence ? [{ id: 'proof', type: 'evidence' as const, needs: [opts.write ? 'complete' : 'check'], timeoutMs: 20000, kind: 'execution' as const, include: ['trigger.eventId', 'steps.compute.output', ...(opts.write ? ['steps.complete.output.txHash'] : [])], register: !!opts.write }] : []),
  ],
} as WorkflowDefinition);

export const fakeEvent = (db: Db, networkId: string, address: string, block: number, jobId: number, input: number, finality = 'safe') => {
  const id = `${networkId}:evm:0x${block.toString(16).padStart(64, '0')}:0:${jobId}`;
  db.run(`INSERT INTO events (id, network_id, interface, block_number, block_hash, tx_hash, log_index, address, event_name, decoder_version, args, finality, observed_at, raw) VALUES (?, ?, 'evm', ?, ?, ?, ?, ?, 'JobRequested', 'test', ?, ?, ?, '{}')`,
    id, networkId, block, `0x${block.toString(16).padStart(64, '0')}`, `0x${jobId.toString(16).padStart(64, '0')}`, jobId, address.toLowerCase(), json({ jobId: String(jobId), requester: '0x00000000000000000000000000000000000000b0', input: String(input), inputHash: '0x' + '0'.repeat(64) }), finality, now());
  return id;
};
