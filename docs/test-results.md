# Test results

Environment: macOS (darwin arm64), Node 26.13.0, Foundry 1.8.7 (solc 0.8.28), SQLite 3.54 (node:sqlite), system Google Chrome via Playwright 1.56.1. Run on 2026-11-03.

| Suite | Command | Result | Where it runs |
|---|---|---|---|
| Type check | `npm run typecheck` | pass | all TS packages/services/scripts |
| Contracts | `npm run contracts:test` | **21 passed**, 0 failed (incl. 256-run fuzz) | Foundry EVM |
| Unit + integration | `npx vitest run` | **56 passed**, 0 failed, 8 files | in-memory/temp SQLite, real HTTP demo service, **real Anvil** for chain tests |
| Web build | `npm run web:build` | pass | Vite |
| Local E2E (multi-process) | `npx tsx scripts/e2e-local.ts` | **7/7 scenarios passed** — `docs/test-results/e2e-local-latest.json` | real processes, real Anvil, TCP fault proxy |
| Browser | `npx playwright test` (stack running) | **3 passed** — `docs/test-results/browser-latest.json` | system Chrome, two isolated contexts |
| Testnet smoke (read-only) | `npm run smoke:testnet` | **8 passed, 0 failed, 2 not applicable** — `docs/test-results/smoke-testnet-latest.json` | **live Portaldot V3** |

`npm run verify` = typecheck + contracts + vitest + web build. `npm run verify:local` adds the multi-process E2E.

## What the recovery tests actually prove

| Claim | Test | Kind |
|---|---|---|
| Remote success + lost response is reconciled by query and processed once | `engine.test.ts` "remote success with a lost response…"; E2E scenario B | real HTTP receiver |
| No blind resend when the receiver cannot be queried | `engine.test.ts` "does not resend…" | real HTTP receiver |
| Worker death → lease expiry → other worker finishes | `engine.test.ts` (clock-driven); **E2E scenario C (real SIGKILL mid-request)** | real processes |
| Two workers on one DB file run each execution exactly once | `engine.test.ts` "two concurrent workers…" | two DB connections |
| Crash after signing/persisting, before broadcast → same tx hash | `chain.test.ts` | real Anvil |
| Broadcast happened but response lost → receipt found, no resend | `chain.test.ts` (nonce delta = 2) | real Anvil |
| Replay cannot complete a job twice | `chain.test.ts`; E2E scenario E | real Anvil |
| RPC outage: cursor holds, incident opens/auto-resolves, catch-up | E2E scenario D | TCP proxy outage |
| Reorg (incl. A→B→A), duplicates, overlap, restart, bad ABI, finality | `evm-indexer.test.ts` (10) | scripted chain |
| Native: runtime upgrade, reorg, finality, watch filter | `native-indexer.test.ts` | scripted source |
| Two browser sessions racing on one account | `e2e/two-browsers.spec.ts` | real Chrome |
| Live EVM ⇄ native correlation | smoke testnet `index.correlation` | **live V3** |

## Not covered / not yet true
- **No PortalForge contract is deployed on Portaldot testnet yet** (needs funded deployer — see docs/deployment.md). `deployment.verify` on testnet is "not applicable" until then. Local Anvil results are not testnet evidence.
- WASM / ink! paths: not implemented.
- No load or performance testing; no latency targets are claimed.
- The Playwright suite runs against a running dev stack (not self-starting).
