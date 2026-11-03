import { ApiPromise, WsProvider } from '@polkadot/api';
import { PfError, type NetworkProfile } from '@portalforge/domain';

export interface NativeIdentity {
  chain: string; nodeName: string; nodeVersion: string; genesisHash: string;
  specName: string; specVersion: number; transactionVersion: number;
  ss58Format: number; tokenSymbol: string; tokenDecimals: number;
}
export interface NativeEvent {
  blockNumber: number; blockHash: string; index: number; phase: string; extrinsicIndex: number | null;
  section: string; method: string; data: unknown; specVersion: number;
}
export interface NativeExtrinsic {
  index: number; hash: string; section: string; method: string; signer: string | null;
  success: boolean | null; dispatchError: string | null;
}

/** Native (Substrate) reader. One ApiPromise per process; decoding is done "at" each block hash so runtime upgrades decode with the right metadata. */
export class NativeReader {
  private constructor(readonly api: ApiPromise, readonly url: string) {}

  static async connect(url: string, timeoutMs = 20_000): Promise<NativeReader> {
    const provider = new WsProvider(url, 2_500, {}, timeoutMs);
    const api = await Promise.race([
      ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new PfError('RPC_UNREACHABLE', `native ws connect timeout ${url}`)), timeoutMs)),
    ]).catch(async (e) => { await provider.disconnect().catch(() => {}); throw e instanceof PfError ? e : new PfError('RPC_UNREACHABLE', (e as Error).message); });
    return new NativeReader(api, url);
  }

  async disconnect() { await this.api.disconnect(); }
  get connected() { return this.api.isConnected; }

  async identity(): Promise<NativeIdentity> {
    const [chain, name, version, props, rv] = await Promise.all([
      this.api.rpc.system.chain(), this.api.rpc.system.name(), this.api.rpc.system.version(),
      this.api.rpc.system.properties(), this.api.rpc.state.getRuntimeVersion(),
    ]);
    return {
      chain: chain.toString(), nodeName: name.toString(), nodeVersion: version.toString(),
      genesisHash: this.api.genesisHash.toHex(), specName: rv.specName.toString(), specVersion: rv.specVersion.toNumber(),
      transactionVersion: rv.transactionVersion.toNumber(), ss58Format: Number(props.ss58Format.unwrapOr(42).toString()),
      tokenSymbol: props.tokenSymbol.unwrapOrDefault()[0]?.toString() ?? '?', tokenDecimals: Number(props.tokenDecimals.unwrapOrDefault()[0]?.toString() ?? 'NaN'),
    };
  }

  async assertIdentity(profile: NetworkProfile) {
    if (!profile.native) throw new PfError('NOT_CONFIGURED', `network ${profile.id} has no native interface`);
    const g = this.api.genesisHash.toHex();
    if (g !== profile.native.genesisHash) throw new PfError('NETWORK_MISMATCH', `expected genesis ${profile.native.genesisHash}, endpoint reports ${g}`);
    return g;
  }

  async heads() {
    const [best, finHash] = await Promise.all([this.api.rpc.chain.getHeader(), this.api.rpc.chain.getFinalizedHead()]);
    const fin = await this.api.rpc.chain.getHeader(finHash);
    return { best: best.number.toNumber(), bestHash: best.hash.toHex(), finalized: fin.number.toNumber(), finalizedHash: finHash.toHex() };
  }

  async blockHash(n: number) { const h = await this.api.rpc.chain.getBlockHash(n); return h.isEmpty ? null : h.toHex(); }

  pallets(): string[] { return this.api.runtimeMetadata.asLatest.pallets.map((p) => p.name.toString()); }

  /** Read events + extrinsic outcomes for one block, decoded with that block's runtime. */
  async block(hash: string): Promise<{ number: number; hash: string; parentHash: string; specVersion: number; events: NativeEvent[]; extrinsics: NativeExtrinsic[] }> {
    const [signed, apiAt] = await Promise.all([this.api.rpc.chain.getBlock(hash), this.api.at(hash)]);
    const rv = await this.api.rpc.state.getRuntimeVersion(hash);
    const specVersion = rv.specVersion.toNumber();
    const records = (await apiAt.query.system.events()) as unknown as any[];
    const number = signed.block.header.number.toNumber();
    const events: NativeEvent[] = records.map((r, index) => ({
      blockNumber: number, blockHash: hash, index,
      phase: r.phase.type, extrinsicIndex: r.phase.isApplyExtrinsic ? r.phase.asApplyExtrinsic.toNumber() : null,
      section: r.event.section, method: r.event.method, data: r.event.data.toJSON(), specVersion,
    }));
    const extrinsics: NativeExtrinsic[] = signed.block.extrinsics.map((ex, index) => {
      const outcome = records.find((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index && r.event.section === 'system' && (r.event.method === 'ExtrinsicSuccess' || r.event.method === 'ExtrinsicFailed'));
      let dispatchError: string | null = null;
      if (outcome?.event.method === 'ExtrinsicFailed') {
        const err = outcome.event.data[0];
        if (err.isModule) { try { const m = apiAt.registry.findMetaError(err.asModule); dispatchError = `${m.section}.${m.name}`; } catch { dispatchError = err.toString(); } } else dispatchError = err.toString();
      }
      return {
        index, hash: ex.hash.toHex(), section: ex.method.section, method: ex.method.method,
        signer: ex.isSigned ? ex.signer.toString() : null,
        success: outcome ? outcome.event.method === 'ExtrinsicSuccess' : null, dispatchError,
      };
    });
    return { number, hash, parentHash: signed.block.header.parentHash.toHex(), specVersion, events, extrinsics };
  }

  /** Ask the runtime which H160 pallet-revive assigns to a native account (ground truth for address mapping). */
  async reviveAddress(accountId: string): Promise<string> {
    const call = (this.api.call as any).reviveApi;
    if (!call?.address) throw new PfError('NOT_SUPPORTED', 'reviveApi.address not exposed by runtime');
    return (await call.address(accountId)).toHex();
  }

  async reviveAccountId(h160: string): Promise<string> {
    const call = (this.api.call as any).reviveApi;
    if (!call?.accountId) throw new PfError('NOT_SUPPORTED', 'reviveApi.accountId not exposed by runtime');
    return (await call.accountId(h160)).toHex();
  }

  async reviveEthBlockHash(n: number): Promise<string | null> {
    const call = (this.api.call as any).reviveApi;
    if (!call?.ethBlockHash) return null;
    const r = await call.ethBlockHash(n);
    return r.isSome ? r.unwrap().toHex() : null;
  }

  async freeBalance(accountId: string): Promise<bigint> {
    const acc = (await this.api.query.system.account(accountId)) as any;
    return BigInt(acc.data.free.toString());
  }

  async subscribeRuntimeVersion(cb: (specVersion: number) => void) {
    return this.api.rpc.state.subscribeRuntimeVersion((rv) => cb(rv.specVersion.toNumber()));
  }
}
