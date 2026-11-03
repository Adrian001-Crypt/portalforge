import { type NetworkProfile, PfError } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';
import { NativeReader, accountIdToH160, h160ToFallbackAccountId } from '@portalforge/portaldot-native';

export type CheckStatus = 'supported' | 'unsupported' | 'error' | 'mismatch' | 'info';
export interface Check { id: string; area: 'native' | 'evm' | 'correlation' | 'mapping' | 'identity'; status: CheckStatus; summary: string; evidence?: unknown }
export interface CapabilityReport {
  schema: 'portalforge.capabilities/v1';
  networkId: string;
  probedAt: string;
  durationMs: number;
  endpoints: { evm: string; native: string | null };
  checks: Check[];
}

// Opcode probes: tiny init codes run through eth_call (no deployment, no funds).
const OPCODE_PROBES: { id: string; fork: string; code: `0x${string}`; expect: (ret: string) => boolean }[] = [
  { id: 'opcode.create_basic', fork: 'frontier', code: '0x600a600c600039600a6000f3602a60005260206000f3', expect: (r) => r === '0x602a60005260206000f3' },
  { id: 'opcode.push0', fork: 'shanghai', code: '0x5f5f5260206000f3', expect: (r) => /^0x0{64}$/.test(r) },
  { id: 'opcode.tstore_tload', fork: 'cancun', code: '0x602a60015d60015c60005260206000f3', expect: (r) => r.endsWith('2a') && r.length === 66 },
  { id: 'opcode.mcopy', fork: 'cancun', code: '0x602a6000526020600060205e60206020f3', expect: (r) => r.endsWith('2a') && r.length === 66 },
  { id: 'opcode.chainid', fork: 'istanbul', code: '0x4660005260206000f3', expect: (r) => r.length === 66 },
];

// Public, well-known test vector (Substrate dev "Alice" public key) — not a secret, used only to compare mapping math.
const ALICE_PUBKEY = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const SAMPLE_H160 = '0x1000000000000000000000000000000000000001';

export async function probeNetwork(profile: NetworkProfile, opts: { nativeUrl?: string; evmUrl?: string; skipNative?: boolean } = {}): Promise<CapabilityReport> {
  const t0 = Date.now();
  const checks: Check[] = [];
  const push = (c: Check) => checks.push(c);
  const evmUrl = opts.evmUrl ?? profile.evm.rpcUrl;
  const evm = new EvmReader(evmUrl);

  // ---------- EVM ----------
  let evmHead: number | null = null;
  const chainId = await evm.raw<string>('eth_chainId');
  if (!chainId.ok) push({ id: 'evm.chain_id', area: 'identity', status: 'error', summary: chainId.error.message });
  else {
    const id = Number.parseInt(chainId.value, 16);
    push({ id: 'evm.chain_id', area: 'identity', status: id === profile.evm.chainId ? 'supported' : 'mismatch', summary: `chainId ${id} (expected ${profile.evm.chainId})`, evidence: { chainId: id, latencyMs: Math.round(chainId.ms) } });
  }
  const cv = await evm.raw<string>('web3_clientVersion');
  push({ id: 'evm.client_version', area: 'evm', status: cv.ok ? 'info' : 'error', summary: cv.ok ? cv.value : cv.error.message });
  for (const tag of ['latest', 'safe', 'finalized'] as const) {
    const r = await evm.raw<any>('eth_getBlockByNumber', [tag, false]);
    if (r.ok && r.value) {
      const num = Number.parseInt(r.value.number, 16);
      if (tag === 'latest') evmHead = num;
      push({ id: `evm.block_tag.${tag}`, area: 'evm', status: 'supported', summary: `${tag} = #${num}`, evidence: { number: num, hash: r.value.hash, timestamp: Number.parseInt(r.value.timestamp, 16) } });
    } else push({ id: `evm.block_tag.${tag}`, area: 'evm', status: r.ok ? 'unsupported' : 'error', summary: r.ok ? 'null block' : r.error.message });
  }
  for (const m of ['eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_syncing', 'net_version']) {
    const r = await evm.raw<unknown>(m);
    push({ id: `evm.method.${m}`, area: 'evm', status: r.ok ? 'supported' : r.error.kind === 'method_missing' ? 'unsupported' : 'error', summary: r.ok ? JSON.stringify(r.value) : r.error.message });
  }
  for (const m of ['eth_newFilter', 'eth_subscribe']) {
    const r = await evm.raw<unknown>(m, m === 'eth_newFilter' ? [{}] : ['newHeads']);
    push({ id: `evm.method.${m}`, area: 'evm', status: r.ok ? 'supported' : r.error.kind === 'method_missing' ? 'unsupported' : 'error', summary: r.ok ? 'available' : r.error.message });
  }
  const fh = await evm.raw<any>('eth_feeHistory', ['0x4', 'latest', []]);
  push({ id: 'evm.method.eth_feeHistory', area: 'evm', status: fh.ok ? 'supported' : 'error', summary: fh.ok ? `baseFee ${fh.value.baseFeePerGas?.[0]}` : fh.error.message });
  if (evmHead !== null) {
    const span = Math.min(evmHead, 50_000);
    const lr = await evm.raw<any[]>('eth_getLogs', [{ fromBlock: `0x${(evmHead - span).toString(16)}`, toBlock: `0x${evmHead.toString(16)}` }]);
    push({ id: 'evm.get_logs_range', area: 'evm', status: lr.ok ? 'supported' : 'error', summary: lr.ok ? `${span}-block range returned ${lr.value.length} logs in ${Math.round(lr.ms)}ms` : lr.error.message, evidence: { span, ms: Math.round(lr.ms), count: lr.ok ? lr.value.length : null } });
  }
  for (const p of OPCODE_PROBES) {
    const r = await evm.raw<string>('eth_call', [{ data: p.code }, 'latest']);
    push({ id: `evm.${p.id}`, area: 'evm', status: r.ok ? (p.expect(r.value) ? 'supported' : 'mismatch') : 'unsupported', summary: r.ok ? `${p.fork} opcode probe returned ${r.value.slice(0, 20)}…` : `${p.fork}: ${r.error.message}`, evidence: { fork: p.fork, initCode: p.code } });
  }
  const eg = await evm.raw<string>('eth_estimateGas', [{ data: OPCODE_PROBES[0].code }]);
  push({ id: 'evm.estimate_gas_create', area: 'evm', status: eg.ok ? 'supported' : 'error', summary: eg.ok ? `estimate ${BigInt(eg.value)} gas units for a 22-byte create` : eg.error.message });

  // ---------- Native ----------
  if (!profile.native || opts.skipNative) {
    push({ id: 'native.configured', area: 'native', status: 'unsupported', summary: 'no native interface in profile' });
  } else {
    let native: NativeReader | null = null;
    try {
      native = await NativeReader.connect(opts.nativeUrl ?? profile.native.wsUrl);
      const idn = await native.identity();
      push({ id: 'native.genesis', area: 'identity', status: idn.genesisHash === profile.native.genesisHash ? 'supported' : 'mismatch', summary: `genesis ${idn.genesisHash}`, evidence: idn });
      push({ id: 'native.runtime', area: 'native', status: 'info', summary: `${idn.specName} spec ${idn.specVersion} tx ${idn.transactionVersion}` });
      push({ id: 'native.token', area: 'native', status: idn.tokenDecimals === profile.native.token.decimals && idn.tokenSymbol === profile.native.token.symbol ? 'supported' : 'mismatch', summary: `${idn.tokenSymbol}, ${idn.tokenDecimals} decimals, ss58 ${idn.ss58Format}` });
      const heads = await native.heads();
      push({ id: 'native.heads', area: 'native', status: 'info', summary: `best #${heads.best}, finalized #${heads.finalized}, lag ${heads.best - heads.finalized}`, evidence: heads });
      const rawMd = await native.api.rpc.state.getMetadata();
      push({ id: 'native.metadata', area: 'native', status: 'info', summary: `api decoded metadata v${native.api.runtimeMetadata.version}; state_getMetadata returns v${rawMd.version}` });
      const pallets = native.pallets();
      push({ id: 'native.pallets', area: 'native', status: 'info', summary: `${pallets.length} pallets`, evidence: pallets });
      for (const [pallet, label] of [['Revive', 'pallet-revive (EVM/PVM contracts)'], ['Contracts', 'pallet-contracts (ink!/WASM)']] as const) {
        const has = pallets.includes(pallet);
        const key = pallet === 'Revive' ? 'revive' : 'contracts';
        const consts = has ? Object.fromEntries(Object.entries((native.api.consts as any)[key] ?? {}).filter(([k]) => !['schedule', 'environment'].includes(k)).map(([k, v]: any) => [k, v.toString()])) : null;
        push({ id: `native.pallet.${key}`, area: 'native', status: has ? 'supported' : 'unsupported', summary: has ? `${label} present` : `${label} absent`, evidence: { consts, calls: has ? Object.keys((native.api.tx as any)[key]) : [], events: has ? Object.keys((native.api.events as any)[key]) : [] } });
      }
      const methods = (await native.api.rpc.rpc.methods()).methods.map((m) => m.toString());
      push({ id: 'native.rpc_methods', area: 'native', status: 'info', summary: `${methods.length} RPC methods`, evidence: methods });
      for (const m of ['system_dryRun', 'payment_queryInfo', 'state_call', 'archive_v1_body', 'chainHead_v1_follow']) push({ id: `native.method.${m}`, area: 'native', status: methods.includes(m) ? 'supported' : 'unsupported', summary: methods.includes(m) ? 'listed by rpc_methods' : 'not listed' });
      const unsafe = methods.filter((m) => /^(author_(insertKey|rotateKeys|removeExtrinsic)|system_(addReservedPeer|removeReservedPeer|addLogFilter|resetLogFilter)|offchain_)/.test(m));
      push({ id: 'native.unsafe_rpc_listed', area: 'native', status: 'info', summary: unsafe.length ? `${unsafe.length} operator-class methods are listed (not called by PortalForge)` : 'none listed', evidence: unsafe });
      const health = await native.api.rpc.system.health();
      push({ id: 'native.peers', area: 'native', status: 'info', summary: `peers ${health.peers.toNumber()}, syncing ${health.isSyncing.isTrue}` });

      // ---------- mapping ----------
      try {
        const live = (await native.reviveAddress(ALICE_PUBKEY)).toLowerCase();
        const local = accountIdToH160(ALICE_PUBKEY).toLowerCase();
        push({ id: 'mapping.account_to_h160', area: 'mapping', status: live === local ? 'supported' : 'mismatch', summary: `reviveApi.address(dev pubkey) = ${live}; local keccak rule = ${local}` });
        const liveAcc = (await native.reviveAccountId(SAMPLE_H160)).toLowerCase();
        const localAcc = h160ToFallbackAccountId(SAMPLE_H160);
        push({ id: 'mapping.h160_to_account', area: 'mapping', status: liveAcc === localAcc ? 'supported' : 'mismatch', summary: `reviveApi.accountId(${SAMPLE_H160}) = ${liveAcc}; local fallback rule = ${localAcc}` });
      } catch (e) { push({ id: 'mapping.revive_api', area: 'mapping', status: 'error', summary: (e as Error).message }); }

      // ---------- correlation ----------
      if (evmHead !== null) {
        const n = Math.min(evmHead, heads.finalized) - 1;
        const [eb, nh, rh] = await Promise.all([evm.block(n), native.blockHash(n), native.reviveEthBlockHash(n)]);
        const same = !!eb && !!rh && eb.hash.toLowerCase() === rh.toLowerCase();
        push({ id: 'correlation.block_numbers', area: 'correlation', status: same ? 'supported' : 'mismatch', summary: same ? `EVM block #${n} hash equals reviveApi.ethBlockHash(${n}); native block hash at #${n} is a different (Substrate) hash` : `could not tie EVM #${n} to native #${n}`, evidence: { number: n, evmHash: eb?.hash, reviveEthBlockHash: rh, nativeHash: nh } });
        push({ id: 'correlation.heads', area: 'correlation', status: 'info', summary: `EVM latest #${evmHead}, native best #${heads.best}` });
      }
    } catch (e) {
      push({ id: 'native.connect', area: 'native', status: 'error', summary: e instanceof PfError ? e.message : (e as Error).message });
    } finally {
      await native?.disconnect().catch(() => {});
    }
  }
  return { schema: 'portalforge.capabilities/v1', networkId: profile.id, probedAt: new Date().toISOString(), durationMs: Date.now() - t0, endpoints: { evm: evmUrl, native: profile.native ? (opts.nativeUrl ?? profile.native.wsUrl) : null }, checks };
}
