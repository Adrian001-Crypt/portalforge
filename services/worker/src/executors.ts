import { readFileSync, existsSync, statSync } from 'node:fs';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import type { NetworkProfile } from '@portalforge/domain';
import { EvmChainExecutor, type ChainExecutor } from '@portalforge/workflow-engine';
import type { Logger } from '@portalforge/store';

/**
 * Build chain executors. Each network needs an explicit, dedicated executor identity:
 *  - local-anvil: Anvil's published dev account #1 (no real value)
 *  - other networks: PF_EXECUTOR_KEY_FILE_<NETWORK> pointing to a 0600 JSON file from `npm run keygen`
 * A network without an executor has write steps disabled (they fail NOT_CONFIGURED), never a fallback.
 */
export function buildExecutors(networks: NetworkProfile[], log: Logger, env = process.env): Map<string, ChainExecutor> {
  const out = new Map<string, ChainExecutor>();
  for (const p of networks) {
    if (p.id === 'local-anvil') {
      out.set(p.id, new EvmChainExecutor(p, mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 })));
      continue;
    }
    const file = env[`PF_EXECUTOR_KEY_FILE_${p.id.toUpperCase().replace(/-/g, '_')}`];
    if (!file) { log('no executor configured; chain writes disabled', { network: p.id }, 'warn'); continue; }
    if (!existsSync(file)) { log('executor key file missing; chain writes disabled', { network: p.id }, 'error'); continue; }
    const mode = statSync(file).mode & 0o077;
    if (mode) { log('executor key file is readable by group/others; refusing to load', { network: p.id }, 'error'); continue; }
    const { privateKey } = JSON.parse(readFileSync(file, 'utf8')) as { privateKey: Hex };
    const acct = privateKeyToAccount(privateKey);
    out.set(p.id, new EvmChainExecutor(p, acct));
    log('executor loaded', { network: p.id, address: acct.address });
  }
  return out;
}
