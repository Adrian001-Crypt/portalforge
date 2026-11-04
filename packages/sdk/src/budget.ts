import { parseEther } from 'viem';

/**
 * Whether a balance covers a deploy plus a few demo jobs on Portaldot V3. All amounts are 18-decimal EVM wei.
 * Each demo call creates one new storage slot (requestJob, completeJob, register). The slot deposit is measured
 * (scripts/measure-call-deposits.ts); gas per call is an estimate to replace with the first real receipts.
 */
export interface DemoCosts { slotDeposit: bigint; callGas: bigint; transferGas: bigint; executorReserve: bigint }
export const PORTALDOT_DEMO_COSTS: DemoCosts = { slotDeposit: parseEther('3.8415'), callGas: parseEther('0.1'), transferGas: parseEther('0.1'), executorReserve: parseEther('5') };

export interface DemoBudgetInput { deployFee: bigint; fundExecutor: bigint; executorBalance: bigint; jobs: number; deployerBalance: bigint; costs?: DemoCosts }
export interface DemoBudget extends Required<Omit<DemoBudgetInput, 'costs'>> {
  executorTopUp: bigint; transferFee: bigint; requestJobs: bigint; executorNeeds: bigint; required: bigint; margin: bigint; blockers: string[];
}

export function demoBudget(i: DemoBudgetInput): DemoBudget {
  const c = i.costs ?? PORTALDOT_DEMO_COSTS;
  const perCall = c.slotDeposit + c.callGas;
  const jobs = BigInt(i.jobs);
  const executorTopUp = i.fundExecutor > i.executorBalance ? i.fundExecutor - i.executorBalance : 0n;
  const transferFee = executorTopUp > 0n ? c.transferGas : 0n;
  const requestJobs = jobs * perCall;
  const required = i.deployFee + executorTopUp + transferFee + requestJobs;
  // The worker checks the balance against the next write's estimated fee, so the executor keeps a reserve after the last job.
  const executorNeeds = i.jobs > 0 ? jobs * 2n * perCall + c.executorReserve : 0n;
  const blockers: string[] = [];
  if (i.deployerBalance < required) blockers.push(`deployer balance ${i.deployerBalance} < required ${required} (wei, 18 dp)`);
  const executorAfter = i.executorBalance + executorTopUp;
  if (executorAfter < executorNeeds) blockers.push(`executor would hold ${executorAfter} but ${i.jobs} job(s) need ${executorNeeds} (wei, 18 dp); raise --fund-executor or lower --jobs`);
  return { ...i, executorTopUp, transferFee, requestJobs, executorNeeds, required, margin: i.deployerBalance - required, blockers };
}

export function formatBudget(b: DemoBudget, fmt: (wei: bigint) => string): string[] {
  return [
    'budget (worst case, before anything is sent)',
    `  contracts still to deploy, max fee  ${fmt(b.deployFee)}`,
    `  executor top-up + transfer gas      ${fmt(b.executorTopUp + b.transferFee)}`,
    `  ${b.jobs} × requestJob                     ${fmt(b.requestJobs)}`,
    `  deployer needs                      ${fmt(b.required)}`,
    `  deployer holds                      ${fmt(b.deployerBalance)}`,
    `  margin                              ${b.margin < 0n ? `-${fmt(-b.margin)}` : fmt(b.margin)}`,
    `  executor needs for ${b.jobs} job(s)         ${fmt(b.executorNeeds)} (holds ${fmt(b.executorBalance)})`,
  ];
}
