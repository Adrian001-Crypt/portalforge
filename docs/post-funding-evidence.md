# Post-funding evidence checklist

Everything still to record once testnet tPOT arrives. Nothing here exists yet: **no PortalForge contract is deployed on Portaldot V3**. Steps and success criteria are in [funding-handoff.md](funding-handoff.md). Record real values only, copied from command output.

Each value goes into the places listed under "Update these files".

## Contracts

| Item | Value | Produced by |
|---|---|---|
| JobRegistry address | not deployed | `npm run deploy:apply …`, also in `deployments/portaldot-v3-testnet.json` |
| JobRegistry deploy tx, block | not deployed | same |
| EvidenceRegistry address | not deployed | same |
| EvidenceRegistry deploy tx, block | not deployed | same |
| Executor funding tx | not sent | `funded executor …` line of `deploy:apply` |
| Manifest verification | not run | `npm run -s pf -- deployment verify deployments/portaldot-v3-testnet.json --executor 0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25` prints `VERIFIED`, n/n checks |
| Actual deploy fees | not measured | `deploy:apply` prints `gasUsed` and `fee` per contract |

## Jobs

| Item | Job 1 (input 12, normal) | Job 2 (input 9, dropped response) | Job 3 (input 21, reserve) |
|---|---|---|---|
| `requestJob` tx, block | not run | not run | only if a take failed |
| Execution id | not run | not run | |
| `completeJob` tx, block | not run | not run | |
| `register` tx, block | not run | not run | |
| Evidence id | not run | not run | |
| `pf evidence verify` result | not run | not run | |
| Actual fee of each call | not measured | not measured | |

The first real receipts replace the estimated 0.1 tPOT gas per call in `docs/funding-handoff.md` and `PORTALDOT_DEMO_COSTS` in `packages/sdk/src/budget.ts`.

## Checks to rerun on V3

| Check | Command | Must show |
|---|---|---|
| Live smoke | `npm run smoke:testnet` | `deployment.verify` passes instead of "not applicable" |
| Fallback balance | First `deploy plan` after funding | The EVM view shows the transfer × 10⁴, which is still unconfirmed in `docs/network-capabilities.md` §4 |
| Public demo on testnet data | `PF_PUBLIC_NETWORK=testnet npx tsx scripts/public-demo.ts` | Project badge **Portaldot V3 Testnet**, 2 contracts |

## Video shots

The current video is local Anvil footage and says so. Record these on V3, then replace the 0:40–1:04 scene or add them while keeping the total under 3:00. Details are in [demo-script.md](demo-script.md).

| # | Shot | Length |
|---|---|---|
| 1 | Terminal: `deploy plan` with the real balance, exact deposits, positive margin, no BLOCKER | 8 s |
| 2 | Terminal: `deploy:apply` with real tx hashes and blocks (speed up the wait) | 10 s |
| 3 | Console with badge **Portaldot V3 Testnet**, Deployments → verification checks | 8 s |
| 4 | Job 1: `request-job.ts`, then the trace with real `completeJob` and `register` hashes | 15 s |
| 5 | Job 2: attempt 1 `unknown`, attempt 2 reconciled, one `completeJob` | 10 s |
| 6 | Terminal: `pf evidence verify` prints VERIFIED on V3 | 6 s |

## Update these files

| File | What changes |
|---|---|
| `README.md` | Status line at the top; add contract addresses |
| `docs/index.html` | Status box and the "Not done yet" row of the verified table |
| `docs/submission-draft.md` | Testnet deployment row, "How Portaldot is used", "Known limitations" |
| `docs/pitch/slides/proof.html` | Replace the pending line with addresses and tx hashes, then `npx tsx scripts/media/build-deck-pdf.ts` |
| `docs/pitch/slides/limits.html` | Remove testnet evidence from "Next" |
| `docs/verification-matrix.md` | The three **Pending** rows |
| `docs/test-results.md`, `docs/network-capabilities.md` | V3 results and the confirmed balance view |
| `docs/final-delivery.md`, `docs/submission-checklist.md` | Status |
| `docs/demo/` | Rebuild from testnet data if the public demo should show it: `npx tsx scripts/media/capture-snapshot.ts` (set `PF_PUBLIC_NETWORK=testnet`) |
