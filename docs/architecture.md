# Architecture

```mermaid
flowchart LR
  subgraph Portaldot V3 (one Substrate chain)
    EVM[eth-rpc / pallet-revive<br/>EVM bytecode]:::chain
    NAT[Native WS<br/>Revive · Contracts · System]:::chain
  end
  subgraph PortalForge
    IDX[indexer<br/>EVM logs + native events]
    WRK[worker<br/>router · scheduler · engine · monitor]
    API[API (Hono)<br/>auth · RBAC · OpenAPI]
    WEB[Web console (React)]
    DB[(SQLite WAL<br/>shared file)]
    CLI[pf CLI / SDK]
  end
  DEMO[Demo service<br/>idempotent receiver]
  WALLET[Browser wallet]
  EVM --> IDX
  NAT --> IDX
  IDX --> DB
  DB --> WRK
  WRK -->|HTTP + Idempotency-Key| DEMO
  WRK -->|allowlisted signed tx| EVM
  WRK -->|samples| EVM & NAT
  API <--> DB
  WEB --> API
  WALLET -->|intent-first signing| EVM
  WEB --> WALLET
  CLI --> API
  CLI -->|independent verification| EVM
  classDef chain fill:#eef,stroke:#88a
```

## Processes

| Process | Code | Responsibility |
|---|---|---|
| API | `apps/api` | sessions/API keys, project RBAC, resources, workflow definitions, execution control, incidents, evidence, wallet intents, OpenAPI. **Never executes workflows and holds no chain key.** |
| Indexer | `services/indexer` | one EVM stream per contract address from its deploy block; one native stream per network; reorg/finality; heartbeat |
| Worker | `services/worker` | event routing, schedules, execution (leases, retries, intents), chain executor (dedicated key), health monitor and incident rules |
| Demo service | `examples/demo-service` | reference receiver: deterministic, idempotent by executionId, result query, fault injection |
| Web | `apps/web` | operator console (served by the API in production builds) |
| CLI/SDK | `packages/cli`, `packages/sdk` | probe, plan, verify, tail, inspect; typed API client |

All processes share one SQLite database in WAL mode (`packages/store`). Every multi-statement write runs in `BEGIN IMMEDIATE`, so cross-process invariants hold:

- indexer: events **and** the cursor that covers them commit together (`services/indexer/src/evm.ts`)
- engine: claims are a single `UPDATE … RETURNING` with lease + concurrency predicate; every later write is guarded by `lease_owner = me AND lease_expires_at >= now` (`packages/workflow-engine/src/engine.ts`)
- executor nonce allocation uses a DB mutex with expiry

**Scale boundary.** This is a single-host design: one database file, any number of worker/indexer processes on that host. It is appropriate for a project or team deployment and for the hackathon demo. A hosted multi-tenant service would move the store to PostgreSQL (`SELECT … FOR UPDATE SKIP LOCKED`) — the store API was kept narrow (`Db.tx/get/all/run`) for that reason. Not done in this round.

## Packages

| Package | Purpose |
|---|---|
| `domain` | schemas (zod), canonical JSON hashing, units, network profiles, RBAC, workflow definition + validator, generated ABIs |
| `store` | SQLite, migrations, ids, config, redacting logger |
| `portaldot-evm` | explicit JSON-RPC reader (empty ≠ failed), identity assertion |
| `portaldot-native` | `@polkadot/api` reader (per-block runtime decoding), pallet-revive address mapping |
| `workflow-engine` | engine, templates/conditions, deterministic tasks, SSRF-safe HTTP, EVM executor, reconcilers |
| `ops` | incidents (aggregation, cooldown, notifications), RPC sampling, diagnosis rules |
| `sdk` | capability probe, artifact loader, deploy planner (+ deposit dry-run), manifest/evidence verifiers, API client |
| `cli` | `pf` |

## Data flow of the demo scenario

1. `JobRegistry.requestJob(input)` → EVM log `JobRequested` (and native `Revive.ContractEmitted`).
2. Indexer stores the log with `finality = unconfirmed → safe → finalized`, decoded with the active ABI version.
3. Router matches workflow `job-square` (trigger `jobs.JobRequested`, `minFinality: safe`), records the (workflow, event) decision once in `trigger_seen`, creates execution `id = keccak256(workflowId|version|eventId)`.
4. Worker claims it: `guard` (condition) → `compute` (HTTP connector, intent persisted, `Idempotency-Key = executionId`) → `check` (schema) → `complete` (allowlisted `completeJob`, simulated, budgeted, signed locally, intent with tx hash persisted **before** broadcast) → `proof` (canonical evidence → `EvidenceRegistry.register`).
5. Contract enforces one completion per job and records the executionId; evidence registry stores one commitment per id.
6. Console / `pf execution inspect` / `pf evidence verify` show and re-verify everything from chain.

## Network modes

| Mode | Networks | Executor | Notes |
|---|---|---|---|
| Local integration (`npm run dev`) | Anvil :8547 | Anvil dev account #1 | Anvil is plain EVM, not pallet-revive; labelled **local** everywhere |
| Portaldot testnet (`PF_MODE=testnet`) | V3 testnet | `.secrets/…-executor.json` (generated, funded by you) | modules without config are disabled, never silently simulated |
| Read-only public demo (`PF_PUBLIC_READONLY=1`) | as configured | — | anonymous read of `public_readonly` projects; no writes, no admin/fault endpoints |
| Demo data | — | — | there is no fabricated dataset; demo projects show real local or testnet data |

## Webhook notifications

An incident queues its deliveries in the same transaction that opens it, so a crash cannot lose one. The worker sends what is due; any number of workers can share the database.

| Situation | What happens |
|---|---|
| The incident repeats while open | It is counted, and nothing new is sent |
| It is re-opened after being resolved | One new delivery with a new key |
| Its severity rises past a channel's minimum | That channel gets its first delivery; others are not repeated |
| 2xx | Delivered |
| 408, 425, 429, 5xx, timeout, network error | Retried with backoff (about 15 s, 1 min, 4 min, 16 min), 5 attempts in total |
| Any other response, or an unsafe target | Final; marked `dead` without retrying |
| The worker dies mid-request | The lease expires and another worker sends it again |
| Retries run out | Marked `dead`; **Settings → Channels** offers Retry |

**Receiver contract.** Delivery is at-least-once. Every attempt carries the same `Idempotency-Key` header and byte-identical body, so a receiver drops repeats by that key. `X-PortalForge-Attempt` counts attempts. Requests are not signed yet, so a receiver should treat the body as a notification and verify anything important through the API.
