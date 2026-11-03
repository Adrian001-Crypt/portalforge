/** Generate dedicated deployer + executor identities for a network. Prints addresses only. */
import { BUILTIN_NETWORKS } from '@portalforge/domain';
import { generateAccount, fundingAddressFor } from './lib/keys';

const id = process.argv[2] ?? 'portaldot-v3-testnet';
const profile = BUILTIN_NETWORKS[id];
if (!profile || profile.kind === 'local-dev') { console.error(`keygen is for remote networks; got ${id}`); process.exit(2); }
for (const role of ['deployer', 'executor'] as const) {
  const { address, created } = generateAccount(id, role);
  console.log(`${role.padEnd(9)} ${address}  ${created ? '(new)' : '(existing)'}`);
  console.log(`          fund via native SS58 (fallback account): ${fundingAddressFor(address, profile.native?.ss58Format ?? 42)}`);
}
console.log('\nPrivate keys are in .secrets/ (gitignored, mode 600). They are never printed or committed.');
