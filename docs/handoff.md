# Handoff（交接说明）

更新时间：2026-11-03（第二轮）。本轮交付总表见 docs/final-delivery.md，提交清单见 docs/submission-checklist.md，到账后步骤见 docs/funding-handoff.md。项目目录：仓库根目录（独立 Git 仓库，与本机其他项目分离）。

## 已完成
- 规则核实（docs/hackathon-requirements.md）、V3 实时能力探测（docs/network-capabilities.md）。
- 三个存储精简合约 + 21 个 Foundry 测试；部署规划（模拟 + 精确押金）、带 journal 的部署、manifest 验证。
- 双接口索引器、工作流引擎、执行器、监控与事件、API、Web 控制台、SDK、CLI。
- 测试（第二轮）：59 Vitest（含真实 Anvil）、21 合约测试、7/7 多进程故障场景、7/7 部署恢复、3 个真实 Chrome 测试、17/17 公开只读访客检查、测试网只读冒烟 8 项通过。
- 演示视频（本地画面，2:08，合成旁白）、16 张截图、Pitch Deck PDF 已生成。

## 需要你完成的步骤（按顺序）
1. **询问主办方资格**：使用 docs/hackathon-requirements.md 末尾的问题模板（未参加 Check-in 是否仍可评审；能否多选赛道）。
2. **申请测试币**：用你自己的 native SS58 地址（5 开头），通过 Discord ticket 或页面列出的管理员。
3. **给部署者转账**：从你的钱包向 `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t`（部署者 0xAC57…Ca14 的 fallback 账户）转 ≈500 tPOT（推荐，5 个演示任务；详见 docs/funding-handoff.md）；最少 `--profile jobs` 约 215 tPOT。
4. 告诉我已转账后，我运行 `npm run -s pf -- deploy plan --profile minimal` 确认余额，再**经你确认**执行 `npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 60`。
5. **公开仓库**：确认 GitHub 仓库名与可见性后，我检查秘密并推送（`.secrets/`、`data/`、`.env`、`deployments/local-anvil*` 已忽略）。
6. **公开 Demo**（可选）：确认托管方式（VM / Cloudflare quick tunnel），见 docs/deployment.md §C。
7. 录制视频（docs/demo-script.md），在 DoraHacks 提交（docs/submission-draft.md，只填真实值）。

## 时间
- 代码冻结：**2026-11-06 04:00 UTC**（芝加哥 11-05 22:00）。
- “最后 24 小时”窗口自 **2026-11-05 04:00 UTC** 起：核心模块已在此之前分阶段提交（见 git log）。之后只做部署证据、文档和小修复。

## 不可宣称
EVM↔WASM 互调、ink! 部署、跨链/桥、测试网部署（在第 4 步完成前）、任何性能数字、任何客户或收入、“任意服务 exactly-once”。

## 运行
`npm run dev`（本地）· `PF_MODE=testnet npm run dev`（测试网）· 日志 `data/logs/*.log` · 数据库 `data/portalforge.db`。
