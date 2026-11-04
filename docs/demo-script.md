# Demo video — script, narration and shot list

Official limit: **≤ 3 minutes**, shows the real product, core functions and Portaldot integration, publicly accessible link (DoraHacks page, re-checked 2026-11-03).

## What exists now

| Item | Status | Location |
|---|---|---|
| Local walkthrough video, 2:18, 1280×720 H.264 + AAC, synthetic narration (macOS `say`, voice “Samantha”) with on-screen captions | **Recorded** | `docs/media/portalforge-demo.mp4` |
| How it was made (re-runnable) | `npx tsx scripts/media/record-demo.ts && sh scripts/media/build-video.sh` (starts the local stack if needed) | `scripts/media/` |
| 16 product screenshots | Captured | `docs/media/screenshots/` |
| Testnet shots (deploy, on-chain job, CLI verify on V3) | **Pending** — need testnet tPOT | see “Pending testnet shots” |
| Public video link | Served from the project page; no account needed to watch. A YouTube copy is optional | https://adrian001-crypt.github.io/portalforge/media/portalforge-demo.mp4 |

All footage in the current video is from **Local Anvil** (plain EVM) except the Network Health scene, which shows the stored live V3 probe and live V3 RPC samples. The console badge “Local Anvil · not testnet” is visible throughout. Privacy check done: no host names, keys, `.secrets` or terminal environment appear (worker ids are random).

## Timeline of the recorded video (real timecodes)

| Time | Scene | Page(s) | On-screen action |
|---|---|---|---|
| 0:00–0:18 | Problem & product | Overview (“Start here”) | Overview with project + network badges |
| 0:19–0:39 | Portaldot integration (measured) | Network Health → Portaldot V3 Testnet | Live V3 RPC samples; capability probe table |
| 0:40–1:03 | Deploy with a wallet | Deployments → deployment record | Plan shows simulation match, signed through the injected test wallet, manifest verified, verification checks |
| 1:04–1:13 | User request | Contract Workspace → Event Explorer | `requestJob(12)` signed through the injected wallet; `JobRequested` indexed |
| 1:14–1:28 | Workflow & trace | Workflow Builder → Executions | job-square graph; execution trace with steps |
| 1:29–1:45 | Fault & recovery | Contract Workspace → execution trace | Fault injected (response dropped), `requestJob(9)`, trace: attempt 1 unknown → attempt 2 reconciled |
| 1:46–1:57 | Evidence | Evidence → Verify against chain | Local hash = on-chain commitment, checks pass |
| 1:58–2:18 | Close | Incidents, Developer API / CLI, end card | Honest status: testnet deployment pending; repository link |

## Narration (English, as recorded) · 中文说明

| # | English narration (read aloud) | 中文说明 |
|---|---|---|
| 1 | Building on Portaldot V3 means Solidity contracts running inside a Substrate runtime. Every event has two views, storage costs real deposits, and automation breaks when a response is lost. PortalForge is open-source middleware that deploys, indexes, automates, recovers and verifies. | 问题：V3 上 Solidity 运行在 Substrate runtime（pallet-revive）里；每个事件有 EVM/原生两种视图，存储有押金，响应丢失会让自动化出错。PortalForge 提供部署、索引、自动化、恢复与验证。 |
| 2 | PortalForge measures the network instead of assuming. The capability probe, recorded on the live V3 testnet, confirms the chain identity, fourteen-decimal tPOT, Cancun opcodes and the account mapping, and shows that each EVM block hash equals the runtime’s own eth block hash. That is the rule we use to link EVM logs with native events. | 实测而非假设：探测确认链身份、tPOT 14 位精度、Cancun 操作码、账户映射，以及 EVM 区块哈希等于 reviveApi.ethBlockHash——这是 EVM 日志与原生事件关联的依据。 |
| 3 | Deployments are planned before anything is signed. Each create is simulated and its runtime code must equal the compiled artifact. On V3 the planner also asks the runtime for the exact storage deposit: one hundred sixty-one tPOT for the job registry. Then the wallet signs, and the record is verified against the chain. This footage runs on a local Anvil chain, and it is labelled that way. | 部署先规划：模拟部署并核对 runtime 代码与编译产物一致；V3 上还向 runtime 查询精确押金（JobRegistry 161 tPOT）；然后钱包签名，部署记录在链上核验。本段为本地 Anvil 画面，已标注。 |
| 4 | A user requests a job from their wallet. PortalForge saves the signing intent before the wallet opens, and the indexer picks up the JobRequested event with its finality. | 用户用钱包请求任务；钱包打开前先持久化签名意图；索引器收录 JobRequested 及其最终性。 |
| 5 | The job-square workflow is a versioned graph: a guard, an idempotent HTTP call, schema validation, an allow-listed completeJob transaction, and evidence registration. Each execution keeps every attempt and side-effect intent. | 工作流是版本化有向图：条件、幂等 HTTP、结果校验、白名单内的 completeJob 交易、存证登记；每次执行保留全部尝试与副作用意图。 |
| 6 | Now we break it. The demo service processes the next job but drops the response. PortalForge marks the outcome unknown, queries the service by execution id, and reuses the stored result. The service computed it once, and the contract completed the job once. | 故障注入：示例服务处理后丢弃响应；PortalForge 标记“未知”，按 executionId 查询并复用结果；服务只计算一次，合约只完成一次。 |
| 7 | Evidence is a canonical hash registered on chain. The console recomputes it locally and compares it with the on-chain commitment and writer. The same check runs from the pf command line, independent of this server. | 存证：规范化哈希上链；控制台本地重算并与链上承诺、写入者比对；pf CLI 可独立复核。 |
| 8 | Failures open incidents with facts and suggested steps, and webhook notifications retry until they are delivered. Testnet deployment is prepared and budgeted, and waits for testnet tokens; until then every testnet page says not deployed. PortalForge is open source, built for the Modular Cloud and Middleware track. | 故障生成事件，附事实与建议步骤；Webhook 通知失败会重试直至送达。测试网部署已准备好并做了预算，等待测试币；在此之前所有测试网页面都显示“未部署”。开源，主赛道 Modular Cloud & Middleware。 |

## Pending testnet shots

The shot list and the values to capture are in [post-funding-evidence.md](post-funding-evidence.md).

Suggested narration: “This is the live Portaldot V3 testnet: the plan shows the real balance and exact deposits, the deploy is journaled, and the same job completes on chain with evidence verified from the command line.”

## Recording checklist (if you re-record with your own voice)

- Run `npm run dev` (local) or `PF_MODE=testnet npm run dev`; sign in as `demo-owner`; browser at 1280×720 or larger; close other tabs and notifications.
- Never show `.secrets/`, `.env`, shell history or environment variables; hide the macOS menu-bar user name if visible.
- Say “local Anvil” whenever the badge reads **Local Anvil · not testnet**.
- Export as MP4 (H.264/AAC), ≤ 3:00, check audio level and that captions/text are readable at 720p, then upload unlisted and paste the link into `docs/submission-draft.md`.
