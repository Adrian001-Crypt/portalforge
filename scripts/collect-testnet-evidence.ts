/**
 * Read-only: rebuilds the testnet evidence from the chain itself and compares it with what the running stack recorded.
 *   PF_MODE=testnet npm run dev   # with the stack that ran the jobs
 *   npx tsx scripts/collect-testnet-evidence.ts
 * Writes docs/testnet-evidence/evidence.json and README.md. Exit 1 if chain, indexer, worker or CLI disagree.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeEventLog, type Abi, type Hex } from 'viem';
import { EvidenceRegistryAbi, JobRegistryAbi, PORTALDOT_V3_TESTNET as P } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';
import { NativeReader } from '@portalforge/portaldot-native';

const API = 'http://127.0.0.1:4300/api/v1', SLUG = 'portaldot-testnet-demo';
const WALLET = '5GQapv3fri3PLR6LqzpzcUTeWgBa1r3TmynPXaQ6Le8Uno4v', DEPLOYER_SS58 = '5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t', EXECUTOR_SS58 = '5DUz1yfSnCvrKi5jVreWcD3feVxmxXUk64x8ka2WaEqQ3Xhx';
const get = async (p: string) => (await fetch(`${API}${p}`)).json() as Promise<any>;
const retry = async <T>(f: () => Promise<T>, n = 6): Promise<T> => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 5000)); } } };
const checks: { id: string; ok: boolean; detail: string }[] = [];
const rec = (id: string, ok: boolean, detail: string) => { checks.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const tpot = (wei: bigint) => Number(wei / 10n ** 12n) / 1e6;

const evm = new EvmReader(P.evm.rpcUrl, 30_000);
const n = await retry(() => NativeReader.connect(P.native!.wsUrl, 30_000));
const a: any = n.api;
const finHash = await a.rpc.chain.getFinalizedHead();
const finalized = (await a.rpc.chain.getHeader(finHash)).number.toNumber();
const head = (await a.rpc.chain.getHeader()).number.toNumber();
const chainId = parseInt(((await evm.raw<string>('eth_chainId', [])) as any).value, 16);
const network = { name: (await a.rpc.system.chain()).toString(), chainId, genesis: a.genesisHash.toHex(), specName: a.runtimeVersion.specName.toString(), specVersion: a.runtimeVersion.specVersion.toNumber(), head, finalized };
rec('network.identity', chainId === 420420777 && network.genesis === P.native!.genesisHash && network.specVersion === 3002, `${network.name}, chainId ${chainId}, spec ${network.specVersion}`);

async function tx(hash: string, label: string) {
  const r = await retry(async () => { const x = await evm.receipt(hash as Hex); if (!x) throw new Error(`no receipt ${hash}`); return x; });
  const t: any = await retry(async () => evm.transaction(hash as Hex));
  const nativeHash = (await a.rpc.chain.getBlockHash(r.blockNumber)).toHex();
  const ethHash = (await a.call.reviveApi.ethBlockHash(r.blockNumber)).toString();
  return { label, hash, from: t.from, to: t.to ?? null, nonce: parseInt(t.nonce, 16), status: r.status, block: r.blockNumber, evmBlockHash: r.blockHash, nativeBlockHash: nativeHash, evmHashEqualsReviveApi: ethHash === r.blockHash, state: r.status !== 'success' ? 'failed' : r.blockNumber <= finalized ? 'finalized' : 'in block', gasLimit: BigInt(t.gas).toString(), gasPrice: BigInt(t.gasPrice).toString(), effectiveGasPrice: r.effectiveGasPrice.toString(), gasUsed: r.gasUsed.toString(), feeTpot: tpot(r.gasUsed * r.effectiveGasPrice), logs: r.logs };
}
const strip = ({ logs, ...rest }: any) => rest;
const m = JSON.parse(readFileSync('deployments/portaldot-v3-testnet.json', 'utf8'));
const journal = JSON.parse(readFileSync('deployments/portaldot-v3-testnet.journal.json', 'utf8'));
const deployTxs = [];
for (const c of m.contracts) { const t = await tx(c.deployTx, `deploy ${c.name}`); deployTxs.push({ ...strip(t), contract: c.name, address: c.address, deposit: null }); rec(`deploy.${c.name}`, t.status === 'success' && t.state === 'finalized' && t.evmHashEqualsReviveApi, `${c.address} block ${t.block}, ${t.state}, fee ${t.feeTpot} tPOT`); }
rec('deploy.journal', journal.every((j: any) => j.state === 'confirmed') && journal.length === m.contracts.length, `${journal.length} entries, all confirmed, no duplicate create`);
const funding = strip(await tx(readFileSync('docs/testnet-evidence/01-deploy-apply.log', 'utf8').match(/funded executor [^:]+: (0x[0-9a-f]{64})/)![1], 'fund executor'));

const executions = (await get(`/projects/${SLUG}/executions?limit=50`)).items.reverse();
const events = (await get(`/projects/${SLUG}/events?limit=200`)).items;
const idx = await get(`/projects/${SLUG}/indexer`);
const jobs = [];
for (const summary of executions) {
  const x = await get(`/executions/${summary.id}`);
  const trig = x.trigger;
  const reqEv = events.find((e: any) => e.id === x.trigger_key);
  const label = `job ${reqEv?.args?.jobId}`;
  const request = await tx(reqEv.tx_hash, `${label} requestJob`);
  const compute = x.steps.find((s: any) => s.step_id === 'compute').output;
  const cIntent = x.intents.find((i: any) => i.step_id === 'complete'), pIntent = x.intents.find((i: any) => i.step_id === 'proof');
  const complete = await tx(cIntent.tx_hash, `${label} completeJob`), proof = await tx(pIntent.tx_hash, `${label} register`);
  const decode = (t: any, abi: unknown) => t.logs.map((l: any) => { try { return decodeEventLog({ abi: abi as Abi, data: l.data, topics: l.topics }); } catch { return null; } }).find(Boolean) as any;
  const reqLog = decode(request, JobRegistryAbi), cplLog = decode(complete, JobRegistryAbi), regLog = decode(proof, EvidenceRegistryAbi);
  const ev = x.evidence[0];
  const cli = execFileSync('npm', ['run', '-s', 'pf', '--', 'evidence', 'verify', ev.id, '--api', 'http://127.0.0.1:4300'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const correlated = ['JobRequested', 'JobCompleted', 'EvidenceRegistered'].map((name) => events.find((e: any) => e.event_name === name && e.tx_hash && [request.hash, complete.hash, proof.hash].includes(e.tx_hash)));
  const verifiedPairs = correlated.filter((e: any) => idx.correlations.some((c: any) => c.evm_id === e?.id && c.verified === 1)).length;
  const input = String(reqLog.args.input), result = compute.result;
  rec(`${label}.execution`, x.state === 'succeeded', `execution ${x.id} ${x.state}`);
  rec(`${label}.txs_finalized`, [request, complete, proof].every((t) => t.status === 'success' && t.state === 'finalized'), `requestJob #${request.block}, completeJob #${complete.block}, register #${proof.block}`);
  rec(`${label}.chain_matches_worker`, cplLog.args.executionId === x.id && String(cplLog.args.result) === result && BigInt(result) === BigInt(input) ** 2n && String(reqLog.args.jobId) === String(cplLog.args.jobId), `input ${input}, result ${result}, executionId in JobCompleted equals the worker's`);
  rec(`${label}.chain_matches_evidence`, regLog.args.evidenceId === ev.evidence_id && regLog.args.contentHash === ev.content_hash && regLog.args.subject === x.id, `evidence ${ev.evidence_id}`);
  rec(`${label}.cli_verified`, /^VERIFIED/m.test(cli), cli.split('\n')[0].slice(0, 90));
  rec(`${label}.indexer_events`, correlated.every(Boolean) && correlated.every((e: any) => e.finality === 'finalized' || e.block_number > finalized), `${correlated.filter(Boolean).length}/3 events indexed: ${correlated.map((e: any) => e?.finality).join(', ')}`);
  rec(`${label}.native_correlation`, verifiedPairs === 3, `${verifiedPairs}/3 EVM logs linked to verified native events`);
  jobs.push({ jobId: String(reqLog.args.jobId), input, result, executionId: x.id, executionState: x.state, workflow: { id: x.workflow_id, version: x.version }, serviceProcessedAt: compute.processedAt, evidenceId: ev.evidence_id, contentHash: ev.content_hash, registry: ev.registry, completeStepOutput: x.steps.find((s: any) => s.step_id === 'complete').output, intents: x.intents.map((i: any) => ({ step: i.step_id, state: i.state, tx: i.tx_hash, nonce: i.nonce })), transactions: [request, complete, proof].map(strip), startedAt: x.created_at, finishedAt: x.finished_at });
}
const balances: Record<string, unknown> = {};
for (const [name, ss58, h160] of [['wallet', WALLET, null], ['deployer', DEPLOYER_SS58, '0xAC575944f0696eF19e7f835fd28491c25e40Ca14'], ['executor', EXECUTOR_SS58, '0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25']] as const) {
  const acc = await a.query.system.account(ss58);
  balances[name] = { ss58, free: Number(BigInt(acc.data.free.toString()) / 10n ** 10n) / 1e4, reserved: Number(BigInt(acc.data.reserved.toString()) / 10n ** 10n) / 1e4, frozen: Number(BigInt(acc.data.frozen.toString()) / 10n ** 10n) / 1e4, ...(h160 ? { h160, evmSpendable: Number((await evm.balance(h160 as Hex)) / 10n ** 14n) / 1e4, evmNonce: await evm.nonce(h160 as Hex, 'latest') } : {}) };
}
await n.disconnect();
const failed = checks.filter((c) => !c.ok);
writeFileSync('docs/testnet-evidence/evidence.json', JSON.stringify({ collectedAt: new Date().toISOString(), network, source: m.source, contracts: deployTxs, funding, jobs, balances, checks, passed: checks.length - failed.length, failed: failed.length }, null, 2) + '\n');
const row = (t: any) => `| ${t.label} | \`${t.hash}\` | ${t.block} | ${t.state} | ${t.gasLimit} | ${t.gasUsed} | ${t.effectiveGasPrice} | ${t.feeTpot} |`;
const head2 = '| Transaction | Hash | Block | State | Gas limit | Gas used | Gas price paid | Fee (tPOT) |\n|---|---|---|---|---|---|---|---|';
const b: any = balances;
writeFileSync('docs/testnet-evidence/README.md', `# Portaldot V3 testnet evidence

Generated by \`scripts/collect-testnet-evidence.ts\` at ${new Date().toISOString()}, from the chain and the running stack. Raw data: [evidence.json](evidence.json). Cross-checks: ${checks.length - failed.length}/${checks.length} passed.

**Network:** ${network.name}, chainId ${network.chainId}, genesis \`${network.genesis}\`, runtime ${network.specName} ${network.specVersion}. Native head #${network.head}, finalized #${network.finalized} when collected. No block explorer exists, so anyone can check these with \`eth_getTransactionReceipt\` on ${P.evm.rpcUrl}.

## Contracts

| Contract | Address |
|---|---|
${deployTxs.map((c: any) => `| ${c.contract} | \`${c.address}\` |`).join('\n')}

Deployed from source commit \`${m.source.commit}\`. Owner \`0xAC575944f0696eF19e7f835fd28491c25e40Ca14\`, executor and writer \`0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25\`.

## Deployment

${head2}
${[...deployTxs, funding].map(row).join('\n')}

"Finalized" means the block number is at or below GRANDPA's finalized head. The fee includes the storage deposit, which pallet-revive folds into gas: 161.037 + 176.091 tPOT measured by dry-run. The funding fee includes the 0.1 tPOT existential deposit of the new account.

${jobs.map((j: any) => `## Job ${j.jobId}: input ${j.input}, result ${j.result}

Execution \`${j.executionId}\`, state **${j.executionState}**. Evidence id \`${j.evidenceId}\`, content hash \`${j.contentHash}\`. The service answered at ${j.serviceProcessedAt}.

${head2}
${j.transactions.map(row).join('\n')}

Worker record for \`completeJob\`: ${j.completeStepOutput.replacedTx ? '**took the wrong path**, see below' : 'normal path, receipt recorded after finality'}. Intents: ${j.intents.map((i: any) => `${i.step} ${i.state}`).join(', ')}.
`).join('\n')}
## What went wrong in job 1, and the fix

Job 1 succeeded and its transactions are real, but the trace showed \`alreadyApplied\` and \`replacedTx\` for \`completeJob\`, and that intent stayed \`sent\`. Portaldot's \`eth-rpc\` had already served the new account nonce while the transaction and its receipt were not yet indexed. The worker read that as "replaced by another transaction", checked the contract, found the job complete, and moved on without waiting for finality.

The fix (commit \`7f50435\`) gives the index two minutes before concluding anything, and is tested with a simulated lag on a local chain. Job 2 ran on the fixed code and took the normal path. The job 1 record is kept as it happened in [03-execution-job-1-input-12.json](03-execution-job-1-input-12.json). Job 2 used one of the two spare jobs because the fix could only be proven on V3. The third job was not used.

## Balances when collected (tPOT)

| Account | Address | Free | Reserved | Spendable from EVM |
|---|---|---|---|---|
| Receiving wallet | \`${b.wallet.ss58}\` | ${b.wallet.free} | ${b.wallet.reserved} | n/a |
| Deployer | \`${b.deployer.ss58}\` | ${b.deployer.free} | ${b.deployer.reserved} | ${b.deployer.evmSpendable} |
| Executor | \`${b.executor.ss58}\` | ${b.executor.free} | ${b.executor.reserved} | ${b.executor.evmSpendable} |

## Cross-checks

${checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} \`${c.id}\`: ${c.detail}`).join('\n')}

## Not shown here

- The demo service called by the workflow runs on the operator's machine. It is a real HTTP service, not part of the chain.
- Fault recovery was exercised on a local chain only, to save testnet tokens.
- No real browser wallet (such as MetaMask) signed on V3. Transactions were signed by the project's own keys.
`);
console.log(JSON.stringify(balances));
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
