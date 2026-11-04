# Deployment

## A. Local integration (no funds needed)

```bash
npm install
npm run contracts:build
npm run dev          # Anvil :8547 → deploy contracts → demo service → API :4300 → indexer → worker → console :5180
```

Sign in at http://localhost:5180 with any handle (dev sign-in), or as `demo-owner` to operate the seeded demo project. Request jobs from the Contract Workspace (any injected wallet on chain 31337) or:

```bash
npx tsx scripts/request-job.ts local-anvil 12 --confirm
```

Everything local is labelled **local**: Anvil is plain EVM, not pallet-revive.

## B. Portaldot V3 testnet

Current plan numbers (2026-11-03, `pf deploy plan`):

| Profile | Contracts | Exact storage deposit | Max fee your balance must cover |
|---|---|---|---|
| `jobs` | JobRegistry | 161.04 tPOT | ≈ 175.4 tPOT |
| `minimal` (recommended) | JobRegistry + EvidenceRegistry | 337.13 tPOT | ≈ 367.2 tPOT |
| `full` | + WorkflowExecutionRegistry | 508.85 tPOT | ≈ 554.3 tPOT |

Each demo call creates exactly one new storage slot, measured at **3.8415 tPOT** on V3. A job therefore costs about 3.94 (requestJob, deployer) + 7.88 (completeJob + register, executor), gas included. `full` does not fit in the requested 450 tPOT. **The plan is in [funding-handoff.md](funding-handoff.md)**: 450 tPOT to the deployer, `--fund-executor 35`, 3 jobs.

### Step 1 — get testnet tokens (you)
Through the official channel only (Discord support ticket, or DM the admins listed on the DoraHacks page). Give them your **native SS58 address (starts with 5)** and a screenshot of your registration. Never share a seed phrase.

### Step 2 — dedicated PortalForge identities (already generated on this machine)

```bash
npm run keygen -- portaldot-v3-testnet
```

This creates fresh keys in `.secrets/` (mode 0600, gitignored) and prints only addresses:

| Role | EVM address | Fund this native SS58 address |
|---|---|---|
| deployer (contract owner) | `0xAC575944f0696eF19e7f835fd28491c25e40Ca14` | `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t` |
| executor (low privilege) | `0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25` | `5DUz1yfSnCvrKi5jVreWcD3feVxmxXUk64x8ka2WaEqQ3Xhx` |

The SS58 addresses are the pallet-revive **fallback accounts** of those H160 keys (`h160 ++ 0xEE×12`, prefix 42). The mapping rule was checked against `reviveApi`.

### Step 3 — transfer tPOT (you, in your wallet)
In polkadot.js Apps (custom endpoint `wss://test-node-v3.portaldot.dev`), Talisman or SubWallet, send from your faucet account:
- **450 tPOT → deployer** `5Fxg3MEs…czF1t`. Other amounts: see the table in [funding-handoff.md](funding-handoff.md)
- nothing to the executor: the deploy step forwards its budget (`--fund-executor 35`)

Then confirm the EVM view sees the balance:

```bash
npm run -s pf -- deploy plan --profile minimal --fund-executor 35 --jobs 3
```

The balance line must be non-zero and the plan must have no BLOCKER.

### Step 4 — deploy (signs and broadcasts; needs your go-ahead)

```bash
npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 35 --jobs 3
```

The journal (`deployments/portaldot-v3-testnet.journal.json`) records each intent before broadcast and the tx hash right after. Re-running resumes from it and never redeploys blindly. When it finishes, the manifest `deployments/portaldot-v3-testnet.json` is written and verified live: chainId, genesis, code hash equal to the artifact, receipt, block canonicality, `owner()`, `executor()`/`isWriter()`, and no logs before the start block.

```bash
npm run deploy:verify -- portaldot-v3-testnet
npm run -s pf -- deployment verify deployments/portaldot-v3-testnet.json --executor 0x3ec086354a0DaDFb3ecb9A23B6B63229C4b91f25
```

### Step 5 — run PortalForge against the testnet

```bash
PF_MODE=testnet npm run dev
```

This seeds a public read-only project `portaldot-testnet-demo` from the manifest and loads the executor key (`.secrets/portaldot-v3-testnet-executor.json`). Request a job:

```bash
npx tsx scripts/request-job.ts portaldot-v3-testnet 12 --confirm
```

Or use the console's Contract Workspace with MetaMask on chain 420420777. Fund the MetaMask key's fallback SS58 address first.

### Step 6 — collect evidence

```bash
npm run smoke:testnet       # read-only: probe, plan, live indexing + correlation, manifest verification
npm run -s pf -- execution inspect <executionId> --api http://127.0.0.1:4300
npm run -s pf -- evidence verify <evidenceId> --api http://127.0.0.1:4300
```

Copy the deploy tx hashes, contract addresses and one full job's tx hashes (`requestJob`, `completeJob`, `register`) into `docs/submission-draft.md`. Only real values go there.

## C. Public read-only demo (outward-facing: you decide where and when)

```bash
npm ci && npm run contracts:build && npm run web:build
npx tsx scripts/public-demo.ts                       # local data (labelled Local Anvil) + read-only V3 observation, :4400
PF_PUBLIC_NETWORK=testnet npx tsx scripts/public-demo.ts   # after the testnet deployment
npx tsx scripts/check-public.ts http://127.0.0.1:4400       # 17 anonymous-visitor checks
npx tsx scripts/public-demo.ts --tunnel              # + temporary https://…trycloudflare.com URL to the API port only
```

The public stack disables dev sign-in and serves the built console from the API with SPA fallback and CSP. It also keeps fault injection on 127.0.0.1 behind a random token. Visitors can read only `public_readonly` projects. They cannot see connector targets, channels, the audit log or host names, and every write returns 401/403.

A quick tunnel is free and needs no account, but its URL lasts only while the command runs. Use it for a live session, not for a link that must stay up for days. A stable public URL needs a host that keeps the processes running: any VM with Node ≥ 24 running the same command behind HTTPS. No such host was available in this round.

Not done: a container image, managed hosting, TLS automation.
