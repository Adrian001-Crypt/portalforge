# Verification matrix

Status legend: **Verified-testnet** (observed on live Portaldot V3) · **Verified-local** (real processes/Anvil) · **Unit** (automated test with scripted dependencies) · **Implemented** (code exists, manual check only) · **Pending** (blocked, reason given) · **Not done**.

| Area | Capability | Status | Evidence |
|---|---|---|---|
| Network | Identity (chainId, genesis, spec, token, ss58) | Verified-testnet | docs/probe/*.json |
| Network | Opcode compatibility up to Cancun | Verified-testnet | probe `evm.opcode.*` |
| Network | Address mapping vs reviveApi | Verified-testnet | probe `mapping.*` |
| Network | EVM block hash == reviveApi.ethBlockHash | Verified-testnet | probe `correlation.block_numbers` |
| Deploy | Artifact runtime == simulated runtime on V3 | Verified-testnet | `pf deploy plan`, smoke `deploy.simulation` |
| Deploy | Exact storage deposit dry-run | Verified-testnet | smoke `deploy.deposit` |
| Deploy | Real testnet deployment + manifest verification | Verified-testnet | `docs/testnet-evidence/README.md`, 25/25 checks |
| Deploy | Deploy journal: crash after intent / after send, idempotent rerun, stale manifest on a fresh chain | Verified-local | `scripts/test-deploy-resume.ts` (7/7) |
| Deploy | Budget: extras refused before the first send; resume on a part-spent balance | Verified-local | `test-deploy-resume.ts` `budget.*`, `sdk/test/budget.test.ts` |
| Deploy | One new storage slot per demo call | Unit (EVM) | `contracts/evm/test/StorageSlots.t.sol` |
| Deploy | Refuses to broadcast with insufficient balance | Verified-testnet (read-only) | `test-deploy-resume.ts` `testnet.insufficient_balance_refuses` |
| Deploy | Exact per-slot call deposit (3.8415 tPOT) | Verified-testnet (dry-run) | `docs/probe/slot-deposit-latest.json` |
| Deploy | Manifest verify (32 checks) | Verified-local | E2E F |
| Deploy | Browser-wallet deploy: plan, sign, verify, register; rejection, wrong chain, no funds; lost hash recovered after reload, registered once | Verified-local (Chrome, signing test wallet, not MetaMask) | `e2e/wallet-deploy.spec.ts` |
| Index | EVM logs live | Verified-testnet | smoke `index.evm` |
| Index | Native Revive events live (per-block runtime) | Verified-testnet | smoke `index.native` |
| Index | EVM⇄native correlation verified | Verified-testnet | smoke `index.correlation` |
| Index | Reorg / A→B→A / dedup / restart / bad ABI / finality / re-decode | Unit | evm-indexer.test.ts |
| Index | RPC outage handling | Verified-local | E2E D |
| Workflow | Versioning, binding, deterministic ids, routing dedup | Unit + Verified-local | engine.test.ts, E2E G |
| Workflow | Retries/backoff/jitter/dead-letter, replay from failure | Unit | engine.test.ts |
| Workflow | Approvals (approve/expire/void) | Unit | engine.test.ts |
| Workflow | Lost response reconciliation | Unit + Verified-local | engine.test.ts, E2E B |
| Workflow | Worker crash recovery | Unit + Verified-local (SIGKILL) | engine.test.ts, E2E C |
| Workflow | Schedules (worker-driven) | Unit | engine.test.ts |
| Execution | Allowlist, budget, network mismatch refusal | Verified-local (Anvil) | chain.test.ts |
| Execution | Sign → persist → broadcast; same-hash resume; lost receipt | Verified-local (Anvil) | chain.test.ts |
| Execution | On-chain write on Portaldot testnet (`completeJob`, `register`, with allowlist and finality wait) | Verified-testnet | `docs/testnet-evidence/README.md` |
| Evidence | Register + verify (local hash vs chain commitment) | Verified-local | chain.test.ts, E2E F, console |
| Evidence | Registered on V3 and verified independently with the CLI | Verified-testnet | `docs/testnet-evidence/README.md`, `05-cli-evidence-verify.log` |
| Workflow | Full job on V3: requestJob → indexed → workflow → service → completeJob → evidence | Verified-testnet (2 jobs) | `docs/testnet-evidence/README.md` |
| Execution | Receipt index lagging behind the account nonce | Verified-testnet (fix), Verified-local (simulated) | job 2 trace, `chain.test.ts` |
| Recovery | Fault recovery on V3 | Not done on V3 by choice, to save tokens; local only | E2E B to E |
| Wallet | MetaMask or other extension wallet | Not tested | test wallet only |
| Ops | Incident aggregation/cooldown/reopen, rules | Unit | ops.test.ts |
| Ops | rpc_unreachable incident open → auto-resolve | Verified-local | E2E D |
| Ops | Webhook delivery: success, retry with backoff, permanent failure, give-up + operator retry, duplicate raises, re-open, severity escalation, lost response, unsafe target, worker SIGKILL, no worker running | Verified-local (real workers, real HTTP receiver) | `scripts/test-webhooks.ts`, `ops.test.ts` |
| Ops | Optional model explanation | Implemented (returns NOT_CONFIGURED without a model) | `/incidents/:id/explain` |
| API | CSRF/Origin, isolation, roles, scopes, SSRF, limits, export secrecy | Unit (HTTP) | api.test.ts |
| Web | Console flows, two-session race, rejection, wrong network, public read-only | Verified-local (Chrome) | e2e/two-browsers.spec.ts |
| CLI | doctor, network inspect, deploy plan, deployment verify, workflow validate | Verified-testnet / local | run logs above |
| CLI | events tail, workflow simulate, execution inspect, evidence verify | Verified-local | E2E F, manual |
| WASM | ink! contracts on pallet-contracts | Not done | no Rust toolchain; registration returns NOT_SUPPORTED |
| Cross-chain | any | Not done / not claimed | — |
| Public demo | Read-only mode: dev sign-in off, visitor data limits, writes refused, no secrets in bundle | Verified-local | `scripts/check-public.ts` (17/17) |
| Public hosting | Static read-only demo, video and deck on GitHub Pages, opened anonymously at desktop and phone width | Verified-public (live URL) | `scripts/check-static-demo.ts` |
| Docs | README from a fresh clone (install, build, verify, dev) | Verified-local | test-results.md “Fresh clone” |
| Media | Narrated local demo video, screenshots, deck PDF | Produced (local footage labelled) | docs/media/, docs/pitch/ |
