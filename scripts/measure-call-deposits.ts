/**
 * Read-only: measure the storage deposit of one new 32-byte storage slot on Portaldot V3 by dry-running
 * three minimal constructors (0, 1 and 2 SSTOREs into fresh slots) through reviveApi.instantiate.
 * Each PortalForge demo call creates exactly one new slot (requestJob: _job[id]; completeJob:
 * executionOf[id]; register: commitmentOf[id]), so this is their deposit. Nothing is signed.
 * Usage: PF_DRYRUN_ORIGIN=<public funded H160> npx tsx scripts/measure-call-deposits.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Hex } from 'viem';
import { PORTALDOT_V3_TESTNET as P } from '@portalforge/domain';
import { NativeReader } from '@portalforge/portaldot-native';
import { dryRunDeposit } from '@portalforge/sdk';

// init code: [SSTORE(k, 1) for k in slots] then return a 1-byte runtime (STOP).
const init = (slots: number[]) => {
  let code = '';
  for (const k of slots) code += `6001${'60' + k.toString(16).padStart(2, '0')}55`; // PUSH1 1, PUSH1 k, SSTORE
  return `0x${code}600160005360016000f3` as Hex; // MSTORE8(0,0x01)? -> return 1 byte of memory
};
const origin = process.env.PF_DRYRUN_ORIGIN as Hex | undefined;
if (!origin) { console.error('set PF_DRYRUN_ORIGIN to any public, funded H160 (simulation origin only)'); process.exit(2); }
const n = await NativeReader.connect(P.native!.wsUrl);
const out: Record<string, string> = {};
for (const [name, slots] of [['zero', []], ['one', [1]], ['two', [1, 2]]] as const) {
  const r = await dryRunDeposit(n, origin, init([...slots]));
  if (!r.ok) { console.error(name, r.error); process.exit(1); }
  out[name] = r.storageDeposit!.toString();
}
await n.disconnect();
const perSlot = BigInt(out.one) - BigInt(out.zero);
const check = BigInt(out.two) - BigInt(out.one);
const fmt = (v: bigint) => `${Number(v) / 1e14} tPOT`;
console.log(`base (no storage): ${fmt(BigInt(out.zero))}\none new slot: +${fmt(perSlot)}\nsecond new slot: +${fmt(check)}`);
mkdirSync('docs/probe', { recursive: true });
writeFileSync('docs/probe/slot-deposit-latest.json', JSON.stringify({ measuredAt: new Date().toISOString(), network: P.id, method: 'reviveApi.instantiate dry-run, origin used only for simulation', origin, depositsPlanck: out, perNewSlotPlanck: perSlot.toString(), perNewSlotTpot: Number(perSlot) / 1e14 }, null, 2) + '\n');
