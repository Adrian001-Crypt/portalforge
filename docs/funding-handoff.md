# Funding handoff — what happens when testnet tPOT arrives

Prepared on 2026-11-03 without spending anything. Every number below was measured read-only on the live Portaldot V3 testnet (spec 3002, chainId 420420777, tPOT with 14 decimals, SS58 prefix 42). The re-probe is in `docs/probe/portaldot-v3-testnet-latest.json`.

## 1. Accounts (already generated; keep them)

| Role | EVM (H160) | Native address to fund (SS58) | Verified |
|---|---|---|---|
| Deployer / contract owner | `0xAC575944f0696eF19e7f835fd28491c25e40Ca14` | `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t` | `reviveApi.accountId` = h160 ++ 0xEE×12 |
| Executor (low privilege) | `0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25` | `5DUz1yfSnCvrKi5jVreWcD3feVxmxXUk64x8ka2WaEqQ3Xhx` | same |

The keys live in `.secrets/` (mode 0600, gitignored, never printed). Do not regenerate them: that would change these addresses.

## 2. Budget (measured)

| Item | Amount | Source |
|---|---|---|
| Deploy storage deposit, JobRegistry | 161.04 tPOT | `reviveApi.instantiate` dry-run |
| Deploy storage deposit, EvidenceRegistry | 176.09 tPOT | same |
| Max-fee headroom the balance must cover during deploy | +30.09 tPOT (sum of max fees 367.22 tPOT) | `eth_estimateGas` × gasPrice, +5% gas / +2% price margin |
| One new storage slot (each demo call creates exactly one) | **3.8415 tPOT** | `scripts/measure-call-deposits.ts` → `docs/probe/slot-deposit-latest.json` |
| Per demo job: `requestJob` (deployer) | ≈ 3.84 + gas | 1 slot |
| Per demo job: `completeJob` + `register` (executor) | ≈ 7.68 + gas | 2 slots |
| Gas per call (excluding deposit) | ≈ 0.1 tPOT, estimated from observed V3 receipts of other contracts | estimate, confirm from our first receipt |

The old plan, "≈380 tPOT to the deployer and 25 tPOT to the executor", covers the deploy but only about 3 executor jobs, with almost no headroom for `requestJob`. Use this instead:

| Plan | Deployer receives | of which forwarded to executor | Supports |
|---|---|---|---|
| **Recommended**: `minimal` profile, 5 jobs, on-chain evidence | **≈ 500 tPOT** | 60 tPOT (`--fund-executor 60`) | deploy 367.2 (max) + 5 × requestJob ≈ 20 + executor 60 + ≈ 50 margin |
| Tight: `minimal`, 2 jobs | ≈ 430 tPOT | 25 tPOT | deploy + 2 × requestJob + 2 jobs × 7.7 + small margin |
| Minimum: `jobs` profile (no EvidenceRegistry; evidence stays local, labelled) | ≈ 215 tPOT | 15 tPOT | JobRegistry 175.4 (max) + 3 × requestJob + 3 × completeJob |

Storage deposits are **held, not burned**. pallet-revive refunds them when the storage is cleared. PortalForge contracts never clear storage, so treat them as spent for planning.

## 3. Safety behaviour already verified

`npx tsx scripts/test-deploy-resume.ts` passed 6/6. Results are in `docs/test-results/deploy-resume-latest.json`.

- **Not enough balance → stop.** With the live testnet deployer at 0 tPOT, `deploy:apply … --confirm` exited 1 with `BLOCKER: deployer balance …` and broadcast nothing.
- **Crash after the intent was saved, before broadcast.** The re-run sent the transaction exactly once.
- **Crash after broadcast, receipt unseen.** The re-run found the receipt and did not resend (deployer nonce = number of contracts).
- **Re-run on a complete manifest.** Nothing was sent.
- **Dropped broadcast** (not mined, not in the pool, nonce unused). The journal marks it dropped and the next run resends. This is code-reviewed only, because it can't be forced on Anvil.
- **Worker executor.** It checks the network, simulates, estimates the fee and checks the balance before every write. Balance below the fee means a retryable failure, never a broadcast (`chain.test.ts`).

## 4. When the tokens arrive: exact steps and success criteria

Tell me the transfer is done. I'll check the balance **once**; there is no polling. Then:

| # | Command | Success criterion |
|---|---|---|
| 1 | `npm run -s pf -- deploy plan --profile minimal` | Deployer balance ≥ 367.3 tPOT; both simulations say `runtime matches artifact`; both deposits are exact (≈161.04 / 176.09); **no BLOCKER** |
| 2 | `npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 60` | Exit 0. Two `sent 0x…` lines then two confirmed lines with block numbers. The predicted address matches (`✓`). `funded executor …` shows success |
| 3 | `npm run deploy:verify -- portaldot-v3-testnet` | Every check `pass`: chainId, genesis, code hash = artifact, receipt status/address/block, canonical block, `owner()`, `executor()`, `isWriter(executor)`, `VERSION()`, start block |
| 4 | `npm run -s pf -- deployment verify deployments/portaldot-v3-testnet.json --executor 0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25` | `VERIFIED`, independent of the API |
| 5 | `PF_MODE=testnet npm run dev` | Console shows the project “PortalForge Demo (Portaldot V3 testnet)” with 2 contracts and the badge **Portaldot V3 Testnet**. Integration Health shows the worker with executor `portaldot-v3-testnet` |
| 6 | `npx tsx scripts/request-job.ts portaldot-v3-testnet 12 --confirm` | `status: success`, a `jobId`, a tx hash |
| 7 | Watch Executions (about 1–2 min: GRANDPA `safe` lag plus the poll interval) | Execution `succeeded`. Steps guard → compute → check → complete (tx hash) → proof (registered, tx hash) |
| 8 | `npm run -s pf -- execution inspect <id> --api http://127.0.0.1:4300` and `npm run -s pf -- evidence verify <evidenceId> --api http://127.0.0.1:4300` | Execution `succeeded`; evidence `VERIFIED` (commitment matches, writer = executor, canonical block) |
| 9 | `npm run smoke:testnet` | `deployment.verify` now **passes** (no longer "not applicable") |
| 10 | Record in `docs/submission-draft.md` and `docs/final-delivery.md` | Addresses, deploy tx hashes, `requestJob` / `completeJob` / `register` tx hashes, block numbers. Real values only |

If step 1 shows a BLOCKER, stop and send more tPOT. Nothing is broadcast until the plan is clean.
If step 2 exits 4 (receipt not seen yet), wait a minute and re-run the same command. It resumes from the journal.
