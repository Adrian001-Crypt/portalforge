# DoraHacks submission draft — PortalForge

Status legend used in this file: **Prepared** (text ready here) · **Public** (link reachable without login) · **Uploaded** (on the platform) · **Submitted** (DoraHacks shows the build as submitted). Nothing below is Uploaded or Submitted yet.

| Field (DoraHacks) | Value | Status |
|---|---|---|
| Project name | PortalForge | Prepared |
| One-sentence overview | Open-source middleware for Portaldot V3 that deploys and verifies contracts, indexes EVM and native events together, and runs recoverable, evidence-producing workflows without duplicating business effects. | Prepared |
| Track | Modular Cloud & Middleware (see rationale) | Prepared — multi-track question pending with organizers |
| Team members | GitHub: `Adrian001-Crypt`. Display name, role and bio are not filled in | **Needs you** if the form requires them |
| Public GitHub repository | https://github.com/Adrian001-Crypt/portalforge | **Public** |
| Complete README | https://github.com/Adrian001-Crypt/portalforge#readme | **Public** |
| Deployment instructions | `docs/deployment.md`, `docs/funding-handoff.md` | Prepared |
| Project documentation | `docs/` (architecture, capabilities, security, state machine, tests) | Prepared |
| Runnable demo | Read-only, no login: https://adrian001-crypt.github.io/portalforge/demo/ . Local: README “Quick start” (verified from a fresh clone) | **Public**, opened without login (30/30 anonymous checks) |
| Demo video (≤ 3 min, public link) | https://adrian001-crypt.github.io/portalforge/media/portalforge-demo.mp4 (2:24, plays in the browser, also on https://adrian001-crypt.github.io/portalforge/) | **Public** |
| Pitch deck (PDF or public link) | https://adrian001-crypt.github.io/portalforge/pitch/portalforge-pitch.pdf | **Public**, opened without login (30/30 anonymous checks) |
| Testnet deployment info | JobRegistry `0xd5dcf5a7d69354b07f776f8a961348f0a394d746` (deploy tx `0x421b5ce147e513dc86ad8a4890f9909a7f78e28e86ef8ac1bd985acd54e3d30f`) · EvidenceRegistry `0xf005d9e544a399196473ec167eda85c089d80cff` (deploy tx `0x72fcb1f2c043f366320e056e9ea800a02db189122f7212ed859429ea7344ec42`) · example job: requestJob `0x1ceaecae6a9a1ece6cc181c97cb8e79517b4ca920c346a2b3c9906f4a8b384aa`, completeJob `0x09bb274acb8e81641a667417ef0fa0b1575d55bb30c89096c139378c0e1252fb`, register `0x4dd14dbcc648ec9d7a1774996cdbf53a983a497f4b2884fcca1e88d80431fc67` · all finalized · no block explorer; evidence and steps to check it: `docs/testnet-evidence/README.md` | **Public** |

## Description (paste into the long description)

On Portaldot V3, Solidity runs inside pallet-revive on a Substrate chain. That gives every contract event two views (an EVM log and a native `Revive.ContractEmitted`), makes storage carry deposits (~0.06 tPOT per byte, 3.84 tPOT per storage slot), shows 14-decimal tPOT as 18 decimals on the EVM side, and offers no `eth_newFilter`. Teams end up gluing indexers, scripts and webhooks that duplicate or lose work when a response is lost or a worker crashes.

PortalForge turns this into one product:
1. **Deployment Workbench** — every create is simulated on the live network (runtime must equal the artifact), the runtime reports the exact storage deposit, deploys are journaled and resume after crashes, and the manifest is re-verified on chain.
2. **Dual-interface indexer** — EVM logs and native events from the deploy block, atomic cursors, reorg and finality handling, per-spec native decoding; an EVM log and its native event are linked only when `eth block hash == reviveApi.ethBlockHash(n)`.
3. **Recoverable workflows** — versioned DAGs with deterministic execution ids, leases, retries with backoff and jitter, dead-letter, approvals and replay; every side effect persists an intent first; unknown outcomes are queried before any retry; chain writes are allowlisted, budgeted, signed and persisted before broadcast, and reconciled from contract state.
4. **Observability** — RPC health from real samples only, incidents with facts / inference / suggestions, auto-resolve, and webhook notifications with retries and duplicate protection.
5. **Verifiable evidence** — canonical hashes registered in a storage-lean EvidenceRegistry and re-verified by the console or `pf evidence verify`, independent of the server.

Delivered as web console, HTTP API (OpenAPI), TypeScript SDK, `pf` CLI, three template contracts and a reference idempotent receiver. Open source (Apache-2.0).

## Why this track

The work is middleware and data components on Portaldot's modular runtime: indexer, workflow/automation layer, API and SDK, plus verifiable data (evidence registry). RPC/finality observability is built on the same data and is relevant to Node Operations & Tooling, but it is not the main product, so a single primary track is chosen unless organizers confirm multi-track entries.

## How Portaldot is used (with evidence)

- Live capability probe: `docs/network-capabilities.md`, `docs/probe/portaldot-v3-testnet-latest.json` (spec 3002, chainId 420420777, tPOT 14 dp, ss58 42, Cancun opcodes, mapping checked against `reviveApi`).
- Exact deposits via `reviveApi.instantiate` dry-run (JobRegistry 161.04, EvidenceRegistry 176.09, 3.8415 tPOT/slot).
- Live smoke on V3 (8 passed): EVM logs indexed, native `revive.ContractEmitted` decoded, 2 log/event pairs linked and verified by `ethBlockHash`.
- Deployed on V3 testnet with two full jobs: requestJob → indexed event → workflow → real HTTP service → completeJob → evidence registered, all transactions finalized, verified independently with the `pf` CLI. Details: `docs/testnet-evidence/README.md`.

## Test results (round 4, 2026-11-04)

**On live V3:** 18/18 cross-checks between chain, indexer, worker and CLI · 25/25 deployment checks · smoke 9 passed, 1 not applicable. **Local:** 22 Foundry tests · 69 unit/integration tests (incl. real Anvil) · 7/7 multi-process fault scenarios · 11/11 deploy crash, resume and budget checks · 8 real-Chrome tests · 14/14 webhook scenarios. Public site: 30/30 anonymous checks. Details: docs/test-results.md.

## Business model (hypothesis — not validated)

Open-source self-hosted core; possible paid hosted indexing with long history, team workspaces/SSO, alert channels and RPC observability for operators. No customers or revenue.

## Known limitations

On V3, transactions were signed by project keys, not a browser wallet; fault recovery was exercised on a local chain only, and local results use Anvil. No ink!/WASM path; no EVM↔WASM calls or cross-chain features. Single-host SQLite store. Dev sign-in only. Not audited. AI-assisted development (Claude Code) disclosed; the demo narration is synthetic.
