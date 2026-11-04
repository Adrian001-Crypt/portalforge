# Funding handoff: budget, what was spent, how to repeat it

**Done on 2026-11-04.** The organizers provided 500 tPOT. 470 went to the deployer and the deployment and two jobs ran on V3. Hashes and blocks are in [testnet-evidence/README.md](testnet-evidence/README.md). The tables below keep the plan next to what really happened, for anyone repeating this.

## Spent

| Item | Budget, worst case (tPOT) | Actual (tPOT) |
|---|---|---|
| Deploy JobRegistry + EvidenceRegistry | 367.25 | 337.61 (deposits 337.13 + gas 0.48) |
| Forward to executor | 35.10 | 35 + 0.11 fee |
| `requestJob` | 11.82 for 3 | 7.71 for 2 |
| **Deployer spent** | **414.17** (approved limit 415) | **380.44** |
| Executor: `completeJob` + `register` | 23.65 for 3 jobs | 15.46 for 2 jobs |

| Account | Received | Left |
|---|---|---|
| Receiving wallet `5GQapv3f…Uno4v` | 500 | 29.9849 |
| Deployer `5Fxg3MEs…czF1t` | 470 | 89.5629 |
| Executor `5DUz1yfS…3Xhx` | 35 from the deployer | 19.6351 |

A third job would still fit: it costs about 11.6 tPOT.

**Why the budget moved while the gas price fell.** On V3, `eth_estimateGas` returns about total fee ÷ gas price, so gas × price does not depend on the price. The plan's 2% price margin was truncated to a whole number, so the real margin varied slightly with each price, moving the estimate by a few thousandths of a tPOT. Units and decimals were correct. The margin now rounds up (commit `81b3d77`), which made the estimate 0.02 tPOT higher. Nothing was overpaid: transactions were charged at the current gas price, 22105, not the 22548 offered.

## 1. Accounts (already generated; keep them)

| Role | EVM (H160) | Native address to fund (SS58) | Verified |
|---|---|---|---|
| Deployer / contract owner | `0xAC575944f0696eF19e7f835fd28491c25e40Ca14` | `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t` | `reviveApi.accountId` = h160 ++ 0xEE×12 |
| Executor (low privilege) | `0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25` | `5DUz1yfSnCvrKi5jVreWcD3feVxmxXUk64x8ka2WaEqQ3Xhx` | same |

The keys live in `.secrets/` (mode 0600, gitignored, never printed). Do not regenerate them: that would change these addresses.

## 2. The plan as budgeted

This was written for 450 tPOT and run with 470. Funds go to the **deployer**, `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t`. The deploy step forwards the executor's share, so nothing needs to be sent to the executor by hand.

| Item | Worst case (tPOT) | Basis |
|---|---|---|
| Deploy JobRegistry + EvidenceRegistry, max fee | 367.23 | measured: gas × price with margins. Includes the exact storage deposits, 161.04 + 176.09 = 337.13 |
| Forward to executor (`--fund-executor 35`) + transfer gas | 35.10 | chosen below; transfer gas 0.1 is an estimate |
| 3 × `requestJob` from the deployer | 11.82 | 3 × (3.8415 measured slot deposit + 0.1 estimated gas) |
| **Deployer needs** | **414.15** | `demoBudget` in `packages/sdk/src/budget.ts` |
| **Margin on 450** | **35.85** | absorbs gas price movement and the gas estimates |

| Executor (receives 35) | tPOT | Basis |
|---|---|---|
| 3 × (`completeJob` + `register`) | 23.65 | 6 × (3.8415 + 0.1) |
| Left after the last job | 11.35 | must stay above the next write's estimated fee, which the worker checks before signing |

The deposit folded into the estimate means one write can show about 4–5 tPOT before it runs, while the unused part is refunded. The allowlist ceiling for these two functions on testnet is 8 tPOT per call.

Facts behind the numbers:
- One new storage slot costs **3.8415 tPOT**, measured twice by dry-run. Each demo call creates exactly one: `contracts/evm/test/StorageSlots.t.sol` counts zero-to-nonzero writes.
- Real gas per call was 0.015 to 0.025 tPOT, less than the 0.1 estimated. `PORTALDOT_DEMO_COSTS` now uses 0.03, and 0.12 for a transfer that creates an account.
- The existential deposit is 0.1 tPOT, measured. Both accounts stay above it.
- Storage deposits are held, not burned. PortalForge contracts never clear storage, so treat them as spent.
- The `full` profile needs about 554 tPOT in max fees and does not fit. Execution outcomes stay anchored through EvidenceRegistry.

**The three jobs:**

| Job | Input | Purpose |
|---|---|---|
| 1 | 12 | Normal run for evidence and the video |
| 2 | 9 | Same flow with a dropped service response, to show recovery on V3. The fault is off-chain, so it costs the same as a normal job |
| 3 | 21 | Reserve for a failed take. Skip it if jobs 1 and 2 are good |

**If a different amount arrives:** the commands refuse to broadcast if the balance does not cover the plan. Use the first row your balance reaches.

| Deployer balance | Profile | Flags | Result |
|---|---|---|---|
| ≥ 414.2 | `minimal` | `--fund-executor 35 --jobs 3` | The plan above |
| ≥ 400.3 | `minimal` | `--fund-executor 25 --jobs 2` | Normal + recovery |
| ≥ 386.3 | `minimal` | `--fund-executor 15 --jobs 1` | One job, no recovery take |
| ≥ 194.5 | `jobs` | `--fund-executor 15 --jobs 1` | No EvidenceRegistry, so evidence stays local and is labelled that way |
| < 194.5 | none | | Not enough to deploy. Ask for more |

## 3. Safety behaviour already verified

`npx tsx scripts/test-deploy-resume.ts` passed 11/11 on Anvil, with the live testnet used only for a read-only refusal: it sets a budget limit of 0, so it cannot broadcast. Results are in `docs/test-results/deploy-resume-latest.json`. Anvil is plain EVM, so none of this is testnet deployment evidence.

- **Not enough balance, or over the `--max-budget` limit: stop.** `deploy:apply … --confirm` exits 1 with a `BLOCKER` and broadcasts nothing. On the real deploy this stopped the first run at 414.1532 against a limit of 414.15, until the limit was raised with approval.
- **Balance covers the deploy but not the extras.** Refused before the first contract is sent.
- **Crash with part of the balance spent.** The re-run counts only what is left to send, so a tight balance does not block the resume.
- **Crash after the intent was saved, before broadcast.** The re-run sends the transaction exactly once.
- **Crash after broadcast, receipt unseen.** The re-run finds the receipt and does not resend (deployer nonce = number of contracts).
- **Re-run on a complete manifest.** Nothing is sent and nothing blocks.
- **Dropped broadcast** (not mined, not in the pool, nonce unused). The journal marks it dropped and the next run resends. This is code-reviewed only, because it can't be forced on Anvil.
- **Worker executor.** It checks the network, simulates, estimates the fee and checks the balance before every write. Balance below the fee means a retryable failure, never a broadcast (`chain.test.ts`).

## 4. When the tokens arrive: exact steps and success criteria

Tell me the transfer is done. I'll check the balance **once**; there is no polling. Then:

| # | Command | Success criterion |
|---|---|---|
| 1 | `npm run -s pf -- deploy plan --profile minimal --fund-executor 35 --jobs 3` | Deployer balance ≥ 414.2 tPOT; both simulations say `runtime matches artifact`; both deposits are exact (≈161.04 / 176.09); budget margin is positive; **no BLOCKER** |
| 2 | `npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 35 --jobs 3` | Exit 0. Two `sent 0x…` lines then two confirmed lines with block numbers. The predicted address matches (`✓`). `funded executor …` shows success |
| 3 | `npm run deploy:verify -- portaldot-v3-testnet` | Every check `pass`: chainId, genesis, code hash = artifact, receipt status/address/block, canonical block, `owner()`, `executor()`, `isWriter(executor)`, `VERSION()`, start block |
| 4 | `npm run -s pf -- deployment verify deployments/portaldot-v3-testnet.json --executor 0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25` | `VERIFIED`, independent of the API |
| 5 | `PF_MODE=testnet PF_DATA_DIR=data/testnet npm run dev` | Console shows the project “PortalForge Demo (Portaldot V3 testnet)” with 2 contracts and the badge **Portaldot V3 Testnet**. Integration Health shows the worker with executor `portaldot-v3-testnet` |
| 6 | `npx tsx scripts/request-job.ts portaldot-v3-testnet 12 --confirm` | `status: success`, a `jobId`, a tx hash |
| 7 | Watch Executions (about 1–2 min: GRANDPA `safe` lag plus the poll interval) | Execution `succeeded`. Steps guard → compute → check → complete (tx hash) → proof (registered, tx hash) |
| 8 | `npm run -s pf -- execution inspect <id> --api http://127.0.0.1:4300` and `npm run -s pf -- evidence verify <evidenceId> --api http://127.0.0.1:4300` | Execution `succeeded`; evidence `VERIFIED` (commitment matches, writer = executor, canonical block) |
| 9 (optional, not run on V3) | `curl -X POST http://127.0.0.1:4310/admin/faults -H 'x-admin-token: local-demo-admin-token' -d '{"dropNextResponse":1}'`, then `npx tsx scripts/request-job.ts portaldot-v3-testnet 9 --confirm` | Execution `succeeded`; the compute step shows attempt 1 `unknown` and attempt 2 reconciled by query; `completeJob` has one tx hash |
| 10 | `npm run smoke:testnet` | `deployment.verify` now **passes** (no longer "not applicable") |
| 11 | `npx tsx scripts/collect-testnet-evidence.ts` with the stack running | All cross-checks pass; writes `docs/testnet-evidence/` |

If step 1 shows a BLOCKER, stop and send more tPOT. Nothing is broadcast until the plan is clean.
If step 2 exits 4 (receipt not seen yet), wait a minute and re-run the same command. It resumes from the journal.
