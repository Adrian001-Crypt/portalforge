# DoraHacks submission draft — PortalForge

Status legend used in this file: **Prepared** (text ready here) · **Public** (link reachable without login) · **Uploaded** (on the platform) · **Submitted** (DoraHacks shows the build as submitted). Nothing below is Uploaded or Submitted yet.

| Field (DoraHacks) | Value | Status |
|---|---|---|
| Project name | PortalForge | Prepared |
| One-sentence overview | Open-source middleware for Portaldot V3 that deploys and verifies contracts, indexes EVM and native events together, and runs recoverable, evidence-producing workflows without duplicating business effects. | Prepared |
| Track | Modular Cloud & Middleware (see rationale) | Prepared — multi-track question pending with organizers |
| Team members | **[your name / handle]**, **[role]**, **[short bio]** | **Needs you** |
| Public GitHub repository | **[https://github.com/<you>/portalforge]** | **Needs you** (publish steps in docs/final-delivery.md) |
| Complete README | `README.md` | Prepared (public once the repo is) |
| Deployment instructions | `docs/deployment.md`, `docs/funding-handoff.md` | Prepared |
| Project documentation | `docs/` (architecture, capabilities, security, state machine, tests) | Prepared |
| Runnable demo | Local: README “Quick start” (verified from a fresh clone). Public read-only: **[URL]** | Local prepared; public URL **needs you** |
| Demo video (≤ 3 min, public link) | File `docs/media/portalforge-demo.mp4` (2:08). Link **[unlisted YouTube/Loom/Drive URL]** | File prepared; **upload needs you**; testnet shots pending |
| Pitch deck (PDF or public link) | `docs/pitch/portalforge-pitch.pdf` (public via the repo once published) | Prepared; team/repo placeholders on slides 1 and 10 |
| Testnet deployment info | Contract addresses **[pending]** · deploy tx **[pending]** · example job txs **[pending]** · explorer: none (RPC evidence via `pf deployment verify`) | **Pending funding** |

## Description (paste into the long description)

On Portaldot V3, Solidity runs inside pallet-revive on a Substrate chain. That gives every contract event two views (an EVM log and a native `Revive.ContractEmitted`), makes storage carry deposits (~0.06 tPOT per byte, 3.84 tPOT per storage slot), shows 14-decimal tPOT as 18 decimals on the EVM side, and offers no `eth_newFilter`. Teams end up gluing indexers, scripts and webhooks that duplicate or lose work when a response is lost or a worker crashes.

PortalForge turns this into one product:
1. **Deployment Workbench** — every create is simulated on the live network (runtime must equal the artifact), the runtime reports the exact storage deposit, deploys are journaled and resume after crashes, and the manifest is re-verified on chain.
2. **Dual-interface indexer** — EVM logs and native events from the deploy block, atomic cursors, reorg and finality handling, per-spec native decoding; an EVM log and its native event are linked only when `eth block hash == reviveApi.ethBlockHash(n)`.
3. **Recoverable workflows** — versioned DAGs with deterministic execution ids, leases, retries with backoff and jitter, dead-letter, approvals and replay; every side effect persists an intent first; unknown outcomes are queried before any retry; chain writes are allowlisted, budgeted, signed and persisted before broadcast, and reconciled from contract state.
4. **Observability** — RPC health from real samples only, incidents with facts / inference / suggestions, auto-resolve and webhook notifications.
5. **Verifiable evidence** — canonical hashes registered in a storage-lean EvidenceRegistry and re-verified by the console or `pf evidence verify`, independent of the server.

Delivered as web console, HTTP API (OpenAPI), TypeScript SDK, `pf` CLI, three template contracts and a reference idempotent receiver. Open source (Apache-2.0).

## Why this track

The work is middleware and data components on Portaldot's modular runtime: indexer, workflow/automation layer, API and SDK, plus verifiable data (evidence registry). RPC/finality observability is built on the same data and is relevant to Node Operations & Tooling, but it is not the main product, so a single primary track is chosen unless organizers confirm multi-track entries.

## How Portaldot is used (with evidence)

- Live capability probe: `docs/network-capabilities.md`, `docs/probe/portaldot-v3-testnet-latest.json` (spec 3002, chainId 420420777, tPOT 14 dp, ss58 42, Cancun opcodes, mapping checked against `reviveApi`).
- Exact deposits via `reviveApi.instantiate` dry-run (JobRegistry 161.04, EvidenceRegistry 176.09, 3.8415 tPOT/slot).
- Live smoke on V3 (8 passed): EVM logs indexed, native `revive.ContractEmitted` decoded, 2 log/event pairs linked and verified by `ethBlockHash`.
- Testnet deployment and on-chain job: **[pending funding — addresses and tx hashes go here]**.

## Test results (round 2, 2026-11-03)

21 Foundry tests · 59 unit/integration tests (incl. real Anvil chain tests) · 7/7 multi-process fault scenarios (lost response, worker SIGKILL, RPC outage, replay) · 7/7 deploy crash/resume checks · 3 real-Chrome tests · 17/17 public-visitor checks · 8 live V3 read-only checks. Details and gaps: `docs/test-results.md`.

## Business model (hypothesis — not validated)

Open-source self-hosted core; possible paid hosted indexing with long history, team workspaces/SSO, alert channels and RPC observability for operators. No customers or revenue.

## Known limitations

Not yet deployed to testnet (waiting for tPOT); local results use Anvil. No ink!/WASM path; no EVM↔WASM calls or cross-chain features. Single-host SQLite store. Dev sign-in only. Not audited. AI-assisted development (Claude Code) disclosed; the demo narration is synthetic.
