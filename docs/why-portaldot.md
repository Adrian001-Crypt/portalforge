# Why Portaldot

PortalForge is built for the way Portaldot V3 actually works, as measured on the live testnet (docs/network-capabilities.md). Each point links to code and evidence.

## 1. EVM contracts on a Substrate runtime → two views of every event
Portaldot V3 runs Solidity bytecode inside **pallet-revive**, behind an `eth-rpc` proxy. One contract event is visible both as an EVM log and as a native `Revive.ContractEmitted` event.
- PortalForge indexes **both** (`services/indexer/src/evm.ts`, `native.ts`) and links them only with a rule the chain can confirm: same block, contract, topics, data and ordinal, **plus** `eth block hash == reviveApi.ethBlockHash(n)` (`correlation.ts`).
- Evidence: live smoke test linked and verified a real log/event pair on V3 (`docs/test-results/smoke-testnet-latest.json`).
- Value: EVM tooling cannot see dispatch errors, runtime versions or native events; Substrate tooling cannot decode EVM ABIs. Developers on Portaldot need both, correlated honestly.

## 2. Storage deposits make deployment planning a real problem
On V3, code and storage cost ~0.06 tPOT per byte (+30% code lockup) and 0.15 tPOT per item; a 2 KB contract holds ~160 tPOT. `eth_estimateGas` folds this into "gas".
- PortalForge's planner simulates each create through `eth_call` (runtime code must equal the artifact) and asks the runtime for the **exact deposit** via `reviveApi.instantiate` (`packages/sdk/src/deploy.ts`); shown in the Deployment Workbench and `pf deploy plan`.
- The template contracts were redesigned around this (one packed slot per job, commitment-only evidence) — measured deposits in the capability report.

## 3. Address mapping is not obvious
Native SS58 accounts and H160 accounts are different identities unless mapped. PortalForge implements the pallet-revive rule and **verifies it against `reviveApi.address/accountId`** in every probe (`packages/portaldot-native/src/address.ts`), and tells users which SS58 fallback address funds a given 0x key.

## 4. GRANDPA finality and runtime upgrades
- `safe`/`finalized` tags are supported and track GRANDPA (~2-block lag). Workflow triggers default to `minFinality: safe`; reorgs inside the window orphan events and cancel queued executions.
- Native events are decoded with each block's own runtime; spec changes raise a `runtime_upgrade` incident and tag decoder versions.

## 5. Middleware the ecosystem lacks
There is no hosted indexer/automation layer for V3 today (`eth_newFilter` is not even available on the public eth-rpc). PortalForge provides the missing **Modular Cloud & Middleware** pieces as one open-source, self-hostable product: indexer + workflow engine + API + SDK/CLI + console, with node/RPC observability (Node Operations & Tooling value) built on the same data.

## What PortalForge does not claim
No EVM↔WASM contract calls, no cross-chain messaging or bridge, no ink! deployment in this round, no node-internal metrics. These are listed as not done in docs/handoff.md.
