# Portaldot Hacker House 2026 — 规则核实记录

核实时间：2026-11-03 16:30 UTC（通过 DoraHacks 活动详情页与赛道页实时读取；本文件只记录页面原文能支持的结论）。

来源：
- https://dorahacks.io/hackathon/portaldot-hacker-house-2026/detail
- https://dorahacks.io/hackathon/portaldot-hacker-house-2026/tracks

## 时间

| 项 | 页面原文 | 结论 |
|---|---|---|
| Final Submission / Code Freeze | Nov 6, 04:00 UTC（时间轴 UTC-6 显示 2026/11/05 22:00） | **2026-11-06 04:00 UTC = 2026-11-05 22:00 America/Chicago (CST, UTC-6)** |
| Check-in Submission Deadline | Oct 24, 12:00 UTC | 已过。本项目在 2026-11-03 开始，**未参加 Check-in** |
| Live Demo Day | Nov 8 – Nov 9 UTC（Discord） | 需要现场演示 |
| Winners | Nov 11 UTC | — |
| 页面倒计时 | “2 days left for submission”，“Submit Build / Register” 按钮可见 | 提交入口当前开放；是否仍接受新报名需在登录后确认 |

“最后 24 小时”窗口：2026-11-05 04:00 UTC 起。核心模块最终版本必须在此之前分批提交。

## 参与与代码要求（原文要点）

- 必须有效利用 Portaldot V3.0 核心能力，并**完成 Portaldot 测试网部署**。
- 代码应主要在 Hacker House 期间（Oct 14 – Nov 6）产生。
- 公共 GitHub 仓库，活动期间保持公开，**至少 3 次有效提交**。
- 核心模块最终版本**不得在截止前 24 小时内一次性提交**。
- 保留提交时间线、PR 等开发记录作为证据。
- Code Freeze 后不得做影响核心功能、架构或评审结果的实质修改；严重 bug 需报告主办方并保留记录。
- 不允许把已有完整项目作为参赛作品；可以使用开源框架、官方 SDK、第三方依赖，但需披露来源。

## Final Submission 必填材料

项目名、团队成员、一句话简介、公共仓库、完整 README、部署说明、项目文档、可复现代码、
测试网部署信息（合约地址、交易哈希，如有 explorer 链接）、可运行 Demo（Web 链接或清晰本地部署说明）、
**≤3 分钟 Demo 视频**（真实产品、核心功能、Portaldot 集成，公开链接）、
**Pitch Deck**（PDF 或公开链接；问题、为什么 Portaldot 必要、功能证明、持续支持理由）。

## 赛道

四个赛道：Modular Cloud & Middleware / Multi-Chain & Cross-Chain Infra / Node Operations & Tooling / Ecosystem DApps。
**页面没有说明是否允许多选赛道。** 本项目按实际实现：

- 主赛道：**Modular Cloud & Middleware**（索引、工作流中间件、API、证据数据组件）。
- 相关生态价值（不单独申报，除非主办方确认允许多选）：Node Operations & Tooling（RPC/节点健康观测、告警）。
- 不申报 Multi-Chain & Cross-Chain Infra：本项目没有实现跨链桥或跨链消息。

## 评审标准

Technical Feasibility 30% / Innovation 30% / Ecosystem Contribution 20% / Business Potential 20%。
评审依据：GitHub 仓库、提交时间线、测试网交易记录、合约地址、交易哈希、现场演示。

## AI 工具

页面**没有关于 AI 工具使用的条款**。本项目在 README 和 docs/development-timeline.md 中如实披露使用 Claude Code 辅助开发。

## 测试币

- 原生 POT SS58 地址（以 5 开头，ss58 prefix 42 已由 system_properties 实测确认）。**不要提交 0x EVM 地址。**
- 未提交过地址：在 Discord 开 support ticket，附报名截图和 SS58 地址；或私信页面列出的管理员。
- 官方声明不会索取助记词或私钥。
- 实测：测试网原生 token 符号为 **tPOT**（不是 POT），14 位小数。EVM 侧（pallet-revive）以 18 位小数展示，NativeToEthRatio = 10^4。

## 资格未决项（需要你向主办方询问，我不会自行联系）

建议在 Discord support ticket 或 DoraHacks “Ask Question” 中发送：

> Hi team, I registered/plan to register for Portaldot Hacker House 2026 but did not submit the Oct 24 check-in.
> 1. Am I still eligible to submit a final build before the Nov 6 04:00 UTC code freeze and be judged / considered for track prizes? ("All finalist teams must complete the final submission" — does "finalist" require check-in?)
> 2. Can one project select more than one track (Modular Cloud & Middleware as primary, Node Operations & Tooling as secondary)?
> 3. Our testnet deployment uses Solidity EVM bytecode on pallet-revive plus native-side event observation. Does that satisfy "complete deployment on the Portaldot testnet"?
> 4. Is there any restriction on AI-assisted coding tools? We disclose usage in the README.
> 5. My native SS58 testnet address for tokens is: <5…>. Could you send testnet tPOT?

在得到答复之前，不声称已获得评审资格。
