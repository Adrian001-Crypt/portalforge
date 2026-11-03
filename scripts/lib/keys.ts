import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount, mnemonicToAccount, type PrivateKeyAccount, type HDAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { h160ToFallbackAccountId, toSs58 } from '@portalforge/portaldot-native';

/**
 * Dedicated PortalForge identities. Keys are generated fresh on this machine, stored under .secrets/
 * (gitignored, mode 600) and never printed. They are testnet-only, low-privilege identities;
 * PortalForge never reads any other wallet, keystore or mnemonic.
 *
 * Local Anvil uses Anvil's public development mnemonic (published by Foundry) — never real funds.
 */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
export type Role = 'deployer' | 'executor';
const ANVIL_INDEX: Record<Role, number> = { deployer: 0, executor: 1 };

export const secretPath = (networkId: string, role: Role) => `.secrets/${networkId}-${role}.json`;

export function loadAccount(networkId: string, role: Role): PrivateKeyAccount | HDAccount {
  if (networkId === 'local-anvil') return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: ANVIL_INDEX[role] });
  const p = secretPath(networkId, role);
  if (!existsSync(p)) throw new Error(`missing ${p}; run: npm run keygen -- ${networkId}`);
  const { privateKey } = JSON.parse(readFileSync(p, 'utf8')) as { privateKey: Hex };
  return privateKeyToAccount(privateKey);
}

export function generateAccount(networkId: string, role: Role): { address: Hex; created: boolean } {
  const p = secretPath(networkId, role);
  if (existsSync(p)) return { address: JSON.parse(readFileSync(p, 'utf8')).address, created: false };
  mkdirSync('.secrets', { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  writeFileSync(p, JSON.stringify({ role, networkId, address, privateKey, createdAt: new Date().toISOString(), note: 'PortalForge testnet-only identity. Do not reuse for real funds.' }, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
  return { address, created: true };
}

/** The native SS58 account that pallet-revive treats as this H160's balance holder (fallback mapping). */
export const fundingAddressFor = (h160: Hex, ss58Format = 42) => toSs58(h160ToFallbackAccountId(h160), ss58Format);
