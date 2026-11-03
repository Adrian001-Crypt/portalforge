import { describe, it, expect } from 'vitest';
import { Db, seedNetworks } from '../src';
import { LOCAL_ANVIL, PORTALDOT_V3_TESTNET } from '@portalforge/domain';

describe('seedNetworks', () => {
  it('is idempotent and follows an endpoint URL override', () => {
    const db = new Db(':memory:').migrate();
    seedNetworks(db, [LOCAL_ANVIL, PORTALDOT_V3_TESTNET]);
    seedNetworks(db, [LOCAL_ANVIL, PORTALDOT_V3_TESTNET]);
    seedNetworks(db, [{ ...LOCAL_ANVIL, evm: { ...LOCAL_ANVIL.evm, rpcUrl: 'http://127.0.0.1:8557' } }]);
    expect(db.get(`SELECT url FROM rpc_endpoints WHERE id = 'rpc_local-anvil_evm'`).url).toBe('http://127.0.0.1:8557');
    expect(db.get('SELECT COUNT(*) n FROM rpc_endpoints').n).toBe(3);
  });
});
