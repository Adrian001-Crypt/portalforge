import { describe, it, expect } from 'vitest';
import { withOrdinals } from '../src/correlation';

describe('EVM/native correlation keys', () => {
  it('pairs identical logs in one block 1:1 by emission order', () => {
    const l = { blockNumber: 5, address: '0xAB', topics: ['0x01'], data: '0x' };
    const [a, b] = withOrdinals([l, l]);
    expect(a.correlationKey).not.toBe(b.correlationKey);
    const [c] = withOrdinals([{ ...l, address: '0xab' }]);
    expect(c.correlationKey).toBe(a.correlationKey); // case-insensitive address
  });
});
