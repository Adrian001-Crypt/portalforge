# Demo script (≤ 3:00)

Pre-flight: `PF_MODE=testnet npm run dev` (after testnet deploy) or `npm run dev` (local; say "local Anvil" on screen). Browser at the console, signed in as `demo-owner`. Terminal with `pf` ready. Demo service admin token known.

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:20 | Overview | "Building on Portaldot V3 means EVM contracts inside a Substrate runtime: two RPCs, two views of every event, storage deposits, GRANDPA finality. Teams glue indexers, cron jobs and scripts together and lose track when something fails. PortalForge is the middleware: deploy, index, automate, recover, verify." |
| 0:20–0:50 | Network Health → capability probe; Deployments → workbench plan | Show live identity (genesis, spec 3002, tPOT 14 dp, chainId 420420777), opcode probe, mapping verified against reviveApi. Plan JobRegistry: "runtime matches artifact", **exact storage deposit 161 tPOT**. Open the deployment record: 32 checks re-read from chain. |
| 0:50–1:25 | Contract Workspace → requestJob → Executions | Request a job with the wallet (intent saved first). Event Explorer: JobRequested, finality badge, ⇄ linked native event verified by ethBlockHash. Execution trace: guard → compute (HTTP) → check → completeJob → evidence. |
| 1:25–2:00 | Terminal + Executions | `curl -X POST …/admin/faults -d '{"dropNextResponse":1}'`, request another job. Trace shows compute **unknown** → query → **reconciled**, receiver processed once. Then kill the worker (`kill -9`) during a slow request; restart; attempts show two workers; job completed once. |
| 2:00–2:35 | Evidence + terminal | Evidence page: local hash = on-chain commitment, checks pass, "proves registration, not truth". Terminal: `pf deployment verify deployments/<net>.json` and `pf evidence verify <id>` → VERIFIED, independent of the server. |
| 2:35–3:00 | Incidents + Developers | RPC outage incident with facts / inference / suggestion and auto-resolve. "Open source, self-hosted core; SDK, CLI, OpenAPI. Track: Modular Cloud & Middleware, with node/RPC observability on the same data." |

Rules for recording: show only real data; say "local Anvil" whenever the network badge says local; do not show `.secrets/` or the terminal environment.
