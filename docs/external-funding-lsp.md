# 下一步：运营方外部出资开渠（LSP funding wallet）

> 更新：2026-09-23  
> 前置：Scheme B Phase-1 已在 testnet 浏览器 WASM 上跑通「打 200 CKB → 用户 accept 0x0 → CCH hold invoice → 本地 LND 付款 → cWBTC 到账」。  
> 关渠退回调研：[scheme-b-ckb-refund.md](./scheme-b-ckb-refund.md)。

## 为什么要做

Phase-1 把可随便花的 CKB 打到用户 `funding_address`（secp）。空通道刷赞助的完整路径是：

1. 新浏览器节点领 200 CKB  
2. 接受通道（~184 锁进通道，~16 找零落在用户地址）  
3. 不入金，`shutdown_channel({ force: true })`  
4. 链上拿走 ~184 CKB；换 passkey 再来  

`shutdown_script` / 新锁脚本挡不住 force close。真正该堵的是 **开渠前把礼物变成用户可花的 UTXO**。

Fiber 已有 `open_channel_with_external_funding`：funding tx 的输入来自指定 `funding_lock_script`，找零回该锁。用户地址上不再沉淀 dust。进通道的 184 CKB 仍记在用户名下，force close 照旧能拿走——外部出资只解决前半段，184 仍当获客成本。

184 CKB 本身是「开通道就要占 Cell」再叠上 UDT type + 16 字节 data，不是单纯 UDT 税。纯 CKB 通道大约九十多 CKB；UDT 入向通道才是 ~184。

## 和插件钱包的差别

fiber-pay 对 JoyID 已经是「节点组交易、钱包只签名」：

1. `open_channel_with_external_funding`（带 `funding_lock_script`）  
2. 两边把 funding tx **结构谈死**，返回 `unsigned_funding_tx`  
3. 钱包只改 witness，`submit_signed_funding_tx`  

插件方案里第 3 步在浏览器签用户自己的 Cell，没有共享 UTXO。  
运营方钱包是第 3 步改成 **API 签同一把热钱包**。1–2 仍必须在**用户 WASM 节点**上发起——`accept_channel` 没有外部出资变体。

方向要反转：

| | Phase-1（当前） | 下一步 |
|---|---|---|
| 开渠发起 | 运营方 `open_channel` | 用户 `open_channel_with_external_funding` |
| 用户角色 | acceptor，`funding_amount: 0x0` | opener，UDT `0x0`，CKB 来自运营方锁 |
| 运营方角色 | opener + 先打 200 CKB | acceptor，出 1 cWBTC + 自己那侧 184 CKB |
| CKB 怎么到通道 | 先转到用户 secp | 用户节点用运营方 live cell 组 tx，API 签名 |
| 找零 | ~16 CKB 留用户 | 回运营方 `funding_lock_script` |

## 产品流

用户侧仍是一键「准备收款」。底下换成：

1. 浏览器起 WASM 节点、`connect_peer` 运营方  
2. `openChannelWithExternalFunding({ pubkey: 运营方, funding_amount: 0x0, udt: cWBTC, funding_lock_script: 运营方锁, shutdown_script: 用户锁 })`  
3. 拿到 unsigned tx → `POST /api/sign-funding`  
4. API 校验后用 `OPERATOR_CKB_PRIVATE_KEY` 签名 → 浏览器 `submitSignedFundingTx`  
5. 运营方节点 `accept_channel`（自己的 FNN 钱包出 cWBTC）

两把钱（可以是同一把密钥、建议拆 Cell 职责）：

- **Gift / funding lock**：只出用户侧占用的 CKB  
- **Operator FNN 钱包**：acceptor 侧 184 CKB + 入向 cWBTC  

私钥只留在 API 进程。浏览器只经手交易 JSON。

## `sign-funding` 必须当恶意客户端写

用户 WASM 会自己扫链、把运营方 live cell 填进输入。只签同时满足这些的 tx：

- 所有 input 都是运营方锁  
- 输出只有 funding cell + 找零回自己  
- 容量 / UDT / funding lock 都在预算内  
- 除 witness 外结构与 `unsigned_funding_tx` 一致（Fiber 硬约束）

不要给前端「任意 hex 签名」接口。

## 并发

JoyID 没有这个问题。运营方是多人抢同一 UTXO 池。用户节点各自跑 `CapacityBalancer`，很容易选中同一批 input：先上链的赢，另一个双花失败，通道卡到 `external_funding_timeout`（默认 5 分钟）后 abort。

运营方 FNN 当 acceptor 的那侧由节点内部串行，一般还好。抢的是 gift 钱包的 CKB Cell。

Fiber 谈死结构后不能改 input，所以**不能**「服务端选好 cell 再塞进已谈好的 tx」。第一版用：

1. 预先把 gift 钱包拆成很多 ~220 CKB 小 Cell  
2. API 对 input outpoint 做 inflight 集合，撞了拒签，前端整段重开  
3. 失败重试；testnet 也可以先用全局一把锁（同时只签一笔、等确认）  

还要回收：用户关页、签名超时、节点崩溃留下的 pending 通道。

## 明确不解决什么

- CHANNEL_READY 之后 force close 拿走 184 CKB  
- 自定义 `shutdown_script` 挡 force close（RPC 禁止，Watchtower 写死本地 secp）  
- 用户带着 cWBTC 关到 L1 还把 184 CKB 吐回运营方（同一 Cell 不可拆）  

那些仍是限额 / 长期 L2 账户 / 零余额协作关闭，见 refund spike。

## 建议的第一刀 spike（不要先做选币中间件）

只验证三件事：

1. 用户当 opener + 运营方当 acceptor，能否开出「用户 0 UDT、运营方 1 cWBTC、CKB 全来自运营方锁」的通道  
2. 找零是否回到运营方，用户地址上是否为 0 dust  
3. 两笔并发开渠失败后，重试能否收敛  

通过后再把 `/api/bootstrap` 换成 sign-funding 流，并改前端准备收款状态机。
