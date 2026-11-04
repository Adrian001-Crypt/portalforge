# Handoff（交接说明）

更新时间：2026-11-04（第三轮）。交付总表见 docs/final-delivery.md，提交清单见 docs/submission-checklist.md，到账后步骤见 docs/funding-handoff.md，到账后要补充的内容见 docs/post-funding-evidence.md。

## 已完成
- 规则核实（docs/hackathon-requirements.md）、V3 实时能力探测（docs/network-capabilities.md）。
- 三个存储精简合约 + 22 个 Foundry 测试；部署规划（模拟 + 精确押金 + 预算检查）、带 journal 的部署、manifest 验证。
- 双接口索引器、工作流引擎、执行器、监控与事件、带重试和去重的 Webhook 投递、API、Web 控制台、SDK、CLI。
- 测试（第三轮）：66 Vitest（含真实 Anvil）、22 合约测试、7/7 多进程故障场景、11/11 部署恢复与预算、8 个真实 Chrome 测试、14/14 Webhook、17/17 公开只读。
- 公开仓库、项目主页、静态只读演示、演示视频（本地画面，2:18，合成旁白）、16 张截图、Pitch Deck PDF。

## 需要你完成的步骤（按顺序）
1. **询问主办方资格**：使用 docs/hackathon-requirements.md 末尾的问题模板。
2. **测试币**：已申请 450 tPOT，全部转到部署者 `5Fxg3MEsonAtt2giPzUjQMAMmBu3UDVGb5NjnQkZK4oczF1t`，不用单独转给执行账户。到账后告诉我。
3. 我运行 `npm run -s pf -- deploy plan --profile minimal --fund-executor 35 --jobs 3` 确认余额，再执行 `npm run deploy:apply -- portaldot-v3-testnet --profile minimal --confirm --fund-executor 35 --jobs 3`。
4. **旧仓库**：仍在旧账号下公开，由你决定改为私有或删除。
5. 在 DoraHacks 提交（docs/submission-draft.md，只填真实值）。

## 时间
- 代码冻结：**2026-11-06 04:00 UTC**（芝加哥 11-05 22:00）。
- “最后 24 小时”窗口自 **2026-11-05 04:00 UTC** 起：核心模块已在此之前分阶段提交（见 git log）。之后只做部署证据、文档和小修复。

## 不可宣称
EVM↔WASM 互调、ink! 部署、跨链/桥、测试网部署（在第 3 步完成前）、任何性能数字、任何客户或收入、“任意服务 exactly-once”。

## 运行
`npm run dev`（本地）· `PF_MODE=testnet npm run dev`（测试网）· 日志 `data/logs/*.log` · 数据库 `data/portalforge.db`。
