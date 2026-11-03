# DoraHacks submission draft — PortalForge

> Fill the bracketed items only with real values. Remove this note before submitting.

**Project name:** PortalForge
**One-sentence overview:** Open-source middleware for Portaldot V3 that deploys and verifies contracts, indexes EVM and native events together, and runs recoverable, evidence-producing workflows without duplicating business effects.
**Track:** Modular Cloud & Middleware (related value: Node Operations & Tooling — pending organizer answer on multi-track selection)
**Team members:** [your name / handle] (+ disclosure: developed with Claude Code assistance)
**Repository:** [public GitHub URL — not yet published]
**Demo:** [video link — not recorded yet] · [live read-only demo URL — not deployed yet] · local: README "Quick start"
**Pitch deck:** [link]

## Description
Building on Portaldot V3 means Solidity running inside pallet-revive on a Substrate chain:
- two RPCs, and two views of every event (EVM log and native `Revive.ContractEmitted`)
- storage deposits of about 0.06 tPOT per byte
- 14-decimal native tPOT shown as 18 decimals on the EVM side
- GRANDPA finality, and no `eth_newFilter`

PortalForge turns this into one product:
1. **Deployment Workbench.** Live simulation proves the runtime equals the artifact, `reviveApi` gives the exact storage deposit, deploys are journaled, and the manifest is verified against the chain.
2. **Dual-interface indexer.** It starts from the deploy block and keeps cursors atomic with events. It handles reorgs and finality, and decodes native events per runtime spec. An EVM log and its native event are linked only when `ethBlockHash` matches.
3. **Workflow engine.** Executions are versioned and immutable, with deterministic ids, leases, retries with backoff and jitter, a dead-letter queue, approvals and replay. Every side effect persists an intent first. Before retrying, the engine queries the target. Chain writes are signed and persisted before broadcast, then reconciled from business state.
4. **Observability.** RPC health is computed from real samples only. Incidents separate facts, inference and suggestions.
5. **Evidence.** Canonical hashes are registered in a storage-lean EvidenceRegistry and verified by the console or by `pf evidence verify`.

## Portaldot integration (evidence)
- Capability probe of the live V3 testnet: `docs/network-capabilities.md`, `docs/probe/portaldot-v3-testnet-2026-11-03.json`
- Live read-only smoke run (8 passed): `docs/test-results/smoke-testnet-latest.json`, including a verified EVM⇄native correlation
- Testnet contracts: [JobRegistry address] · [EvidenceRegistry address] — **not deployed yet**
- Deploy transactions: [tx hashes] — **pending**
- Example job: requestJob [tx] → completeJob [tx] → evidence register [tx] — **pending**
- Explorer: no explorer URLs. Evidence is RPC-based via `pf deployment verify`

## Tests
21 Foundry tests, 56 Vitest tests (including real Anvil chain tests), 7 multi-process E2E scenarios with real fault injection (lost response, worker SIGKILL, RPC outage, replay) and 3 real-Chrome tests (two sessions racing on one account). See `docs/test-results.md`.

## Business model (hypothesis, not validated)
The open-source core is self-hosted. Paid hosted options would cover managed indexing with long history retention, team workspaces with SSO, alerting channels, and SLA-backed RPC observability for node operators. There are no customers or revenue yet.

## Known limitations
No ink!/WASM path. No cross-chain features. Single-host store. Not audited. See README.
