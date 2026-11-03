import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, keccak256, type Hex } from 'viem';
import { DeploymentManifest, EvidenceRegistryAbi, JobRegistryAbi, WorkflowExecutionRegistryAbi, hashCanonical, PfError, type NetworkProfile } from '@portalforge/domain';
import { EvmReader } from '@portalforge/portaldot-evm';

export type VerifyStatus = 'pass' | 'fail' | 'skip';
export interface VerifyCheck { id: string; status: VerifyStatus; detail: string }
export interface VerifyReport { ok: boolean; checks: VerifyCheck[]; verifiedAt: string; networkId: string }

const ABIS: Record<string, any> = { JobRegistry: JobRegistryAbi, EvidenceRegistry: EvidenceRegistryAbi, WorkflowExecutionRegistry: WorkflowExecutionRegistryAbi };

async function read(evm: EvmReader, address: Hex, abi: any, functionName: string, args: unknown[] = []) {
  const data = encodeFunctionData({ abi, functionName, args } as any);
  const ret = await evm.call_({ to: address, data });
  return decodeFunctionResult({ abi, functionName, data: ret } as any) as unknown;
}

/**
 * Verify a deployment manifest against the live chain. Every claim in the manifest is re-read from
 * RPC; nothing is trusted from the file except as the expected value.
 */
export async function verifyManifest(input: unknown, profile: NetworkProfile, opts: { expectedExecutor?: Hex; genesisHash?: string | null } = {}): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, status: ok === null ? 'skip' : ok ? 'pass' : 'fail', detail });
  const parsed = DeploymentManifest.safeParse(input);
  if (!parsed.success) {
    add('manifest.schema', false, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return { ok: false, checks, verifiedAt: new Date().toISOString(), networkId: profile.id };
  }
  const m = parsed.data;
  add('manifest.schema', true, 'portalforge.deployment/v1');
  const evm = new EvmReader(profile.evm.rpcUrl);
  const chainId = await evm.chainId();
  add('network.chain_id', chainId === m.network.chainId && chainId === profile.evm.chainId, `rpc ${chainId}, manifest ${m.network.chainId}, profile ${profile.evm.chainId}`);
  if (m.network.genesisHash) {
    if (opts.genesisHash === undefined) add('network.genesis', null, 'native genesis not checked (no native connection supplied)');
    else add('network.genesis', opts.genesisHash === m.network.genesisHash, `native ${opts.genesisHash}, manifest ${m.network.genesisHash}`);
  }
  for (const c of m.contracts) {
    const p = `${c.name}`;
    const code = await evm.code(c.address as Hex);
    add(`${p}.code_exists`, code !== '0x', code === '0x' ? `no code at ${c.address}` : `${(code.length - 2) / 2} bytes at ${c.address}`);
    if (code !== '0x') {
      const h = keccak256(code);
      add(`${p}.code_hash`, h === c.runtimeCodeHash && h === c.artifactRuntimeHash, `chain ${h}; manifest ${c.runtimeCodeHash}; artifact ${c.artifactRuntimeHash}`);
    }
    const r = await evm.receipt(c.deployTx as Hex);
    if (!r) add(`${p}.receipt`, false, `no receipt for ${c.deployTx}`);
    else {
      add(`${p}.receipt_status`, r.status === 'success', `status ${r.status}`);
      add(`${p}.receipt_address`, r.contractAddress?.toLowerCase() === c.address.toLowerCase(), `receipt.contractAddress ${r.contractAddress}`);
      add(`${p}.receipt_block`, r.blockNumber === c.deployBlock && r.blockHash.toLowerCase() === c.deployBlockHash.toLowerCase(), `block #${r.blockNumber} ${r.blockHash}`);
      add(`${p}.deployer`, r.from.toLowerCase() === c.deployer.toLowerCase(), `tx.from ${r.from}`);
      const canonical = await evm.block(c.deployBlock);
      add(`${p}.block_canonical`, !!canonical && canonical.hash.toLowerCase() === c.deployBlockHash.toLowerCase(), `canonical #${c.deployBlock} = ${canonical?.hash}`);
    }
    const abi = ABIS[c.name];
    if (abi) {
      try {
        const owner = (await read(evm, c.address as Hex, abi, 'owner')) as string;
        add(`${p}.owner`, !c.owner || owner.toLowerCase() === c.owner.toLowerCase(), `owner() = ${owner}`);
        const version = (await read(evm, c.address as Hex, abi, 'VERSION')) as bigint;
        add(`${p}.version`, version === 10_000n, `VERSION() = ${version}`);
        if (opts.expectedExecutor) {
          const exp = opts.expectedExecutor.toLowerCase();
          if (c.name === 'JobRegistry') { const e = (await read(evm, c.address as Hex, abi, 'executor')) as string; add(`${p}.executor`, e.toLowerCase() === exp, `executor() = ${e}`); }
          if (c.name === 'EvidenceRegistry') { const w = (await read(evm, c.address as Hex, abi, 'isWriter', [opts.expectedExecutor])) as boolean; add(`${p}.writer`, w, `isWriter(${opts.expectedExecutor}) = ${w}`); }
          if (c.name === 'WorkflowExecutionRegistry') { const w = (await read(evm, c.address as Hex, abi, 'isRecorder', [opts.expectedExecutor])) as boolean; add(`${p}.recorder`, w, `isRecorder(${opts.expectedExecutor}) = ${w}`); }
        }
      } catch (e) { add(`${p}.reads`, false, (e as Error).message); }
    }
    if (c.deployBlock > 0) {
      const before = await evm.logs({ fromBlock: Math.max(0, c.deployBlock - 5_000), toBlock: c.deployBlock - 1, address: c.address as Hex });
      add(`${p}.start_block`, before.length === 0, before.length ? `${before.length} logs before deploy block — start block is wrong` : 'no logs before deploy block (indexer start is safe)');
    }
  }
  return { ok: checks.every((c) => c.status !== 'fail'), checks, verifiedAt: new Date().toISOString(), networkId: profile.id };
}

export interface EvidenceVerifyInput { registry: Hex; evidenceId: Hex; content: unknown; expectedWriter?: Hex; expectedKind?: Hex; fromBlock?: number }

/**
 * Verify evidence against the lean EvidenceRegistry: recompute the canonical content hash locally,
 * read the EvidenceRegistered log for the id (fields), recompute the commitment, and compare with
 * on-chain status(). Proves registration by `writer` — not that the content is true.
 */
export async function verifyEvidence(profile: NetworkProfile, input: EvidenceVerifyInput): Promise<VerifyReport & { localHash: Hex; onchain: Record<string, unknown> | null }> {
  const checks: VerifyCheck[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, status: ok === null ? 'skip' : ok ? 'pass' : 'fail', detail });
  const evm = new EvmReader(profile.evm.rpcUrl);
  const chainId = await evm.chainId();
  add('network.chain_id', chainId === profile.evm.chainId, `rpc ${chainId}, expected ${profile.evm.chainId}`);
  const localHash = hashCanonical(input.content);
  const code = await evm.code(input.registry);
  if (code === '0x') throw new PfError('VERIFICATION_FAILED', `no contract at ${input.registry}`);
  const commitment = (await read(evm, input.registry, EvidenceRegistryAbi, 'commitmentOf', [input.evidenceId])) as Hex;
  const exists = !/^0x0+$/.test(commitment);
  add('evidence.exists', exists, exists ? `commitment ${commitment}` : 'no record for this evidence id');
  let onchain: Record<string, unknown> | null = null;
  if (exists) {
    const topic0 = encodeEventTopics({ abi: EvidenceRegistryAbi, eventName: 'EvidenceRegistered', args: { evidenceId: input.evidenceId } }) as Hex[];
    const head = await evm.blockNumber();
    const logs = await evm.logs({ fromBlock: input.fromBlock ?? 0, toBlock: head, address: input.registry, topics: topic0 });
    if (logs.length !== 1) add('evidence.event', false, `expected 1 EvidenceRegistered log, found ${logs.length}`);
    else {
      const d = decodeEventLog({ abi: EvidenceRegistryAbi, data: logs[0].data, topics: logs[0].topics as [Hex, ...Hex[]] }) as any;
      const { kind, subject, contentHash, writer } = d.args;
      onchain = { contentHash, kind, subject, writer, blockNumber: logs[0].blockNumber, blockHash: logs[0].blockHash, txHash: logs[0].transactionHash, commitment };
      add('evidence.event', true, `registered in tx ${logs[0].transactionHash} at block #${logs[0].blockNumber}`);
      add('evidence.content_hash', contentHash.toLowerCase() === localHash.toLowerCase(), `local ${localHash}; event ${contentHash}`);
      const st = Number(await read(evm, input.registry, EvidenceRegistryAbi, 'status', [input.evidenceId, kind, subject, localHash, writer]));
      add('evidence.commitment', st === 1 || st === 2, ['unknown id', 'active, commitment matches', 'revoked, commitment matches', 'commitment does not match these fields'][st] ?? `status ${st}`);
      add('evidence.not_revoked', st !== 2, st === 2 ? 'record was revoked by its writer' : 'active');
      if (input.expectedWriter) add('evidence.writer', String(writer).toLowerCase() === input.expectedWriter.toLowerCase(), `writer ${writer}`);
      if (input.expectedKind) add('evidence.kind', String(kind).toLowerCase() === input.expectedKind.toLowerCase(), `kind ${kind}`);
      const blk = await evm.block(logs[0].blockNumber);
      add('evidence.block_canonical', !!blk && blk.hash.toLowerCase() === logs[0].blockHash.toLowerCase(), `canonical #${logs[0].blockNumber} = ${blk?.hash}`);
    }
  }
  return { ok: checks.every((c) => c.status !== 'fail'), checks, verifiedAt: new Date().toISOString(), networkId: profile.id, localHash, onchain };
}
