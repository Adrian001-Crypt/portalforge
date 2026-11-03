# Test results

**Round 2 — 2026-11-03 (UTC ≈ 19:30–20:30).** Every row below was run in this round on the code at or just before the commit that records it.
Environment: macOS 26 (darwin arm64), Node 26.13.0, npm 11.20, Foundry 1.8.7 (solc 0.8.28, evm cancun), SQLite 3.54 (`node:sqlite`), Google Chrome 156 via Playwright 1.56.1.

| Suite | Command | Result | Runs against |
|---|---|---|---|
| Type check (all TS) | `npm run typecheck` (+ `tsc -p apps/web`) | pass | — |
| Contracts | `npm run contracts:test` | **21 passed**, 0 failed (incl. 256-run fuzz) | Foundry EVM |
| Unit + integration | `npx vitest run` | **59 passed**, 0 failed, 9 files | temp SQLite, real HTTP demo service, **real Anvil** for chain tests |
| Production web build | `npm run web:build` | pass (306 KB JS) | Vite |
| **Fresh clone** | `git clone` → `npm ci` → `npm run contracts:build` → `npm run verify` → `npm run dev` | pass: 21 + 58 tests (before the last store test was added), build OK, no diff in generated files, console HTTP 200, demo project seeded with 3 contracts | clean checkout |
| Multi-process local E2E | `npx tsx scripts/e2e-local.ts` | **7/7 scenarios** — `docs/test-results/e2e-local-latest.json` | real processes, real Anvil, TCP fault proxy |
| Deploy journal recovery | `npx tsx scripts/test-deploy-resume.ts` | **7/7** — `docs/test-results/deploy-resume-latest.json` | throwaway Anvil; live testnet only for the balance refusal |
| Browser (two sessions) | `npx playwright test` (with `npm run dev`) | **3 passed** — `docs/test-results/browser-latest.json` | system Chrome, isolated contexts |
| Public read-only deployment | `npx tsx scripts/public-demo.ts` + `npx tsx scripts/check-public.ts http://127.0.0.1:4400` | **17/17** — `docs/test-results/public-check-latest.json` | anonymous HTTP client |
| Testnet smoke (read-only) | `npm run smoke:testnet` | **8 passed, 0 failed, 2 not applicable** (deployer unfunded; no manifest yet) — `docs/test-results/smoke-testnet-latest.json` | **live Portaldot V3** |
| Per-slot deposit measurement | `scripts/measure-call-deposits.ts` | 3.8415 tPOT per new slot — `docs/probe/slot-deposit-latest.json` | **live V3** (dry-run only) |
| Capability re-probe | `scripts/probe-network.ts` | identity, 14 dp, ss58 42, mapping and correlation unchanged — `docs/probe/portaldot-v3-testnet-latest.json` | **live V3** |
| Video | `scripts/media/record-demo.ts` + `build-video.sh` | 2:08 MP4, H.264 1280×720 + AAC, both tracks verified with AVFoundation; frames inspected | local stack |
| Deck PDF | `scripts/media/build-deck-pdf.ts` | 10 pages; pages rasterised and inspected | Chrome print |

## Defects found and fixed this round (each with a check)

| Defect | Fix | Verified by |
|---|---|---|
| `unknown_outcome` incident stayed open after the execution reconciled and succeeded | auto-resolve on success | `ops.test.ts` new case |
| `npm run dev` kept the old DB/manifest while Anvil restarts empty → deploy skipped every contract | dev resets local state; deploy trusts a manifest only if the code exists on the current chain | `test-deploy-resume.ts` `stale_manifest.redeploys`; fresh-clone boot |
| Dropped deploy broadcast left the journal stuck in `sent` | detect not-mined / not-in-pool / nonce-unused → mark dropped, resend next run | code review (cannot force on Anvil) |
| Public visitors could read connector targets (internal URLs), channels, and host names; anonymous reconcile triggered block scans | hidden / refused / masked; tighter anonymous write limit | `api.test.ts` public case; `check-public.ts` 17/17 |
| Worker/indexer ids contained the machine's host name (visible in traces and video) | random instance ids | re-recorded video, screenshot inspection |
| `pf doctor` reported a false `.gitignore` failure (`git check-ignore -q` takes one path) | check each path | `npx pf doctor` |
| Built-in RPC endpoint seeding failed when the URL was overridden | upsert by id | `store/test/config.test.ts` |
| Public demo env line accidentally commented out (fell back to dev DB/port) | fixed | public stack restarted on its own DB/port, 17/17 |

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
| Reorg incl. A→B→A, duplicates, restart, bad ABI, finality | `evm-indexer.test.ts` | scripted chain |
| Two browser sessions racing on one account | `e2e/two-browsers.spec.ts` | real Chrome |
| Live EVM ⇄ native correlation | smoke `index.correlation` (2 linked, 2 verified) | **live V3** |

## Not covered / not true yet

- **No PortalForge contract is deployed on Portaldot testnet** (deployer unfunded). Nothing in this file is testnet *deployment* evidence; local Anvil is plain EVM.
- The public demo was verified on `127.0.0.1` only. An external HTTPS tunnel was not started from this session (blocked by the session's permission policy); `--tunnel` must be run by you.
- Dropped-broadcast handling in the deploy journal is code-reviewed, not exercised.
- No load/performance testing; no latency targets are claimed (the V3 latency shown in the console is what this host measured).
- WASM/ink! paths not implemented. Linux not verified this round.
