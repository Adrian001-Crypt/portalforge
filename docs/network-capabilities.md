# Portaldot V3 testnet — 实测能力报告

探测时间：2026-11-03（UTC）。探测代码：`packages/sdk/src/probe.ts`，脚本 `scripts/probe-network.ts`，CLI `pf network inspect`。
原始结果：[`docs/probe/portaldot-v3-testnet-2026-11-03.json`](probe/portaldot-v3-testnet-2026-11-03.json)；
冒烟结果：[`docs/test-results/smoke-testnet-latest.json`](test-results/smoke-testnet-latest.json)。

所有探测都是只读的：不签名、不广播、不调用 operator 类 RPC。

## 1. 网络身份

| 项 | 实测值 | 来源 |
|---|---|---|
| Native WS | `wss://test-node-v3.portaldot.dev` | 活动页公告 |
| EVM RPC | `https://test-evm-rpc-v3.portaldot.dev` | 活动页公告 |
| `system_chain` | `PortaldotV3 Test` | Native RPC |
| `system_version` | `3.0.0-dev-fddd43141f2` | Native RPC |
| genesis hash | `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` | `chain_getBlockHash(0)` |
| runtime | `portaldot-v3` specVersion **3002**, transactionVersion **2** | `state_getRuntimeVersion` |
| token | **tPOT**，**14 位小数**，SS58 前缀 **42** | `system_properties` |
| EVM chainId | **420420777**（`0x190f1ca9`），`net_version` 一致 | EVM RPC |
| EVM 客户端 | `eth-rpc/main-fddd431/...` | `web3_clientVersion` |
| 共识 / 最终性 | BABE + GRANDPA（BEEFY/MMR 亦存在）；best 与 finalized 差约 2 个块 | 区块 digest、`chain_getFinalizedHead` |
| peers | 1（`system_health`） | Native RPC |

**结论**：EVM 端点是 Substrate **pallet-revive 的 `eth-rpc` 代理**，不是独立 EVM 链。两个接口观察的是同一条 Substrate 链。

## 2. Runtime 与合约运行时

metadata：`state_getMetadata` 返回 v14；`@polkadot/api` 通过 `Metadata_metadata_at_version` 解出 v16。共 69 个 pallet，相关的是：

| Pallet | 状态 | 关键常量 |
|---|---|---|
| **Revive**（index 80） | 存在 | `allowEVMBytecode=true`，`chainId=420420777`，`nativeToEthRatio=10000`，`autoMap=true`，`depositPerByte=6e12`（0.06 tPOT），`depositPerItem=1.5e13`（0.15 tPOT），`codeHashLockupDepositPercent=30%`，`gasScale=5` |
| **Contracts**（index 21，ink!/WASM） | 存在 | `apiVersion=4`，`maxCodeLen=125952`，`depositPerByte=6e12`，`depositPerItem=1.5e13` |

Revive calls：`ethTransact, call, instantiate, instantiateWithCode, ethInstantiateWithCode, ethCall, ethSubstrateCall, uploadCode, removeCode, setCode, mapAccount, batchMapAccounts, unmapAccount, dispatchAsFallbackAccount`。
Revive events：`ContractEmitted, Instantiated, EthExtrinsicRevert`。
Runtime API `reviveApi`：`address, accountId, ethBlockHash, ethReceiptData, instantiate, call, ethEstimateGas, traceTx …`。

## 3. EVM 接口实测

| 检查 | 结果 |
|---|---|
| `latest` / `safe` / `finalized` tag | 都支持；safe = finalized，落后 latest 约 2 块 |
| `eth_gasPrice` | 约 `0x5a50`（23 120 wei/gas）；`eth_maxPriorityFeePerGas = 0` |
| `eth_feeHistory` | 支持 |
| `eth_newFilter` | **不支持**（Method not found）→ 索引器使用 `eth_getLogs` 轮询 |
| `eth_subscribe`（HTTP） | 不可用 |
| `eth_getLogs` 范围 | 全范围（0→head）查询成功，返回 2149 条；未观察到固定条数上限。索引器仍分块并在出错时自适应缩小 |
| 操作码兼容（`eth_call` 运行 init code） | frontier / istanbul `CHAINID` / shanghai `PUSH0` / cancun `TSTORE`·`TLOAD`·`MCOPY` **全部通过** |
| 本项目编译产物 | `JobRegistry`、`EvidenceRegistry`、`WorkflowExecutionRegistry` 用 `eth_call` 模拟部署，**返回的 runtime code 与 solc 产物逐字节一致** |
| `eth_estimateGas`（部署） | 可用，但数值把存储押金折算进 gas（见 §5） |

工具链锁定：solc **0.8.28**，`evm_version = cancun`，optimizer runs 1，`bytecode_hash = none`，`cbor_metadata = false`（使 runtime 哈希可复现）。Foundry 1.8.7。

## 4. 账户映射（已用 runtime 实测核对）

pallet-revive 的规则（`packages/portaldot-native/src/address.ts`）：

- Native AccountId32 → H160：若后 12 字节全为 `0xEE`（以太坊派生的 fallback 账户），取前 20 字节；否则 `keccak256(accountId)[12..32]`。
- H160 → AccountId32（fallback）：`H160 ++ 0xEE × 12`。

| 测试向量 | 本地计算 | `reviveApi` 返回 | 结果 |
|---|---|---|---|
| Substrate dev 公钥 `0xd435…a27d` → H160 | `0x9621dde6…f99d` | `0x9621dde6…f99d` | 一致 |
| `0x1000…0001` → AccountId32 | `0x1000…0001eeee…ee` | 相同 | 一致 |

因此：
- **不能**把 SS58 地址截断成 0x 地址；两个地址不是同一个账户，除非链上 `mapAccount`。
- 给一个 EVM 私钥（如 MetaMask）充值的方法：向它的 **fallback SS58 地址**（`h160 ++ 0xEE×12` 再按前缀 42 编码）转 tPOT。`npm run keygen` 会打印这个地址。
- 余额单位：native 14 位小数；EVM 侧显示为 18 位小数（×10⁴）。`packages/domain/src/units.ts` 提供 `ethToNative / nativeToEth`，界面统一以 18 位 EVM 单位显示 gas 费用，以 14 位 native 单位显示存储押金。

**2026-11-04 真实充值后已确认**：向部署账户转入 470 tPOT 后，`eth_getBalance` 显示 469.9 tPOT（×10⁴ 后的数值），比原生 free 少 0.1，正好等于存在性押金（existential deposit）。所以 EVM 侧可花余额 = free − 0.1。

## 5. 存储押金 —— 影响合约设计的关键发现

`eth_estimateGas` 给出的部署“gas”非常大（约 10¹⁶），乘以 gasPrice 约 175–270 tPOT。原因是 pallet-revive 把存储押金折算进了 gas。用 native runtime API `reviveApi.instantiate` dry-run 可以单独拿到精确押金：

| 合约 | runtime 大小 | 精确存储押金（dry-run） |
|---|---|---|
| 初版 JobRegistry（struct getter、字符串 VERSION） | 2 449 B | 215.66 tPOT |
| 初版 EvidenceRegistry | 2 181 B | 190.91 tPOT |
| 初版 WorkflowExecutionRegistry | 2 885 B | 245.82 tPOT |
| **现版 JobRegistry**（单槽打包） | 1 798 B | **161.04 tPOT** |
| **现版 EvidenceRegistry**（承诺槽） | 1 991 B | **176.09 tPOT** |
| **现版 WorkflowExecutionRegistry** | 1 935 B | **171.72 tPOT** |

押金近似为 `depositPerByte × 代码字节 × (1 + 30% lockup) + depositPerItem × 条目`。
**单个新存储槽实测 3.8415 tPOT**（`scripts/measure-call-deposits.ts`，0/1/2 个 SSTORE 的构造器 dry-run 差值，两次一致；`docs/probe/slot-deposit-latest.json`）。PortalForge 的 `requestJob`、`completeJob`、`register` 各新建一个槽。同一规则也作用于每次写存储：每个新存储条目约 0.15 tPOT + 0.06 tPOT/字节。

对设计的影响（均已实现）：
1. 合约改为**存储精简**：每个 job 只占一个打包槽（requester|input|status），完成时再写一个 executionId 槽；证据只存一个 `keccak256(contentHash, kind, subject, writer)` 承诺槽，撤销时取反覆盖（不新增条目），完整字段放在事件里。
2. 部署规划器 `planDeployment` 同时给出 gas 上限费用和**精确押金**（`dryRunDeposit`），控制台 Deployment Workbench 与 `pf deploy plan` 都显示。
3. 测试网部署分两档：`minimal`（JobRegistry + EvidenceRegistry，押金约 337 tPOT，**已实际部署**）与 `full`（再加 WorkflowExecutionRegistry，约 509 tPOT）。minimal 档下，工作流版本/执行锚定作为 EvidenceRegistry 的证据类型登记。

注意：dry-run 需要 origin 有足够余额，否则 runtime 返回 `Revive.StorageDepositNotEnoughFunds`。在部署者未充值前，规划器可用 `PF_DRYRUN_ORIGIN=<任一公开的有余额 H160>` 只做模拟（不签名）。报告中会标注用了哪个 origin。

### 真实部署后的新发现（2026-11-04，已部署到 V3）

| 现象 | 实测 | 含义 |
|---|---|---|
| 实际扣费 | JobRegistry 161.2695、EvidenceRegistry 176.3422 tPOT；押金 161.037、176.091 | gas 只占 0.23–0.25 tPOT，其余都是押金 |
| 成交 gas 价格 | 交易报价 22548，实际按 22105（当时的 `eth_gasPrice`）扣费 | 报价多出的部分不扣 |
| 单次写入费用 | `requestJob` 3.8565，`completeJob`/`register` 3.8662 tPOT | 3.8415 押金 + 0.015–0.025 gas |
| 费用估算与 gas 价格 | `eth_estimateGas` 的 gas ≈ 总费用 ÷ `eth_gasPrice`，所以 gas × price 基本不随价格变化 | 预算不应随价格下降而下降 |
| 代码已上传 | 相同字节码再次模拟时押金降到 48.957、52.431 tPOT | 同一代码的第二次部署不再收代码押金 |
| 回执索引滞后 | `eth_getTransactionCount` 已更新时，`eth_getTransactionReceipt` 和 `eth_getTransactionByHash` 可能还查不到 | 不能凭 nonce 已用就判断交易被替换，详见 `docs/testnet-evidence/README.md` |
| 公共 RPC 短暂故障 | 22:59 UTC 附近 `eth_blockNumber` 返回 HTTP 521，随后恢复 | 索引器记录错误并继续，没有丢事件 |

## 6. 双接口关联

| 检查 | 结果 |
|---|---|
| 区块编号 | EVM 区块号与 native 区块号相同 |
| 区块哈希 | 不同：EVM 哈希是 revive 计算的以太坊视图哈希。**`eth_getBlockByNumber(n).hash == reviveApi.ethBlockHash(n)`** 已实测相等 |
| 事件 | EVM log 与 native `Revive.ContractEmitted{contract, data, topics}` 是同一次合约发事件的两个视图 |

PortalForge 的关联规则（`services/indexer/src/correlation.ts`）：同一区块号、同一合约、同一 topics/data、同一块内序号 → 关联键相同；**并且** EVM 事件的块哈希等于 native 索引器记录的 `reviveApi.ethBlockHash(n)`，才标记为 verified。不满足时两条记录分开保留，界面显示“relationship unknown”。

实测（冒烟测试）：在真实测试网上索引了一个公开合约的最近一条 log，native 侧解码出对应的 `revive.ContractEmitted`（spec 3002），关联 1 条、verified 1 条。

## 7. Native RPC 方法

`rpc_methods` 列出 135 个方法，包括 `system_dryRun`、`payment_queryInfo`、`state_call`、`archive_v1_*`、`chainHead_v1_*`、`transactionWatch_v1_*`。
同时列出 11 个 operator 类方法（`author_insertKey`、`author_rotateKeys`、`system_addReservedPeer` 等）。PortalForge **从不调用**它们；这条信息记录为观测事实，供节点运营方参考。

## 8. 与旧文档/假设的差异

| 假设 | 实测 |
|---|---|
| 代币 POT | 测试网符号为 **tPOT** |
| 18 位小数 | native **14 位**；EVM 侧 18 位（×10⁴） |
| EVM = 独立链/Frontier | 是 **pallet-revive eth-rpc**，`allowEVMBytecode=true` |
| “WASM/EVM 互调” | Revive 与 Contracts 是两个独立 pallet；本项目**没有验证**两者之间的直接合约互调，也不宣称支持 |
| 部署费用“低” | 代码与存储押金约 0.06 tPOT/字节，部署一个 ~2 KB 合约押金 160–180 tPOT |

## 9. 未验证 / 不宣称

- ink!/WASM（pallet-contracts）合约的编译与部署：本机没有 Rust 工具链；PortalForge 的 WASM 资源登记当前返回 `NOT_SUPPORTED`，界面如实显示。
- EVM 合约与 WASM 合约直接互调。
- 任何跨链消息或桥。
- 节点 CPU/内存/peer 指标：公共 RPC 不提供，界面不显示。
