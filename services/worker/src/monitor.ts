import { keccak256, type Hex } from 'viem';
import type { NetworkProfile } from '@portalforge/domain';
import { type Db, type Logger, parse } from '@portalforge/store';
import { EvmReader } from '@portalforge/portaldot-evm';
import { NativeReader } from '@portalforge/portaldot-native';
import { sampleEvm, sampleNative, storeSample, evaluateNetworkRules, evaluateIndexerRules, raiseIncident, raiseCodeMismatch, deliverNotifications, type RaiseInput } from '@portalforge/ops';

/** Periodic observation: RPC samples, rule evaluation, contract code drift. Read-only against chains. */
export class Monitor {
  private natives = new Map<string, { reader: NativeReader | null; lastTry: number; error?: string }>();
  private lastDrift = 0;
  constructor(readonly db: Db, readonly networks: NetworkProfile[], readonly log: Logger) {}

  private raise = (r: RaiseInput) => {
    const res = raiseIncident(this.db, r);
    if (res.isNew || res.reopened) { this.log('incident', { id: res.id, kind: r.kind, severity: r.severity, title: r.title }, 'warn'); deliverNotifications(this.db, res.id).catch(() => {}); }
  };

  async tick() {
    for (const p of this.networks) {
      for (const ep of this.db.all<{ id: string; url: string; interface: string }>('SELECT * FROM rpc_endpoints WHERE network_id = ?', p.id)) {
        if (ep.interface === 'evm') storeSample(this.db, await sampleEvm(ep, p));
        else {
          const n = this.natives.get(ep.id) ?? { reader: null, lastTry: 0 };
          this.natives.set(ep.id, n);
          if (!n.reader?.connected && Date.now() - n.lastTry > 30_000) {
            n.lastTry = Date.now();
            try { n.reader = await NativeReader.connect(ep.url, 15_000); n.error = undefined; } catch (e) { n.reader = null; n.error = (e as Error).message; }
          }
          storeSample(this.db, await sampleNative(ep, n.reader?.connected ? n.reader : null, n.error));
        }
      }
      evaluateNetworkRules(this.db, p.id, this.raise);
    }
    evaluateIndexerRules(this.db, this.raise);
    if (Date.now() - this.lastDrift > 5 * 60_000) { this.lastDrift = Date.now(); await this.checkCodeDrift(); }
    this.db.run('DELETE FROM rpc_samples WHERE at < ?', Date.now() - 7 * 86_400_000);
  }

  async checkCodeDrift() {
    for (const c of this.db.all(`SELECT c.*, p.network_id pnet FROM contracts c JOIN projects p ON p.id = c.project_id WHERE c.verification IS NOT NULL`)) {
      const v = parse<any>(c.verification);
      const expected = v?.runtimeCodeHash as Hex | undefined;
      const profile = this.networks.find((n) => n.id === c.network_id);
      if (!expected || !profile) continue;
      try {
        const code = await new EvmReader(profile.evm.rpcUrl).code(c.address as Hex);
        const actual = code === '0x' ? null : keccak256(code);
        if (actual !== expected) raiseCodeMismatch(this.raise, { id: c.id, alias: c.alias, address: c.address, networkId: c.network_id, projectId: c.project_id, expected, actual });
      } catch (e) { this.log('code drift check failed', { contract: c.id, error: (e as Error).message }, 'warn'); }
    }
  }

  async close() { for (const n of this.natives.values()) await n.reader?.disconnect().catch(() => {}); }
}
