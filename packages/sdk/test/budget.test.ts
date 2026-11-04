import { describe, it, expect } from 'vitest';
import { parseEther as e } from 'viem';
import { demoBudget } from '../src/budget';
import { withMargin } from '../src/deploy';

const deployFee = e('367.22');
describe('demoBudget', () => {
  it('450 tPOT covers the minimal deploy, a 35 tPOT executor and 3 jobs with margin', () => {
    const b = demoBudget({ deployFee, fundExecutor: e('35'), executorBalance: 0n, jobs: 3, deployerBalance: e('450') });
    expect(b.blockers).toEqual([]);
    expect(b.requestJobs).toBe(e('11.6145'));
    expect(b.required).toBe(e('413.9545'));
    expect(b.margin).toBe(e('36.0455'));
    expect(b.executorNeeds).toBe(e('28.229'));
  });
  it('refuses when the deployer cannot cover the extras, before anything is sent', () => {
    const b = demoBudget({ deployFee, fundExecutor: e('35'), executorBalance: 0n, jobs: 3, deployerBalance: e('400') });
    expect(b.blockers[0]).toMatch(/deployer balance/);
  });
  it('refuses an executor budget too small for the jobs', () => {
    const b = demoBudget({ deployFee, fundExecutor: e('20'), executorBalance: 0n, jobs: 3, deployerBalance: e('450') });
    expect(b.blockers[0]).toMatch(/executor would hold/);
  });
  it('counts only what is left: a resume after one contract, an executor already funded', () => {
    const b = demoBudget({ deployFee: 0n, fundExecutor: e('35'), executorBalance: e('35'), jobs: 0, deployerBalance: e('60') });
    expect(b.executorTopUp).toBe(0n); expect(b.transferFee).toBe(0n); expect(b.required).toBe(0n); expect(b.blockers).toEqual([]);
  });
});

describe('withMargin', () => {
  it('never falls short of the percentage', () => {
    for (const p of [22105n, 22115n, 22120n, 22125n]) expect(withMargin(p, 200n) * 100n >= p * 102n).toBe(true);
    expect(withMargin(22105n, 200n)).toBe(22548n);
    expect(withMargin(10000n, 200n)).toBe(10200n);
  });
});
