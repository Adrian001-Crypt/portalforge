# Test results

**Round 4: 2026-11-04 (about 22:00–23:30 UTC).** The first round with PortalForge deployed on the live testnet. Every row was run in this round.
Environment: macOS 26 (darwin arm64), Node 26.13.0, npm 11.20, Foundry 1.8.7 (solc 0.8.28, evm cancun), SQLite 3.54 (`node:sqlite`), Google Chrome via Playwright 1.56.1.

## On the live Portaldot V3 testnet

| Check | Command | Result |
|---|---|---|
| Deployment | `npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 35 --jobs 3 --max-budget 415` | 2 contracts + executor funding, all **finalized**: `0xd5dcf5a7d69354b07f776f8a961348f0a394d746`, `0xf005d9e544a399196473ec167eda85c089d80cff` |
| Deployment verification | `npm run deploy:verify`, `pf deployment verify … --executor …` | **25/25** |
| Full jobs | `scripts/request-job.ts` + worker | **2 of 2 succeeded**, all 6 transactions **finalized** |
| Cross-checks: chain, indexer, worker, CLI | `npx tsx scripts/collect-testnet-evidence.ts` | **18/18** (re-run after the history rewrite) |
| Evidence, independent | `pf evidence verify` | **VERIFIED** for both jobs |
| Smoke | `PF_DRYRUN_ORIGIN=<any public funded H160> npm run smoke:testnet` | **9 passed, 0 failed, 1 not applicable** (the deployer can no longer afford a second deploy, as expected); `deployment.verify` passes |
| Console | Deployments, Event Explorer, Executions, Evidence on the testnet stack | Same addresses, hashes and states; screenshots 17–22 |

Every hash and block: [testnet-evidence/README.md](testnet-evidence/README.md).

## Local and public site

| Suite | Command | Result | Runs against |
|---|---|---|---|
| Type check (all TS) | `npm run typecheck` (+ `tsc -p apps/web`) | pass | n/a |
| Contracts | `npm run contracts:test` | **22 passed**, 0 failed (incl. 256-run fuzz) | Foundry EVM |
| Unit + integration | `npx vitest run` | **69 passed**, 0 failed, 10 files | temp SQLite, real HTTP demo service, **real Anvil** for chain tests |
| Production web build | `npm run web:build` | pass | Vite |
| **Fresh clone from the public URL** | anonymous `git clone` → `npm ci` → `npm run contracts:build` → `npm run verify` | pass at `4e29343`: 22 + 69 tests, build OK, no diff in generated files; `pf deployment verify` 25/25 from the clone; all 41 commits under the noreply identity | public GitHub repo |
| Multi-process local E2E | `npx tsx scripts/e2e-local.ts` | **7/7 scenarios** | real processes, real Anvil, TCP fault proxy |
| Deploy recovery and budget | `npx tsx scripts/test-deploy-resume.ts` | **11/11** | throwaway Anvil; live testnet only for a refusal with a budget limit of 0 |
| Browser | `npx playwright test` (starts the stack itself) | **8 passed** | system Chrome; injected wallet that really signs, **not MetaMask** |
| Webhook delivery | `npx tsx scripts/test-webhooks.ts` | **14/14** | real worker processes, real local HTTP receiver |
| Minimal-profile rehearsal | `npx tsx scripts/rehearse-minimal.ts` | one job, 3 transactions, 1 new slot each | throwaway Anvil |
| Public site | `npx tsx scripts/check-static-demo.ts <url>` | **38/38** on the live URL https://adrian001-crypt.github.io/portalforge/ , including contracts, evidence and receipts against the chain, and every public link: `docs/test-results/public-site-latest.json` | anonymous Chrome, desktop and phone width |
| Video | `record-demo.ts`, `record-testnet.ts`, `build-final-video.py` | 2:24 MP4, H.264 1280×720 + AAC; frames inspected | V3 and local footage, labelled |
| Deck PDF | `scripts/media/build-deck-pdf.ts` | 10 pages | Chrome print |

## Defects found and fixed in rounds 3 and 4 (each with a check)

| Defect | Fix | Verified by |
|---|---|---|
| **The "Use wallet" button could not be clicked at 1280 px**: the form overflowed under the plan panel | form column constrained; Workbench gets its own layout | `e2e/wallet-deploy.spec.ts` (all 5 failed before) |
| A wallet deploy whose page reloaded or whose manifest step failed left the contract on chain with no record, and no way to finish | intent records template and arguments; **Register deployment** in the list | `wallet-deploy.spec.ts` lost-hash case |
| Registering a deployment twice created duplicate records | one deployment per intent; repeats return the same record | `wallet-deploy.spec.ts` |
| Recovering a lost hash needed two Reconcile clicks, and a pending one looked like nothing happened | goes straight to the receipt; says when it is not on chain yet | `wallet-deploy.spec.ts` |
| Browser deploy manifests always said `dirty: false` | reads the contract sources' git status | manifest in `wallet-deploy.spec.ts` run |
| **A deploy resume on a limited balance was refused**: the check used the full plan total, not what was left. Also blocked re-running a finished deploy | budget counts only unsent contracts | `test-deploy-resume.ts` `budget.*` (Anvil's huge balance had hidden this) |
| `--fund-executor` beyond the balance failed only after the contracts were deployed | checked before the first send | `budget.extras_refused_before_send` |
| Testnet allowlist ceiling of 5 tPOT per call was close to the estimated fee of a write that creates a slot | raised to 8 tPOT | reasoned from measured deposits; confirm on the first real write |
| **Failed webhooks were never retried**, and a crash between raising and sending lost the notification | outbox in the same transaction, leases, backoff | `test-webhooks.ts` |
| Incidents re-opened by workflow signals never notified; the code could also pick the wrong "latest" incident | delivery queued by `raiseIncident` itself | `duplicate.reopen_is_new` |
| A channel filtered to `critical` never heard about an incident that escalated while open | delivery on escalation, once per channel | `filter.severity_and_escalation` |
| Two channels on one connector sent duplicates | one channel per connector | migration 4 |
| Test evidence under `docs/test-results/` was never in the public repo, because of an ignore rule; docs linked to it | rule limited to the root folder | anonymous clone |
| The browser test report contained local machine paths | summary reporter writes titles and outcomes only | `browser-latest.json` |
| **Seen only on V3:** the receipt index lags behind the account nonce. In job 1 the worker read that as a replaced transaction, skipped the finality wait and left the intent open. The result was correct | waits up to 2 minutes for the index before deciding; closes the intent | `chain.test.ts` with simulated lag; **job 2 on V3 took the normal path** |
| Deployment page said "Not verified yet" for a verified deployment, because the seed dropped the report | seed keeps the report; re-verify also checks the executor | screenshot 18 |
| Budget estimate drifted by thousandths of a tPOT as the gas price moved, from a truncated margin | margin rounds up; `--max-budget` stops a deploy over its limit | `budget.test.ts`; explained in `funding-handoff.md` |
| The budget test ran `apply --confirm` on the live network and relied on an empty account to refuse | it now sets a budget of 0, so it cannot broadcast | `testnet.over_budget_refuses` |
| Re-collecting evidence later failed 2 of 18: `reviveApi.ethBlockHash` answers only the last 255 blocks | old blocks are checked through the EVM view; recorded in `network-capabilities.md` | 18/18 again |
| The live testnet stack, started on a fresh database, could have re-run past jobs and spent tokens | public testnet stack runs no worker and holds no key; the snapshot reads the stack that ran the jobs | code review |

## What the recovery tests prove

| Claim | Test | Kind |
|---|---|---|
| Lost response after remote success → query → processed once | `engine.test.ts`; E2E B | real HTTP receiver |
| No blind resend when the receiver cannot be queried | `engine.test.ts` | real HTTP receiver |
| Worker death → lease expiry → another worker finishes | `engine.test.ts`; **E2E C (SIGKILL mid-request)** | real processes |
| Two workers, one DB file → each execution exactly once | `engine.test.ts` | two connections |
| Crash after signing/persisting, before broadcast → same tx hash | `chain.test.ts` | real Anvil |
| Broadcast happened, response lost → receipt found, no resend | `chain.test.ts` | real Anvil |
| Replay cannot complete a job twice | `chain.test.ts`; E2E E | real Anvil |
| RPC outage → cursor holds, incident opens/auto-resolves, catch-up | E2E D | TCP proxy outage |
| Deploy crash after intent / after send → resume without duplicate create | `test-deploy-resume.ts` | throwaway Anvil |
| Insufficient balance → no broadcast | `test-deploy-resume.ts` | **live testnet** (read-only) |
| Part-spent balance → resume only what is left | `test-deploy-resume.ts` `budget.*` | throwaway Anvil |
| Browser deploy: rejection, wrong chain, no funds, lost hash | `e2e/wallet-deploy.spec.ts` | real Chrome, signing test wallet |
| Webhook: retries, duplicates, lost response, worker SIGKILL | `test-webhooks.ts` | real workers, real HTTP receiver |
| Reorg incl. A→B→A, duplicates, restart, bad ABI, finality | `evm-indexer.test.ts` | scripted chain |
| Two browser sessions racing on one account | `e2e/two-browsers.spec.ts` | real Chrome |
| Live EVM ⇄ native correlation | smoke `index.correlation` (2 linked, 2 verified) | **live V3** |

## Not covered / not true yet

- **Fault recovery was not run on V3**, by choice, to save tokens. Lost responses, killed workers, RPC outages and replays are local results on Anvil, which is plain EVM. Job 1 did show a real V3 recovery from the lagging index, but only by accident.
- **No real MetaMask or other extension wallet was tested, on any chain.** V3 transactions were signed by the project's own keys. The browser tests inject a provider that signs with a test key. On V3, wallet gas estimation may behave differently because the deposit is folded into gas.
- The browser-wallet deploy and webhook delivery have not run on V3.
- The demo service called on V3 runs on the operator's machine. It is a real HTTP service, not hosted.
- Webhook requests are not signed. Delivery is at-least-once.
- History was rewritten once more on 2026-11-05 to remove private search terms from two test scripts. Commit hashes from that point changed; contract sources, dates and messages did not. The old commit may stay reachable on GitHub by direct hash for a while.
- After a restart an hour later, the indexer reported a reorg at #326635 among blocks that were not final when it stopped, with 0 events orphaned. All job events stayed finalized; whether a real fork occurred was not investigated further.
- The public site's first deploy of this round stalled on GitHub's side (one run timed out after 10 minutes and its retry stayed queued). A new commit deployed normally about an hour later.
- The static demo is a snapshot: its V3 samples are from the capture time, and its Verify buttons do nothing.
- Dropped-broadcast handling in the deploy journal is code-reviewed, not exercised.
- No load/performance testing; no latency targets are claimed.
- WASM/ink! paths not implemented. Linux not verified this round.
