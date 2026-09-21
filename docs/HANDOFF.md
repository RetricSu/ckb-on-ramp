# CKB On-ramp handoff

更新时间：2026-09-17

## 当前交付状态

仓库已经有一个可运行的 mock vertical slice：浏览器 Fiber WASM 节点、报价、Fiber SHA-256 invoice、后端 CCH adapter、LND BOLT11 展示、订单轮询和恢复错误态。
已完成 `/api/node-info` 端点与前端 `connect_peer` 连通链路，并实现了前端浏览器 Fiber 节点对入向通道要约的 0-CKB 自动接受轮询器（`funding_amount: '0x0'`，绝不触发 99 CKB auto-accept）。

**Scheme B Phase-1 Operator CKB 预资助与 FNN 通道开通打通**：
根据上级指示，通过引入 CCC CKB SDK（`@ckb-ccc/core`）打通了链上容量赞助与通道开通链路：
- **容量赞助（≥200 CKB）**：在后端配置 `OPERATOR_CKB_PRIVATE_KEY`（以及可选的 `CKB_RPC_URL`，默认 testnet）后，后端使用 CCC `SignerCkbPrivateKey` 组装向用户节点 `funding_address` 转出 200 CKB 容量的交易，并调用 `waitTransaction` 等待链上确认。
- **FNN 通道开通（cWBTC）**：链上容量确认后，调用 FNN `open_channel` 向用户的 `node_pubkey` 发起 cWBTC 通道开通（`funding_amount` 默认 `100000000` raw，类型脚本与前端 `CWBTC_SCRIPT` 严格一致）。
- **非阻塞式状态返回（`provisioning_liquidity`）**：建渠发起后立即返回 `status: 'provisioning_liquidity'`，不阻断 HTTP 请求等待 `CHANNEL_READY`。
- **Fail-Closed 边界保持**：在 `CCH_MODE=rpc` 下，若未配置 `OPERATOR_CKB_PRIVATE_KEY`，接口继续严格返回 **HTTP 501**；在 `CCH_MODE=mock` 下，继续返回 **HTTP 201 ready** 且完全不产生任何链上/CCC 外部调用。
- **前端握手协同**：前端 `prepareReceiveRoute` 将 `provisioning_liquidity` 视作进行中状态（而非错误），界面展示开渠进行中提示；后台现有的 0x0 自动通道接受器（`startChannelAcceptor`）保持不变，自动完成零 CKB 出资握手。
- **私钥安全防线**：任何日志、报错与 HTTP 响应严禁打印或泄露运营方私钥，代码层内置私钥抹除与重写机制。

已验证：

- `npm test`：73 个测试全部通过（35 api + 38 web）。
- `npm run typecheck`：contracts、api、web 静态类型检查全部通过。
- `npm run build`：生产构建通过。
- Mock HTTP：health、node-info、bootstrap、quote、order、轮询成功态，以及 malformed JSON 400、未知订单 404、幂等键冲突 409。
- RPC 边界测试：`CCH_MODE=rpc` 下未配置密钥时 `POST /api/bootstrap` 严格返回 501（fail-closed）；配置密钥后发送 ≥200 CKB 并调用 `open_channel` 返回 `provisioning_liquidity`（201）。
- 浏览器通道接受器：`listChannels({ only_pending: true })` 轮询与 `acceptChannel({ temporary_channel_id, funding_amount: '0x0' })` 单元测试通过，mock 模式与无 pending 场景安全跳过。

## 已完成的工程决策

- MVP 收敛为 testnet + cWBTC + 单一 CCH 服务商；暂不承诺任意 UDT。
- 资产与私钥边界：用户端仅需提供自己的 LND、BTC 与支持 WASM 的浏览器；通道所需的约 184 CKB 链上状态容量由运营方通过 Scheme B 资助（用户无需自行持有 CKB）；后端绝不接触或代管 macaroon、TLS 私钥、seed 或 Fiber 私钥。
- LND 支付的是 CCH 生成的 Lightning hold invoice，不是 Fiber invoice。
- quote 手续费使用 BigInt，避免大金额 Number 精度漂移。
- quote/idempotency/mock order 有界；恢复订单遇到 API 404 会停止轮询并允许丢弃本地记录。
- 字体改为本地 fontsource，满足 COEP；Vite 继续保留 COOP/COEP。

## Inbound-Liquidity PoC 实测结果（步骤 1–6 实测与 0-CKB 边界验证）

测试完全在隔离临时目录 `/tmp/ckb-on-ramp-poc/` 下执行，未读取任何 `~/.fiber-pay` 配置。已确认工具版本：

- `fiber-pay 0.3.0`
- `offckb 0.5.0-canary-ee0ad6b`
- managed FNN binary 实际运行版本为 `0.9.0-rc7`

涉及节点：

- Operator RPC：`127.0.0.1:18327`，Pubkey：`03dfe0e6cc02a21ca3a971bc2fa05474872dc2acb91cc5defeb1f0566888536957`，地址：`ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq05hurcuuzeudh8ldfcxp48jfj2efakgkqz78dss`
- User RPC（已存入 CKB 节点）：`127.0.0.1:18227`，Pubkey：`029a8d5bd239bc1d7f85d65dc319022fc5934a41871473d63306b4022ee58c1e09`，监听：`/ip4/127.0.0.1/tcp/18228/p2p/Qmd3hh9df5zNgf6rqCCgsXPcZQBEijzJf6zxxbv8FtZw5T`
- User-Zero RPC（纯 0-CKB 节点）：`127.0.0.1:18427`，Pubkey：`0328d1d5ba5f060786ee7e22ac56f40664fae1354b2d48d22ebd6ca9d0e89082a5`，地址：`ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqtqkx92t45w0g3gfxjq7rt6fy59skggxzgff4s9m`，监听：`/ip4/127.0.0.1/tcp/18428/p2p/QmbJ7G5An9nRMKRRDTTUt2wuxUafsa8WnAG9gGuLkvQVdD`

### 步骤 1：Operator 充资

1. CKB 充资：通过 `offckb deposit --network testnet` 成功向 operator 地址充资 10,000 CKB（交易哈希：`0xed3049c8920bcf75ccbfa4824786afa8d7034895acdee608774e576fb866e467`）。
2. cWBTC 充资：通过 `https://faucet-cwbtc.ckb.dev/api/claims` 申领 100 cWBTC（Claim ID：`nIueaw9xiTpPWXq3c4`，交易哈希：`0x2aefacfcec457ca39f1d8e7b022bee0d3d6fea70d5a59afadddf4902f50510cc`，已确认）。

### 步骤 2：节点互联

Operator 通过 `connect_peer` 成功连接 User 本地 multiaddr（端口 18228）与 User-Zero 本地 multiaddr（端口 18428）。双方 `list_peers` 均互相可见。

### 步骤 3 & 4：通道出资与 0-CKB 接收端边界验证

本步骤验证了两个分层命题：

#### 1. UDT 入向流动性验证（PASS）
- Operator 发起 cWBTC 通道开通（出资 `100000000` raw 即 1.0 cWBTC，UDT 类型脚本指向 cWBTC）。
- 用户侧通道资产出资确认为 **`0x0`**（用户未出资任何 cWBTC）。
- 用户侧未触发 99 CKB 的 auto-accept 通道出资消耗（`auto_accept_channel_ckb_funding_amount = 0x24e160300` 未作为通道资产投入）。

#### 2. 纯 0-CKB 用户直接接受通道（FAIL on Dual-Funding）
针对全新 0-CKB 数据目录 `user-zero`（初始余额严格为 0 shannons）实测：
- **实验 1（one-way 模式直连 0-CKB 节点）**：
  - Operator 通过 RPC 调用 `open_channel({ pubkey: "0328d1d5...", funding_amount: "0x5f5e100", one_way: true, public: false, funding_udt_type_script })`（临时通道 `0x60e1bb6f3c2618eadcaec013fabc1a29eadd9a17ef369bd273baedfea66817c7`）。
  - `user-zero` 节点进入 `CollaboratingFundingTx` 状态，底层 `CkbChainActor` 必须筹集约 184 CKB 的 Cell 作为通道状态单元的储备容量（Commitment cell reservation）。
  - 由于节点没有任何可用 CKB Cell，`Fund` 失败并连续重试 5 次，最终报错中止：
    ```text
    ERROR fnn::fiber::network: Failed to fund channel (attempt 5/5): Failed to call CKB RPC: http error: error decoding response body
    ERROR fnn::fiber::network: Exhausted 5 attempts for fund channel, aborting channel Hash256(0x65e57bbaf1e02cb6662867000b8c18bea904d0b12e8e5ecee13216c06a0e02b9)
    ```
  - **结论**：原“用户无需 CKB”的断言被推翻。Fiber 当前实现下的 Dual-funding 协议在开通道协商中强制要求接收端出资约 184 CKB 链上容量储备，纯 0-CKB 节点无法达成 `CHANNEL_READY`。

- **实验 2（Scheme B：运营方预先提供 ≥200 CKB 容量 Dust / Subsidy 验证成功，但充资来源为 Faucet）**：
  - **充资来源明确记录**：向 `user-zero` 节点地址充资的 10,000 CKB（交易哈希：`0x451e6906be9c8ebdde5c75f8dc0aaf6375260427bed559cae8ae8acb47681937`，于测试网区块 `0x1567ea0` 确认）来自于**测试网 Faucet（`offckb deposit --network testnet`）**，而非由 Operator 钱包程序化直接转出。因此，虽然本实验验证了接收端拥有 CKB 容量即可顺利协商建渠，但**由 Operator 钱包直接发起并托管的自动化 Dust 资助转账路径在工程上仍未证实**。
  - Operator 重新发起 1.0 cWBTC 通道开通（临时通道 `0x33b6489eeff2270ec58566ed55199a8f95ffa3780b7a671a6d69eb6c0a11a0c7`），`user-zero` 成功协同出资 184 CKB 容量储备并完成通道签署。
  - 链上 Funding 交易哈希：`0x08dd1039f32a7e8ca65db398ac0ee52de6db4f6815038adc85b0bd5080cfd046`，于测试网区块 `0x1567eab` 确认。
  - 结果：`user-zero` 成功进入 **`CHANNEL_READY: yes`**：
    - 通道 ID：`0xc8ca42323b862c31b6fd92d0a097e87ffa062dd03f12a95a44ebc8ec02157270`
    - Outpoint：`0x08dd1039f32a7e8ca65db398ac0ee52de6db4f6815038adc85b0bd5080cfd04600000000`
    - User-Zero 端：`local_balance = 0x0`, `remote_balance = 0x5f5e100`（1.0 cWBTC 入向流动性）。钱包余额由 10000 变为 `9815.99899754 CKB`（正好锁定 184 CKB 状态储备）。

### 步骤 5：CHANNEL_READY 状态与双端通道余额汇总

两组通道均进入 `ChannelReady`：
1. **通道 0（首批 User 节点，验证步骤 1–6）**：
   - 通道 ID：`0x9f8d2c2533f4b3d2ea141ce7add6e00ed24c04dbce961c90d462e89920e3d7fb`
   - Funding 交易：`0x9f6abc95180bd992d837fb0f3ed25df59612f5f35d4306cc375e1ed62e29bff8`（区块 `0x1567e38`）
   - Operator: `local = 0x5f5e100` (1 cWBTC), `remote = 0x0`
   - User: `local = 0x0`, `remote = 0x5f5e100` (1 cWBTC 入向流动性)
2. **通道 1（Scheme B User-Zero 节点，验证 0-CKB 补丁方案）**：
   - 通道 ID：`0xc8ca42323b862c31b6fd92d0a097e87ffa062dd03f12a95a44ebc8ec02157270`
   - Funding 交易：`0x08dd1039f32a7e8ca65db398ac0ee52de6db4f6815038adc85b0bd5080cfd046`（区块 `0x1567eab`）
   - Operator: `local = 0x5f5e100` (1 cWBTC), `remote = 0x0`
   - User-Zero: `local = 0x0`, `remote = 0x5f5e100` (1 cWBTC 入向流动性)

### 步骤 6：SHA-256 Invoice 生成与 dry_run 支付验证

1. **User 创建 SHA-256 Fiber Invoice**：
   - 方式：User RPC `new_invoice`（直接调用 Fiber RPC，避免 CLI 遗漏 sha256 参数）。
   - 参数：`amount = "0xf4240"`（1,000,000 raw = 0.01 cWBTC），`currency = "Fibt"`, `hash_algorithm = "sha256"`, `udt_type_script = cWBTC`。
   - 生成的发票地址：`fibt10000001p902j3k6qenczxzat8lhv0shw9pctksul3vvrfe9avxheunkstyqlxf9rpfxdyzyxjd3uq3nadqpl2tjdsf9dl7c27p2sghmrycwyt5p0hywfdjvgdsmtlhsghqyxtkq0xn3s7lzfyrv2v0q8twny2k759sas4rc0yjxplzl38vgk0jq7kfav9fxtvndmxqdzeu2mcsyedf7s9nrsks76wgrrd4kvm5qt63cgpsj6nkqhvu0t5zt6ps9xszhdr8aup04sc870ypft098ur6hu83yntqrmcupyt075vnxqrgsln36vvtw2yeky0x5pmep9zeh8qds493khsqu86mud8y98xqq7jekx82xsunlwue9n2kvjezlj3g8aut85sh2rujke9s87w6uqu7mtxlhpn2g40z8w47e89hj8q7p9wmfggr0r5nszwquakdpygsq58kkswasrn5j6vad3h6h3898twej8jv7kf2y3lc0fxhzpzcv9w9cpuxhzd9`
   - Payment Hash（SHA-256）：`0xf79da4cb71cc1e8bb7fa547bb3fd330c51508b05be550d986aa746da9d26679e`。
2. **Operator 执行 send_payment(dry_run = true)**：
   - 方式：Operator RPC `send_payment` 传入该 invoice 与 `dry_run: true`。
   - 返回结果：`status = "Created"`, `fee = "0x0"`, `failed_error = null`。
   - 日志证据：路由图成功构建一跳路径（`build_route: amount: 1000000, amount_low_bound: Some(1), max_fee_amount: Some(5000)`），未产生实际扣款或链上状态变动。证明通过该通道自 Operator 向 User 进行 cWBTC 路由支付完全可用。

### 步骤 7：真实 UDT 结算到账与双向支付流转实测（PASS）

基于本地管理节点（Operator `127.0.0.1:18327` 与 User-Zero `127.0.0.1:18427`）和本地 `fiber-pay`、`offckb` 工具，推进实测了真实 UDT 的入账、Preimage 披露与双向路由流转：

1. **真实 UDT 入向支付（Operator → User-Zero，非 dry-run）**：
   - **发票生成**：User-Zero 调用 `new_invoice` 生成真实 SHA-256 发票，金额 `0x186a0`（100,000 raw = 0.001 cWBTC），Payment Hash：`0x043d4734de6a6380dcc737fb00027f19dd6071dbaa51e32898f4981017e6a75f`。
   - **真实支付**：Operator 调用 `send_payment` 发起实际支付，返回 `status: "Created"`；轮询 `get_payment` 确认状态跃迁为 **`status: "Success"`**（手续费 `0x0`）。
   - **接收端状态与余额变动**：
     - User-Zero 侧查询 `get_invoice` 显示 **`status: "Paid"`**。
     - User-Zero 通道 `local_balance` 从 **`0x0`** 真实增长为 **`0x186a0`**（0.001 cWBTC 到账！）。
     - User-Zero 通道 `remote_balance` 从 `0x5f5e100` 相应缩减为 `0x5f45a60`（0.999 cWBTC）。
     - Commitment Tx 哈希自 `0xebcb7516...` 推进至 `0x8cce8444...`。
   - **Operator 端余额变动**：
     - Operator 通道 `local_balance` 扣减为 `0x5f45a60`，`remote_balance` 增长为 `0x186a0`。

2. **反向支付流转（User-Zero → Operator）**：
   - Operator 生成反向发票，金额 `0x2710`（10,000 raw = 0.0001 cWBTC），Payment Hash：`0x65140a79dc9614dbc234464623916f115e7224c962825b10c52c6c582a621b34`。
   - User-Zero 通过 `fiber-pay --data-dir /tmp/ckb-on-ramp-poc/user-zero payment send` 成功支付。
   - Operator 发票确认为 **`status: "Paid"`**。
   - 结算后最终通道余额：
     - User-Zero 端：`local_balance = 0x15f90` (0.0009 cWBTC), `remote_balance = 0x5f48170` (0.9991 cWBTC)。
     - Operator 端：`local_balance = 0x5f48170`, `remote_balance = 0x15f90`。

3. **本地运维工具校验**：
   - **`fiber-pay node ready`**：User-Zero 报告 `channelsReady: 1, canSend: true, canReceive: true, recommendation: READY`。
   - **`offckb balance --network testnet --no-udt`**：User-Zero 链上余额确认为 `9815.99899754 CKB`，锁定容量储备完好无损。

**结论**：
通过真实交易证明，原本 0-CKB 资产的接收节点在 Scheme B 资助建渠后，不仅可以稳定接收入向 UDT 支付，而且进入完整的双向可用 Layer2 支付状态机。
目前端到端仅剩外部 CCH / LND 的连通（用户支付 BTC 驱动 CCH 自动触发上述 `send_payment` 并结算 hold invoice 的外部网络编排）。

## 关键架构结论与后续约束

1. **Bootstrap 机制的硬性要求与 Scheme B 定位**：
   - 真正的零资产外部普通用户（无 CKB、无 UDT）首次访问应用时，**无法**直接在链上协同开通 Fiber 通道（Dual-Funding 强制要求接收端筹集约 184 CKB 作为 Commitment cell 容量储备）。
   - 要跑通端到端无门槛入金，产品架构必须明确引入 **Scheme B（Operator CKB Dust / Capacity 预资助）**：由运营方赞助并垫付这笔 ~184 CKB 容量储备（除非未来 Fiber 协议支持 Single-funder channel 由开方完全出资 368 CKB cell 容量）。
   - **关渠退回**：详见 [scheme-b-ckb-refund.md](./scheme-b-ckb-refund.md)。用户持有 cWBTC 关到 L1 时，184 CKB 与 UDT 绑在同一 Cell，无法在不拿走用户币的前提下退回赞助商。**第一阶段只做无偿赞助，不实现回收；第二阶段再处理。**
   - **关键未证实点**：实测中 `user-zero` 的 CKB 容量资金直接来自测试网 Faucet（交易 `0x451e6906be9c8ebdde5c75f8dc0aaf6375260427bed559cae8ae8acb47681937`），而非 Operator 钱包转出。运营方钱包程序化自主发放 Dust 的机制与流程尚未得到实测验证。
2. **CLI 验证不代表浏览器 WASM 路径就绪**：
   - 使用独立 CLI 二进制（`fiber-pay 0.3.0` / FNN `0.9.0-rc7`）本地实测步骤 1–6 成功，**并不等于**浏览器 WASM 运行环境打通。浏览器端还面临跨源隔离（COOP/COEP）、WSS/WebTransport 直连限制、Passkey 私钥派生及 IndexedDB 状态跨刷新恢复等异构工程挑战。
3. **步骤 7 外部依赖阻塞**：
   - 只有当外部提供真正可用的 CCH actor 与 LND 实例（支持基于对应 SHA-256 payment hash 的 hold invoice 与 `receive_btc` 兑付）时，才执行 BTC testnet 支付。此项明确为外部依赖未就绪阻塞。
4. **交付状态与语气保留**：
   - UI 与 README 继续保持 mock / testnet scaffold 语气，严禁虚假宣称真实充值已打通，`CCH_MODE=rpc` 继续 fail-closed。
5. **FNN 缺少 CKB 转账 RPC 与 Operator 资助保持 Unwired 约束**：
   - **实测证据**：Live FNN 实例（`127.0.0.1:18327`）经实测确认无 `send_ckb` 或 `send_transaction` RPC 方法（调用返回 `Method not found`）；`fiber-pay` 钱包工具仅支持地址与余额展示（address + balance only）。
   - **架构与安全边界**：坚决不在后端 API 引入运营方私钥（`OPERATOR_*`），亦不在此层实现链上裸交易组装与签名。
   - **结论**：Scheme B Phase-1 Operator gift 转账路径因 FNN 无 CKB send RPC 而受阻（blocked on FNN having no CKB send RPC），该资助转账在 API 端明确保持 unwired，`POST /api/bootstrap` 在 `CCH_MODE=rpc` 时严格 fail-closed（HTTP 501）。
   - **浏览器端 0-CKB 接受就绪**：浏览器 WASM 节点在启动后轮询 `listChannels({ only_pending: true })`，识别入向要约（`is_acceptor: true`，状态 `NegotiatingFunding`）并显式调用 `acceptChannel({ temporary_channel_id, funding_amount: '0x0' })`。出资严格为 `'0x0'`，绝不触发 99 CKB 的 auto-accept；在 mock 模式或无 pending 通道时安全 skip，完全不破坏现有 mock 报价与订单流程。

## 后续任务清单（Forward Tasks）

PoC 已验证底层 Fiber 协议开渠与 SHA-256 支付的可行性，当前推进进展与后续任务如下：

1. **`/api/node-info` 端点实现（已完成）**：
   - 后端服务已提供真实的 Operator 节点信息接口（包含 Operator Pubkey、P2P 监听 multiaddr / WSS 地址、通道数与 peer 数），支持 mock 与 rpc 模式。
2. **浏览器端 `connect_peer` 连通性（已完成）**：
   - 浏览器 Fiber WASM 节点在 prepareRoute 阶段主动挑选 WSS/WS 地址调用 `connect_peer` 连接 Operator，并在 rpc 模式下对无效/不可达地址 fail-closed。
3. **前端通道接收端 0-CKB 握手状态机（已完成）**：
   - 浏览器 Fiber 节点启动后自动轮询 `listChannels({ only_pending: true })`，遇到入向要约主动执行 `acceptChannel({ temporary_channel_id, funding_amount: '0x0' })`，严格以 0 CKB 出资完成握手；无 pending 通道或 mock 模式自动 skip。
4. **Scheme B 自动化 Bootstrap 充资与开渠（已完成 Phase-1 CCC + FNN 链路）**：
   - 针对 live FNN 缺失 `send_ckb` RPC 的限制，引入 `@ckb-ccc/core` SDK 与 `OPERATOR_CKB_PRIVATE_KEY` 环境变量，实现 `CccOperatorCkbSender` 向用户 `funding_address` 发送 ≥200 CKB 容量预资助并在链上等待确认，随后调用 FNN `open_channel` 发起 cWBTC 通道开通并返回 `provisioning_liquidity` 状态。未配置密钥时保持 501 fail-closed。前端将 `provisioning_liquidity` 视作进行中状态，结合 0-CKB 接受器自动完成建渠协商。
5. **节点真实 UDT 余额证明与通道双向流转（已完成步骤 7 实测验证）**：
   - 针对 Scheme B 开通的 0-CKB 用户通道，通过 Operator 向 User-Zero 的真实 SHA-256 invoice 发起 `send_payment`（非 dry-run），实测验证了通道 Commitment tx 推进、UDT 到账（`local_balance` 从 `0x0` 增长至 `0x186a0` 即 0.001 cWBTC）及发票状态跃迁为 `Paid`；并实测了 User-Zero 向 Operator 的反向流转支付，确认节点 `READY` 与双向支付能力。
6. **Passkey / IndexedDB 浏览器 WASM 端到端（E2E，待前端交互验证）**：
   - 在真实浏览器环境中测试完整生命周期：Passkey 创建与恢复、私钥解密导入 WASM 节点、IndexedDB 跨页面刷新数据持久化、通道恢复与 invoice 签署。
7. **BTC Testnet 外部链路闭环（解除外部 CCH / LND 阻塞）**：
   - 接入外部真实的 CCH 服务商与 LND 节点，跑通实际 hold invoice 支付、preimage 释放与两阶段结算。
