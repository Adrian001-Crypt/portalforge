# PortalForge

**Build, observe, and automate on Portaldot.**
面向 Portaldot V3 的应用开发、链上观测与可恢复自动化平台。

PortalForge is open-source middleware for teams building on Portaldot V3:

- **deploy and register** contracts. Every create is simulated on the live network, with an exact storage-deposit preview and a verifiable manifest.
- **index** EVM logs *and* native Revive events, and link the two with a rule the chain can confirm.
- **automate** with versioned workflows: event → condition → idempotent HTTP → allowlisted contract write → evidence.
- **recover** from RPC outages, lost responses and worker crashes without duplicating business effects.
- **verify** deployments and execution evidence against the chain, from the console or the `pf` CLI.

> Status (2026-11-03): everything below runs locally and is tested. Live Portaldot V3 is probed, simulated and indexed read-only. **PortalForge contracts are not yet deployed to the testnet**, because that needs testnet tPOT in the generated deployer account (see [docs/deployment.md](docs/deployment.md)).

## Quick start (local, no funds)

Requirements: Node ≥ 24 (uses `node:sqlite`), Foundry (forge/anvil).

```bash
npm install
npm run contracts:build
npm run dev
```

The console runs at http://localhost:5180 and the API at http://127.0.0.1:4300/api/v1/health. `npm run dev` starts Anvil, deploys the contracts, then starts the demo service, API, indexer and worker. Sign in as `demo-owner` and request a job, or run:

```bash
npx tsx scripts/request-job.ts local-anvil 12 --confirm
```

## Verify

```bash
npm run verify            # typecheck · 21 Foundry tests · 56 Vitest tests (incl. real Anvil) · web build
npx tsx scripts/e2e-local.ts   # 7 multi-process scenarios with fault injection
npx playwright test       # 3 real-Chrome tests (with npm run dev running)
npm run smoke:testnet     # read-only checks against live Portaldot V3
```

Results and their scope are in [docs/test-results.md](docs/test-results.md) and [docs/verification-matrix.md](docs/verification-matrix.md).

## Portaldot testnet

```bash
npm run -s pf -- network inspect                       # live capability probe
npm run -s pf -- deploy plan --profile minimal          # simulation + exact deposit + balance
npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 25   # after funding
PF_MODE=testnet npm run dev
```

Facts measured on V3 (details in [docs/network-capabilities.md](docs/network-capabilities.md)):
- tPOT has 14 decimals and SS58 prefix 42.
- EVM chainId is 420420777, served by pallet-revive `eth-rpc` with `allowEVMBytecode=true`.
- Cancun opcodes work.
- `eth_newFilter` is unsupported.
- Storage deposit is about 0.06 tPOT per byte. JobRegistry needs 161.04 tPOT and EvidenceRegistry 176.09 tPOT.
- The EVM block hash equals `reviveApi.ethBlockHash(n)`.

## SDK / CLI

```ts
import { probeNetwork, verifyManifest, verifyEvidence, PortalForgeClient } from '@portalforge/sdk';
import { PORTALDOT_V3_TESTNET } from '@portalforge/domain';
const caps = await probeNetwork(PORTALDOT_V3_TESTNET);
const pf = new PortalForgeClient({ baseUrl: 'http://127.0.0.1:4300', apiKey: process.env.PF_API_KEY });
for await (const e of pf.allEvents('local-demo', { event: 'JobRequested' })) console.log(e.args);
```

```bash
npm run -s pf -- --help
pf doctor · pf network inspect · pf project init · pf deploy plan · pf deployment verify <manifest>
pf events tail [--follow] · pf workflow validate|simulate <file> · pf execution inspect <id> · pf evidence verify <id>
```

All commands support `--json` and use explicit exit codes (0 ok · 1 failed check · 2 usage · 3 not configured · 4 network). The OpenAPI document is served at `/api/v1/openapi.json`.

## Repository

```
apps/api            Hono API (+ serves the built console)
apps/web            React console
services/indexer    EVM + native indexer
services/worker     router · scheduler · workflow engine · executor · monitor
packages/domain     schemas, canonical hashing, units, RBAC, workflow DSL, ABIs
packages/store      SQLite (WAL) store, migrations, config, logger
packages/portaldot-evm / portaldot-native   chain readers, address mapping
packages/workflow-engine   engine, SSRF-safe HTTP, EVM executor, reconcilers
packages/ops        incidents, RPC health, diagnosis rules
packages/sdk        probe, deploy planner, verifiers, API client
packages/cli        pf
contracts/evm       JobRegistry, EvidenceRegistry, WorkflowExecutionRegistry (Foundry)
examples            demo-service (idempotent receiver), workflows/job-square.json
scripts             probe, keygen, deploy, dev, e2e-local, smoke-testnet, request-job
docs                architecture, capabilities, security, state machine, deployment, results, submission
```

## Known limitations

- No PortalForge deployment on the Portaldot testnet yet (needs funding). Local Anvil is plain EVM and is not testnet evidence.
- ink!/WASM (pallet-contracts) is not implemented. EVM↔WASM calls and cross-chain features are not claimed.
- The store is single-host SQLite; see the scale boundary in [docs/architecture.md](docs/architecture.md).
- Dev sign-in is for local/demo use only. There is no external identity provider yet.
- Exactly-once holds only against receivers that deduplicate by `executionId`, as the demo service does.
- Not audited.

Docs: [architecture](docs/architecture.md) · [why Portaldot](docs/why-portaldot.md) · [workflow state machine](docs/workflow-state-machine.md) · [security](docs/security.md) · [deployment](docs/deployment.md) · [demo script](docs/demo-script.md) · [hackathon rules](docs/hackathon-requirements.md) · [timeline](docs/development-timeline.md) · [handoff](docs/handoff.md).

License: Apache-2.0. Third-party components: [THIRD_PARTY.md](THIRD_PARTY.md). Built with assistance from Claude Code (Anthropic).
