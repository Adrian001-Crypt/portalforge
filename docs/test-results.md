# Test results

**Round 3: 2026-11-04 (about 20:15–22:00 UTC).** Every row below was run in this round on the code at or just before the commit that records it.
Environment: macOS 26 (darwin arm64), Node 26.13.0, npm 11.20, Foundry 1.8.7 (solc 0.8.28, evm cancun), SQLite 3.54 (`node:sqlite`), Google Chrome via Playwright 1.56.1.

| Suite | Command | Result | Runs against |
|---|---|---|---|
| Type check (all TS) | `npm run typecheck` (+ `tsc -p apps/web`) | pass | n/a |
| Contracts | `npm run contracts:test` | **22 passed**, 0 failed (incl. 256-run fuzz) | Foundry EVM |
| Unit + integration | `npx vitest run` | **66 passed**, 0 failed, 10 files | temp SQLite, real HTTP demo service, **real Anvil** for chain tests |
| Production web build | `npm run web:build` | pass | Vite |
| **Fresh clone from the public URL** | anonymous `git clone` → `npm ci` → `npm run contracts:build` → `npm run verify` | pass at `133fd5e`: 22 + 66 tests, build OK, no diff in generated files; 26 commits, all under the account's noreply identity | public GitHub repo |
| Multi-process local E2E | `npx tsx scripts/e2e-local.ts` | **7/7 scenarios**: `docs/test-results/e2e-local-latest.json` | real processes, real Anvil, TCP fault proxy |
| Deploy recovery and budget | `npx tsx scripts/test-deploy-resume.ts` | **11/11**: `docs/test-results/deploy-resume-latest.json` | throwaway Anvil; live testnet only for the balance refusal |
| Browser | `npx playwright test` (starts the stack itself) | **8 passed**: `docs/test-results/browser-latest.json` | system Chrome; injected wallet that really signs, **not MetaMask** |
| Webhook delivery | `npx tsx scripts/test-webhooks.ts` | **14/14**: `docs/test-results/webhooks-latest.json` | real worker processes, real local HTTP receiver |
| Live read-only stack | `npx tsx scripts/public-demo.ts` + `scripts/check-public.ts` | **17/17**: `docs/test-results/public-check-latest.json` | anonymous HTTP client |
| Public site | `npx tsx scripts/check-static-demo.ts <url>` | **30/30** on the live URL https://adrian001-crypt.github.io/portalforge/: `docs/test-results/public-site-latest.json` | anonymous Chrome, desktop and phone width |
| Testnet smoke (read-only) | `PF_DRYRUN_ORIGIN=<any public funded H160> npm run smoke:testnet` | **8 passed, 0 failed, 2 not applicable** (deployer unfunded; no manifest yet): `docs/test-results/smoke-testnet-latest.json` | **live Portaldot V3** |
| Deposits and budget | `deploy.ts plan portaldot-v3-testnet --fund-executor 35 --jobs 3`, `measure-call-deposits.ts` | 161.04 + 176.09 tPOT, max fee 367.23, 3.8415 per slot, existential deposit 0.1 | **live V3** (dry-run only) |
| Video | `scripts/media/record-demo.ts` + `build-video.sh` | 2:18 MP4, H.264 1280×720 + AAC; frames inspected | local stack |
| Deck PDF | `scripts/media/build-deck-pdf.ts` | 10 pages | Chrome print |

Without `PF_DRYRUN_ORIGIN` the smoke's `deploy.deposit` check reports not applicable, because the dry-run needs a funded origin. That is 7 passed, 3 not applicable; the run recorded here sets it.

## Defects found and fixed this round (each with a check)

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

- **No PortalForge contract is deployed on Portaldot testnet** (no tokens yet). Nothing in this file is testnet *deployment* evidence; local Anvil is plain EVM.
- **No real MetaMask or other extension wallet was tested.** The browser tests inject a provider that signs with a test key. On V3, wallet gas estimation may behave differently because the deposit is folded into gas.
- Per-call gas of 0.1 tPOT is an estimate until the first real receipt. Deposits are measured.
- Webhook requests are not signed. Delivery is at-least-once.
- The static demo is a snapshot: its V3 samples are from the capture time, and its Verify buttons do nothing.
- Dropped-broadcast handling in the deploy journal is code-reviewed, not exercised.
- No load/performance testing; no latency targets are claimed (the V3 latency shown in the console is what this host measured).
- WASM/ink! paths not implemented. Linux not verified this round.
