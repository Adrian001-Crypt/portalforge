import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { u8aToHex, hexToU8a } from '@polkadot/util';
import { keccak256, getAddress, type Hex } from 'viem';
import { PfError } from '@portalforge/domain';

/**
 * pallet-revive account mapping (verified against reviveApi.address / reviveApi.accountId on the live
 * Portaldot V3 testnet, see docs/network-capabilities.md):
 *  - Native AccountId32 -> H160: if bytes[20..32] are all 0xEE the account is an "Ethereum-derived"
 *    fallback account and its H160 is bytes[0..20]; otherwise H160 = keccak256(accountId)[12..32].
 *  - H160 -> AccountId32 (fallback): H160 ++ 0xEE * 12.
 * These are NOT truncations of the SS58 string. The two directions are not inverse for normal
 * sr25519 accounts unless the account is mapped on-chain (Revive.mapAccount).
 */
const EE = 0xee;

export function accountIdToH160(accountId: string | Uint8Array): Hex {
  const bytes = typeof accountId === 'string' ? (accountId.startsWith('0x') ? hexToU8a(accountId) : decodeAddress(accountId)) : accountId;
  if (bytes.length !== 32) throw new PfError('VALIDATION_FAILED', 'AccountId32 must be 32 bytes');
  const isEthDerived = bytes.slice(20).every((b) => b === EE);
  if (isEthDerived) return getAddress(u8aToHex(bytes.slice(0, 20)));
  const h = keccak256(bytes);
  return getAddress(`0x${h.slice(2 + 24)}`);
}

export function h160ToFallbackAccountId(h160: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(h160)) throw new PfError('VALIDATION_FAILED', 'expected 20-byte hex address');
  return `0x${h160.slice(2).toLowerCase()}${'ee'.repeat(12)}` as Hex;
}

export const toSs58 = (accountId: string | Uint8Array, ss58Format: number) =>
  encodeAddress(typeof accountId === 'string' ? hexToU8a(accountId) : accountId, ss58Format);

export const ss58ToAccountId = (ss58: string): Hex => {
  try { return u8aToHex(decodeAddress(ss58)) as Hex; } catch { throw new PfError('VALIDATION_FAILED', 'invalid SS58 address'); }
};

export const isSs58 = (s: string) => { try { decodeAddress(s); return !s.startsWith('0x'); } catch { return false; } };
