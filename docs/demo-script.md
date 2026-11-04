# Demo video — script, narration and shot list

Official limit: **≤ 3 minutes**, shows the real product, core functions and Portaldot integration, publicly accessible link (DoraHacks page, re-checked 2026-11-03).

## What exists now

| Item | Status | Location |
|---|---|---|
| Demo video, 2:24, 1280×720 H.264 + AAC, synthetic narration (macOS `say`, voice “Samantha”) with on-screen captions. V3 footage plus two labelled local scenes | **Recorded** | `docs/media/portalforge-demo.mp4` |
| How it was made | `record-demo.ts` (local scenes), `record-testnet.ts --confirm 9` (V3 scenes; sends one real job), `build-final-video.py` joins them | `scripts/media/` |
| 16 product screenshots | Captured | `docs/media/screenshots/` |
| Testnet shots (deployment, on-chain job, evidence, CLI verify on V3) | **Recorded**; the wait for finality in the job scene is sped up from 76 s to 23 s, and the narration says so | in the video |
| Public video link | Served from the project page; no account needed to watch. A YouTube copy is optional | https://adrian001-crypt.github.io/portalforge/media/portalforge-demo.mp4 |

Scenes 1 and 3 and the fault scene are from **Local Anvil** (plain EVM), and the console badge “Local Anvil · not testnet” is visible. Scene 2 shows live V3 RPC samples and the stored probe. The deployment, job, evidence and CLI scenes are from the **live V3 testnet**, with the badge “Portaldot V3 Testnet”. Fault recovery stayed local to save testnet tokens. No host names, keys or `.secrets` appear.

## Timeline of the recorded video (real timecodes)

| Time | Scene | Page(s) | On-screen action |
|---|---|---|---|
| 0:00–0:18 | Problem & product | Overview (“Start here”) | Local |
| 0:19–0:39 | Portaldot integration (measured) | Network Health → Portaldot V3 Testnet | Live V3 samples |
| 0:40–1:03 | Deploy with a wallet | Workbench, signed through the injected test wallet, manifest verified | Local |
| 1:04–1:21 | Deployed on V3 | Deployments → record with live verification checks | **V3** |
| 1:21–1:44 | A real job | `requestJob` on V3, Event Explorer, execution trace with real tx hashes | **V3**, wait sped up |
| 1:44–1:54 | Evidence | Verify against chain, then `pf evidence verify` | **V3** |
| 1:54–2:10 | Fault & recovery | Response dropped, attempt 1 unknown, attempt 2 reconciled | Local |
| 2:10–2:24 | Close | End card with repository link | **V3** statement |

## Narration (English, as recorded) · 中文说明

| # | English narration (read aloud) | 中文说明 |
|---|---|---|
| 1 | Building on Portaldot V3 means Solidity contracts running inside a Substrate runtime. Every event has two views, storage costs real deposits, and automation breaks when a response is lost. PortalForge is open-source middleware that deploys, indexes, automates, recovers and verifies. | 问题：V3 上 Solidity 运行在 Substrate runtime（pallet-revive）里；每个事件有 EVM/原生两种视图，存储有押金，响应丢失会让自动化出错。PortalForge 提供部署、索引、自动化、恢复与验证。 |
| 2 | PortalForge measures the network instead of assuming. The capability probe, recorded on the live V3 testnet, confirms the chain identity, fourteen-decimal tPOT, Cancun opcodes and the account mapping, and shows that each EVM block hash equals the runtime’s own eth block hash. That is the rule we use to link EVM logs with native events. | 实测而非假设：探测确认链身份、tPOT 14 位精度、Cancun 操作码、账户映射，以及 EVM 区块哈希等于 reviveApi.ethBlockHash——这是 EVM 日志与原生事件关联的依据。 |
| 3 | Deployments are planned before anything is signed. Each create is simulated and its runtime code must equal the compiled artifact. On V3 the planner also asks the runtime for the exact storage deposit: one hundred sixty-one tPOT for the job registry. Then the wallet signs, and the record is verified against the chain. This footage runs on a local Anvil chain, and it is labelled that way. | 部署先规划：模拟部署并核对 runtime 代码与编译产物一致；V3 上还向 runtime 查询精确押金（JobRegistry 161 tPOT）；然后钱包签名，部署记录在链上核验。本段为本地 Anvil 画面，已标注。 |
| 4 | This is the live Portaldot V3 testnet. The job registry and the evidence registry are deployed, and verified against the chain: chain id, genesis, code hash, owner and executor. The two deploys cost three hundred thirty-seven tPOT, almost all of it storage deposit. | 这是真实的 Portaldot V3 测试网。两个合约已部署并在链上核验；部署花费 337 tPOT，几乎全是存储押金。 |
| 5 | Now a real job. A requestJob transaction goes to V3. The indexer records the event and its native Revive twin, and the workflow waits for finality. It calls the service, sends completeJob from a low-privilege executor, and registers evidence. Every step keeps its real transaction hash and block. The wait for finality is sped up in this video. | 真实任务：requestJob 上链，索引器记录事件及原生 Revive 事件，工作流等待最终确定，调用服务，由低权限执行账户 completeJob 并登记存证。等待最终确定的过程已加速。 |
| 6 | The console recomputes the evidence hash and compares it with the registry on V3. The pf command line runs the same check on its own, without trusting this server. | 控制台重算存证哈希并与 V3 上的登记比对；pf CLI 可不依赖服务器独立核验。 |
| 7 | Now we break it. The demo service processes the next job but drops the response. PortalForge marks the outcome unknown, queries the service by execution id, and reuses the stored result. The service computed it once, and the contract completed the job once. | 故障注入（本地链）：服务处理后丢弃响应；PortalForge 标记“未知”，按 executionId 查询并复用结果；服务只计算一次，合约只完成一次。 |
| 8 | The deployment, the job and the evidence you just saw are on the V3 testnet. The fault recovery was shown on a local chain, to save testnet tokens. PortalForge is open source, built for the Modular Cloud and Middleware track. | 部署、任务和存证都在 V3 测试网上；故障恢复在本地链演示以节省测试币。开源，主赛道 Modular Cloud & Middleware。 |

## Recording checklist (if you re-record with your own voice)

- Run `npm run dev` (local) or `PF_MODE=testnet PF_DATA_DIR=data/testnet npm run dev`; sign in as `demo-owner`; browser at 1280×720 or larger; close other tabs and notifications.
- Never show `.secrets/`, `.env`, shell history or environment variables; hide the macOS menu-bar user name if visible.
- Say “local Anvil” whenever the badge reads **Local Anvil · not testnet**.
- Export as MP4 (H.264/AAC), ≤ 3:00, check audio level and that captions/text are readable at 720p, then upload unlisted and paste the link into `docs/submission-draft.md`.
