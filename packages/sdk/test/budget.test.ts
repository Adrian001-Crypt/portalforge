import { describe, it, expect } from 'vitest';
import { parseEther as e } from 'viem';
import { demoBudget } from '../src/budget';

const deployFee = e('367.22');
describe('demoBudget', () => {
  it('450 tPOT covers the minimal deploy, a 35 tPOT executor and 3 jobs with margin', () => {
    const b = demoBudget({ deployFee, fundExecutor: e('35'), executorBalance: 0n, jobs: 3, deployerBalance: e('450') });
    expect(b.blockers).toEqual([]);
    expect(b.requestJobs).toBe(e('11.8245'));
    expect(b.required).toBe(e('414.1445'));
    expect(b.margin).toBe(e('35.8555'));
    expect(b.executorNeeds).toBe(e('28.649'));
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
