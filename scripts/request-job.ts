/**
 * Request a DemoService job from a dedicated PortalForge identity (signs + broadcasts; requires --confirm).
 *   npx tsx scripts/request-job.ts <networkId> <input> --confirm [--as deployer|executor]
 * On local-anvil this uses Anvil's public dev account; on testnet the generated key in .secrets/.
 */
import { readFileSync } from 'node:fs';
import { createWalletClient, createPublicClient, defineChain, http, type Hex } from 'viem';
import { BUILTIN_NETWORKS, JobRegistryAbi } from '@portalforge/domain';
import { loadAccount } from './lib/keys';

const [id, input] = process.argv.slice(2);
const p = BUILTIN_NETWORKS[id];
if (!p || !/^\d+$/.test(input ?? '')) { console.error('usage: request-job.ts <networkId> <uint64 input> --confirm'); process.exit(2); }
if (!process.argv.includes('--confirm')) { console.error('refusing to broadcast without --confirm'); process.exit(3); }
const rpc = process.env[`PF_EVM_RPC_${id.toUpperCase().replace(/-/g, '_')}`] ?? p.evm.rpcUrl;
const m = JSON.parse(readFileSync(`${process.env.PF_DEPLOYMENTS_DIR ?? 'deployments'}/${id}.json`, 'utf8'));
const jobs = m.contracts.find((c: any) => c.name === 'JobRegistry').address as Hex;
const role = (process.argv.includes('--as') ? process.argv[process.argv.indexOf('--as') + 1] : 'deployer') as 'deployer' | 'executor';
const account = loadAccount(id, role);
const chain = defineChain({ id: p.evm.chainId, name: p.name, nativeCurrency: { name: p.evm.nativeCurrency.symbol, symbol: p.evm.nativeCurrency.symbol, decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const sim = await pub.simulateContract({ account, address: jobs, abi: JobRegistryAbi, functionName: 'requestJob', args: [BigInt(input)] });
const gasPrice = (await pub.getGasPrice()) * 102n / 100n;
const hash = await wallet.writeContract({ ...sim.request, gasPrice, type: 'legacy' } as any);
console.log(`sent ${hash}`);
const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
console.log(JSON.stringify({ tx: hash, status: r.status, block: Number(r.blockNumber), jobId: BigInt(r.logs[0].topics[1]!).toString(), feeWei: (r.gasUsed * r.effectiveGasPrice).toString(), requester: account.address }, null, 2));
