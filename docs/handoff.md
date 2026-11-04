# Handoff（交接说明）

更新时间：2026-11-04（第四轮）。交付总表见 docs/final-delivery.md，提交清单见 docs/submission-checklist.md，测试网证据见 docs/testnet-evidence/README.md。

## 已完成
- 已部署到 Portaldot V3 测试网：JobRegistry `0xd5dcf5a7d69354b07f776f8a961348f0a394d746`，EvidenceRegistry `0xf005d9e544a399196473ec167eda85c089d80cff`。
- 两次完整任务（requestJob → 索引 → 工作流 → 服务 → completeJob → 存证），所有交易已最终确定，CLI 独立核验通过。
- 测试：V3 交叉核对 18/18、部署核验 25/25；本地 69 个 Vitest、22 合约测试、7/7 故障场景、11/11 部署恢复、8 个 Chrome 测试、14/14 Webhook。
- 公开仓库、项目主页、基于 V3 数据的只读演示、演示视频（2:24）、22 张截图、Pitch Deck PDF。

## 需要你完成的步骤
1. **询问主办方资格**：使用 docs/hackathon-requirements.md 末尾的问题模板。
2. **旧仓库**：仍在旧账号下公开，由你决定改为私有或删除。
3. 在 DoraHacks 提交（docs/submission-draft.md，只填真实值）。

## 时间
- 代码冻结：**2026-11-06 04:00 UTC**（芝加哥 11-05 22:00）。
- “最后 24 小时”窗口自 **2026-11-05 04:00 UTC** 起：核心模块已在此之前分阶段提交（见 git log）。之后只做部署证据、文档和小修复。

## 不可宣称
EVM↔WASM 互调、ink! 部署、跨链/桥、V3 上的故障恢复、V3 上的浏览器钱包、任何性能数字、任何客户或收入、“任意服务 exactly-once”。

## 运行
`npm run dev`（本地）· `PF_MODE=testnet PF_DATA_DIR=data/testnet npm run dev`（测试网，会加载执行账户密钥并运行 worker）· 日志 `data/logs/*.log` · 数据库 `data/portalforge.db`。
