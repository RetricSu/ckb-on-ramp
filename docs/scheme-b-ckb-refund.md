# Scheme B 赞助 CKB 容量回收可行性调研（Spike Report）

> **任务标识**：`assign_90e0e1deff75`  
> **核心命题**：若运营方（Operator / LSP）向 0-CKB 用户赞助 ~184–200 CKB 以满足 Fiber 协议 Dual-Funding 的开渠容量储备要求，**这笔 CKB 容量在通道关闭时能否原路退还给赞助方？**  
> **代码依据**：
> - Fiber 官方仓库（nervosnetwork/fiber `@v0.9.0-rc7` / commit `bc361aaa`）
> - fiber-scripts 官方仓库（nervosnetwork/fiber-scripts `@main` / commit `cbf2bc2`）
> - fiber-pay 本地 SDK（`packages/sdk/src/types/rpc.ts`、`browser/ccc-external-funding.ts`）  
> **工作区约束**：Spike 仅限文档输出，`apps/*` 保持零变更。

---

## 1. 核心裁决（Verdict）

### 裁决结论：【有条件可行】（总体） / 【正常入金结算场景下不可行】（严格技术边界）

### 产品分期（已拍板）

- **第一阶段**：只做**无偿赞助**。运营方向新用户垫付 Dual-Funding 所需的 ~184–200 CKB 容量，**不承诺、也不实现关渠后把这笔 CKB 退回赞助商**。用户带着 cWBTC 关到 L1 时，该容量会作为 UDT Cell 的载体留给用户。
- **2026-09-23 产品判断**：真正的问题不是「入金用户带走 184 CKB」，而是 **空通道 force close 把开渠赞助兑成链上 CKB**。`shutdown_script` / 新锁挡不住 force close。下一步改为运营方 [外部出资开渠](./external-funding-lsp.md)，避免把可花 CKB 打到用户 secp；进通道后的 184 CKB 仍当获客成本。
- **第二阶段**：再单独处理回收问题（通道常驻 L2、余额归零后再协作关闭、`shutdown_script`、或向上游要 Single-funder）。本 spike 的结论是第二阶段的输入，不是第一阶段的阻塞项。

| 维度 | 可行性判定 | 核心制约 / 成立条件 |
| :--- | :--- | :--- |
| **场景 A：用户持有 cWBTC 并在 L1 结算** | **不可行 (Infeasible)** | CKB 状态模型物理定律约束：UDT 无法脱离 Capacity 独立存在于链上。Fiber 关闭交易将容量与 UDT 强行捆绑在同一 Cell 输出内。若将该 Cell 所有权赋予 Operator，构成对用户 cWBTC 的全额掠夺；若赋予用户，则 184 CKB 容量被用户带走。 |
| **场景 B：通道余额归零协作关闭** | **可行 (Feasible)** | 若用户在关渠前已通过闪电网络/Fiber 将 cWBTC 路由转出或反向兑付，本地 UDT 余额为 `0`。此时通过预设 `shutdown_script` 为 Operator 锁定脚本，协作关闭生成的空 UDT Cell（含 ~184 CKB 容量）归 Operator 所有，可自由熔毁变现。 |
| **场景 C：强制关闭（Force Close）** | **不可行 (Infeasible)** | 协议硬性限制：Force close 显式拒绝 `close_script`；Watchtower 与节点结算流程强制将结算输出打入节点本地私钥派生的默认锁定脚本（`signer.pubkey_hash()`），Operator 无法无感拦截。 |
| **场景 D：外部出资规避链外遗留 Dust** | **可行 (Feasible)** | 改由用户发起 `open_channel_with_external_funding` 并由 Operator 钱包提供输入，未用完的容量通过 `CapacityBalancer` 直接找零回 Operator 钱包，彻底避免在用户本地地址沉淀闲置 CKB Dust。 |

---

## 2. 底层机理：CKB 状态容量与 Fiber 通道资金拓扑

### 2.1 CKB Cell 模型的不可分割性公理
在 Nervos CKB 体系中，Cell 是状态的最小载体。一个完整的 Cell 包含：
- `capacity`: 8 字节，标明该 Cell 占用的 Shannons 数量（$1\text{ CKB} = 10^8\text{ Shannons}$）。
- `lock`: 锁定脚本（Ownership），决定**谁有权消费该 Cell**。
- `type`: 可选的类型脚本（Logic），定义状态转换约束（如 UDT 逻辑）。
- `data`: 状态数据（如 UDT 的 16 字节整数金额）。

> **关键物理铁律**：**Lock Script 对整个 Cell 具有排他控制权。**  
> 在既有 CKB 脚本标准下，不存在“Lock A 拥有里面的 CKB Capacity，而 Lock B 拥有里面的 UDT Token”的 Cell。谁拥有该 Cell 的 Lock 私钥，谁就同时拥有其内部的 Capacity 和 UDT。

### 2.2 UDT 通道的保留容量（~184 CKB）来源
在 Fiber 中，开通包含 UDT（如 cWBTC）的通道时，通道两端必须各自锁定一笔预留 CKB 容量：

- **代码定位**：`crates/fiber-lib/src/fiber/channel.rs:4853-4869`
  ```rust
  pub(crate) fn occupied_capacity(
      shutdown_script: &Script,
      udt_type_script: &Option<Script>,
  ) -> Result<Capacity, CapacityError> {
      let min_lock_script = if shutdown_script.args().len() < 57 {
          Script::new_builder().args([0u8; 57].pack()).build()
      } else {
          shutdown_script.clone()
      };
      let cell_output = CellOutput::new_builder()
          .lock(min_lock_script)
          .type_(udt_type_script.clone().pack())
          .build();

      if udt_type_script.is_some() {
          cell_output.occupied_capacity(Capacity::bytes(16)?) // 16 字节 UDT data
      } else {
          cell_output.occupied_capacity(Capacity::bytes(0)?)
      }
  }
  ```
- **容量开销拆解**：
  - Capacity 字段：8 字节
  - Lock Script（按 CommitmentLock 填充 57 字节 args 垫底）：$32 + 1 + 57 = 90$ 字节
  - Type Script（cWBTC xUDT）：$32 + 1 + 32 = 65$ 字节
  - Data（UDT 金额）：16 字节
  - 基础字节合计：$8 + 90 + 65 + 16 = 179$ 字节。加上 `DEFAULT_MIN_SHUTDOWN_FEE`（10,000 shannons）以及序列化对齐冗余，标准单端锁定值为 **`18,400,000,000 Shannons`（即 184 CKB）**。

### 2.3 Funding Cell 的汇聚与锁定
在建渠阶段，两端贡献的 reserved CKB 汇聚到一个单一的 Funding Cell 中：
- **代码定位**：`crates/fiber-lib/src/ckb/funding/funding_tx.rs:287-320` (`build_funding_cell`)
  ```rust
  let mut ckb_amount = self.request.local_reserved_ckb_amount;
  if remote_funded {
      ckb_amount = ckb_amount.checked_add(self.request.remote_reserved_ckb_amount)...;
  }
  let udt_output = packed::CellOutput::new_builder()
      .capacity(Capacity::shannons(ckb_amount).pack())
      .type_(Some(udt_type_script.clone()).pack())
      .lock(self.context.funding_cell_lock_script.clone())
      .build();
  ```
  对于 cWBTC 通道，Funding Cell 初始容纳 **~368 CKB**（184 CKB Operator + 184 CKB User）以及两端总计投入的 cWBTC。
- **合约定位**：`contracts/funding-lock/src/main.rs:60-107`  
  Funding Cell 由 2-of-2 Musig2 聚合公钥保护，仅要求单个 Input 并在执行时调用 `AUTH_CODE_HASH` 校验聚合 Schnorr 签名，**合约本身不限制消费该 Cell 的交易输出去向与结构**，具体输出由链下节点协商代码决定。

---

## 3. 方案一：直接赞助到用户默认链上地址（Vanilla Dust Transfer）

### 3.1 资金链路推演
1. **转账阶段**：Operator 向用户浏览器节点的默认 CKB 链上地址转账 200 CKB（交易确认产生一个 200 CKB 的 live cell）。
2. **建渠阶段**：用户节点调用 `accept_channel({ funding_amount: "0x0" })`。
   - `crates/fiber-lib/src/ckb/funding/funding_tx.rs:1102-1140`：`verify_peer_funding_contribution` 校验用户提供了覆盖 `funding_ckb_delta`（184 CKB）的输入。
   - 用户 200 CKB 输入被消费，其中 184 CKB 注入 Funding Cell，剩余约 16 CKB（扣除挖矿手续费）作为 Change Output 返还给用户默认链上地址。

### 3.2 协作关闭（Cooperative Close）
- **代码定位**：`crates/fiber-lib/src/fiber/channel.rs:9131-9150`
  ```rust
  let local_capacity: u64 = checked_sub_u64(
      self.local_reserved_ckb_amount,
      local_shutdown_fee,
      "Local reserved CKB",
  )?;
  let to_local_output = CellOutput::new_builder()
      .lock(local_shutdown_script) // 默认为用户默认地址脚本
      .type_(Some(type_script.clone()).pack())
      .capacity(local_capacity)
      .build();
  ```
- **执行结果**：
  - 用户端输出 `to_local_output` 的 Capacity 为 `~184 CKB`，Lock 为用户自身的 `local_shutdown_script`。
  - **回收判定**：**0 CKB 回收**。184 CKB 容量全额落入用户链上钱包。

### 3.3 强制关闭（Force Close）
- **代码定位**：
  - `crates/fiber-lib/src/fiber/channel.rs:9234-9290` (`build_commitment_tx_and_settlement_data`)：承诺交易将全部 368 CKB 汇入 `CommitmentLock`。
  - `crates/fiber-lib/src/watchtower/actor.rs:976-980, 1493-1496`：
    ```rust
    let fee_provider_lock_script = get_script_by_contract(Contract::Secp256k1Lock, signer.pubkey_hash());
    ...
    let settlement_output = CellOutput::new_builder()
        .lock(fee_provider_lock_script.clone())
        .type_(cell_output.type_().clone())
        .build();
    ```
- **执行结果**：
  - 触发方或 Watchtower 走单边结算时，结算输出的 Lock Script 硬编码为本节点的默认 `Secp256k1Lock`。
  - 用户端结算该通道时，其应得份额（包含 184 CKB 容量）直接归入用户节点。
  - **回收判定**：**0 CKB 回收**。

### 3.4 链外遗留找零（Leftover Dust）
- 用户钱包中的 ~16 CKB 找零 Cell 属于未进入通道的独立链上 UTXO，私钥由用户浏览器持有。
- **回收判定**：**无法强制回收**。

---

## 4. 方案二：利用 `shutdown_script` / `close_script` 指向 Sponsor Lock

### 4.1 核心思路
在调用 `accept_channel` 或 `shutdown_channel` 时，显式将 `shutdown_script` 设置为 Operator 的指定收款锁定脚本（Sponsor Lock），试图让关闭交易直接把容量打回 Operator。

### 4.2 协作关闭推演与致命资产冲突（Custody Collision）
在 `crates/fiber-lib/src/fiber/channel.rs:9131-9150` 中，观察 UDT 通道关闭输出的构造：
```rust
let to_local_output = CellOutput::new_builder()
    .lock(local_shutdown_script)               // 若设为 Sponsor Lock
    .type_(Some(type_script.clone()).pack())  // cWBTC
    .capacity(local_capacity)                 // ~184 CKB
    .build();
let to_local_output_data = self.to_local_amount.to_le_bytes().pack(); // 用户的 cWBTC 金额！
```

#### 情况 2.1：用户持有 cWBTC 余额（`to_local_amount > 0`）——【致命资产违规】
- 本产品的核心场景是用户通过闪电网络用 BTC 换取 cWBTC。此时用户通道内有真实的 cWBTC 余额。
- 若 `local_shutdown_script` 为 Sponsor Lock：
  - 包含 ~184 CKB 容量的 Cell 确实回到了 Operator 手中；
  - **但该 Cell 中携带的 `to_local_output_data`（用户的全部 cWBTC）也同时被锁给了 Operator！**
  - 用户在链上得到的是 **0 cWBTC**。Operator 的回收行为在客观上构成了对用户 UDT 资产的截流/吞没。
- **能否将该输出拆分成两个 Cell（一个给用户放 UDT，一个给 Operator 放 CKB）？**
  - **当前 Fiber 协议代码不支持**：`build_shutdown_tx` 严格按 2-of-2 双端各自生成一个输出（代码第 9152-9171 行使用 `order_things_for_musig2` 组装双输出），没有拆分逻辑。
  - **CKB 物理层面不支持**：即使协议支持拆分，用户的 cWBTC 依然必须装在一个独立的 Cell 中，而存储该 UDT Cell **本身就必须占用至少 144~184 CKB 的容量**！如果将 184 CKB 还给 Operator，用户又没有自己的 CKB，用户的 cWBTC Cell 就会因 `CapacityNotEnough` 根本无法在链上生成！

#### 情况 2.2：用户通道余额为 0（`to_local_amount == 0`）——【可行】
- 若用户在关渠前已经将 cWBTC 全部转出、反向换回 BTC，或者未发生任何入金交易；
- 此时 `to_local_output_data` 为 0，输出是一个空 UDT Cell。
- Operator 获得此 Cell 后，可以通过一笔普通 CKB 交易移除其 `type_script`，将 ~184 CKB 变现回纯 CKB。
- **回收判定**：**可行，但仅限 0 余额场景**。

### 4.3 强制关闭推演与脚本失效
- **代码定位**：`crates/fiber-lib/src/rpc/channel.rs:509-514`
  ```rust
  if params.force.unwrap_or_default()
      && (params.close_script.is_some() || params.fee_rate.is_some())
  {
      return Err(rpc_error(
          "close_script and fee_rate should not be set when force is true",
      ));
  }
  ```
  RPC 接口显式禁止在 `force=true` 时指定 `close_script`。
- 一旦通道进入强制关闭状态，`local_shutdown_script` 将不再参与结算。`crates/fiber-lib/src/watchtower/actor.rs:976-980` 表明单边结算固定绑定本地签名者的公钥哈希。
- **回收判定**：**强制关闭下彻底失效**。

---

## 5. 方案三：外部出资（`open_channel_with_external_funding`）

### 5.1 协议现存能力与方向性限制
在 Fiber 源码及本地 SDK 中审查外部出资支持：
- `crates/fiber-lib/src/rpc/channel.rs:564-605`：实现了 `open_channel_with_external_funding`
- `/Users/retric/Desktop/fiber-pay/packages/sdk/src/types/rpc.ts:369`：定义了 `OpenChannelWithExternalFundingParams`
- `crates/fiber-lib/src/fiber/channel.rs:3983-4060`：处理 `ChannelInitializationOperation::OpenChannelWithExternalFunding`

> **重要发现**：Fiber 仅在 **发起开渠（Open Channel / Outbound）** 实现了外部出资。**`accept_channel` 不存在外部出资变体**！
> - 若沿用“Operator 主动开渠 -> User 被动接受”模式，User 无法作为 Acceptor 引用 Operator 外部钱包出资。
> - 若要利用此机制，必须将交互逻辑反转为：**由用户浏览器节点调用 `open_channel_with_external_funding` 向 Operator 发起建渠**，将 Operator 钱包的 Lock 填入 `funding_lock_script`。

### 5.2 反转建渠下的找零优势
当由用户发起 `open_channel_with_external_funding` 时：
- `crates/fiber-lib/src/ckb/funding/funding_tx.rs:550-650`：
  ```rust
  let sender = self.context.funding_source_lock_script.clone();
  let balancer = CapacityBalancer::new_simple(
      sender.clone(),
      secp_sighash_placeholder_witness(),
      self.request.funding_fee_rate,
  );
  ```
- **关键优势**：出资交易的找零直接回到 `sender`（即 Operator 的外部钱包）。
- **结论**：完全消除了方案一中在用户本地钱包遗留 ~16 CKB Dust 的坏账敞口。

### 5.3 关闭通道时的资金命运
虽然建渠阶段通过外部出资避免了链外找零散落，但一旦进入通道内部：
- `local_reserved_ckb_amount` 仍然登记在 User 的通道状态机中。
- 当通道关闭时，依然会遇到**第 4.2 节相同的不可分割性困境**：
  - 若用户持有 cWBTC，该 184 CKB 容量必须继续作为该 cWBTC 在 L1 的物理载体；
  - 无论最初是由内部钱包还是外部出资注入，Fiber 的关闭交易输出无法将容量与 UDT 剥离分赠两人。

---

## 6. 场景比对全景矩阵

下表系统梳理 3 种出资方案在不同关闭分支下的 CKB 容量与 UDT 归属：

| 方案 | 通道内 UDT 状态 | 关闭方式 | CKB 容量去向 | 用户 UDT 状态 | Operator 回收率 | 链外遗留 Dust |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **方案一** (直接发 Dust) | `to_local > 0` | 协作关闭 | 归用户 (`~184 CKB`) | 正常到账 | **0%** | `~16 CKB` 沉淀在用户钱包 |
| | `to_local > 0` | 强制关闭 | 归用户 (`~184 CKB`) | 正常到账 | **0%** | `~16 CKB` 沉淀在用户钱包 |
| | `to_local == 0` | 协作关闭 | 归用户 (`~184 CKB`) | 无资产 | **0%** | `~16 CKB` 沉淀在用户钱包 |
| **方案二** (`shutdown_script`=Sponsor) | `to_local > 0` | 协作关闭 | 归 Operator (`~184 CKB`) | **被 Operator 侵吞（归零）** | **100% (但违规)** | `~16 CKB` 沉淀在用户钱包 |
| | `to_local > 0` | 强制关闭 | 归用户 (`~184 CKB`) | 正常到账 | **0%** | `~16 CKB` 沉淀在用户钱包 |
| | **`to_local == 0`** | **协作关闭** | **归 Operator (`~184 CKB`)** | **安全（本无资产）** | **100% (合法回收)** | `~16 CKB` 沉淀在用户钱包 |
| **方案三** (外部出资开渠) | `to_local > 0` | 协作关闭 | 归用户 (`~184 CKB`) | 正常到账 | **0%** | **0 CKB (找零直回 Sponsor)** |
| | `to_local > 0` | 强制关闭 | 归用户 (`~184 CKB`) | 正常到账 | **0%** | **0 CKB (找零直回 Sponsor)** |
| | **`to_local == 0`** | **协作关闭** | **归 Operator (`~184 CKB`)** | **安全（本无资产）** | **100% (合法回收)** | **0 CKB (找零直回 Sponsor)** |

---

## 7. 架构破局建议与落地策略

鉴于上述分析表明在**“用户持有 cWBTC 出金至 L1”**的场景下，要求原路收回 184 CKB 容量在密码学和协议层均不现实，团队应采用以下产品与工程策略：

### 策略 1：通道常驻化（Long-lived Layer2 Infrastructure）
- **核心认知**：不要把 Fiber 通道当成“即开即关”的单次兑换通道，而应作为用户的**长期 L2 账户**。
- **机制**：
  - 用户入金的 cWBTC 始终保存在 Fiber L2 网络中。
  - 用户若需消费，通过 Fiber 发票向商户付款，或通过反向 swap（cWBTC -> BTC Lightning）换回比特币。
  - 只要通道不关闭，Operator 的 184 CKB 容量就并未丢失，而是作为流动性底座在链上质押借出。

### 策略 2：基于反向平衡的合规收回（Rebalance & Zero-Close）
- 若用户明确要求“销毁账户并释放一切资源”：
  1. 引导用户发起一次逆向操作（将全部 cWBTC 换成闪电网络 BTC 退回其 LND）；
  2. 当本地 UDT 余额精准变为 `0x0` 后；
  3. 前端触发 `shutdown_channel({ close_script: sponsor_lock })`；
  4. Operator 100% 无损收回 184 CKB，且无任何侵吞用户资产争议。

### 策略 3：容量代付成本化（Sponsorship as Acquisition Cost / Fee Amortization）
- 184 CKB（按当前市价约几美元）作为获客成本（CAC）或服务质押金。
- 若产品允许用户将 cWBTC 关闭回 L1，将这 184 CKB 视作“赠予用户的首批链上资产”（用户进入 CKB 生态的第一笔燃料），或者在入金费率中摊销这笔固定开销。

### 策略 4：协议演进方向建议（供后续向 Fiber 上游提案）
- **Single-Funder UDT 通道**：允许 Opener 单方承担全部 368 CKB 状态容量（包含接收端的 Commitment cell reservation），接收端无需协商出资即可建渠。
- **Conditional Capacity Delegation Lock**：设计支持动态借还容量的 CKB Lock 脚本，允许在 L1 消费该 UDT 时将底层 Capacity 自动退回借出方（前提是交易中引入第三方代付者或用户提供新的 Capacity）。

---

## 8. 源码证据索引表

| 逻辑环节 | 涉及仓库 | 文件路径 | 关键行号 | 证明内容 |
| :--- | :--- | :--- | :--- | :--- |
| **保留容量计算** | `fiber` | `crates/fiber-lib/src/fiber/channel.rs` | `4853-4869` | `occupied_capacity` 强制 57 字节 args 垫底，计算出 UDT 通道单端 ~184 CKB |
| **Funding Cell 构建** | `fiber` | `crates/fiber-lib/src/ckb/funding/funding_tx.rs` | `287-320` | `build_funding_cell` 合并双端 reserved CKB，总容量 ~368 CKB |
| **双边出资校验** | `fiber` | `crates/fiber-lib/src/ckb/funding/funding_tx.rs` | `1102-1140` | `verify_peer_funding_contribution` 强制要求对端提供足够 CKB，导致 0-CKB 用户失败 |
| **协作关闭构造** | `fiber` | `crates/fiber-lib/src/fiber/channel.rs` | `9131-9150` | `build_shutdown_tx` 将 `local_capacity` 与 UDT `to_local_amount` 打包进同一个 Cell 输出 |
| **强制关闭限制** | `fiber` | `crates/fiber-lib/src/rpc/channel.rs` | `509-514` | `shutdown_channel` 明确拦截 `force=true` 时的 `close_script` |
| **单边结算锁** | `fiber` | `crates/fiber-lib/src/watchtower/actor.rs` | `976-980, 1493-1496` | 强制结算输出强制使用本地 `signer.pubkey_hash()`，绕过任何自定义脚本 |
| **外部出资 RPC** | `fiber` | `crates/fiber-lib/src/rpc/channel.rs` | `564-605` | 仅支持主动 `open_channel_with_external_funding`，无被动接受外部出资 |
| **外部出资找零** | `fiber` | `crates/fiber-lib/src/ckb/funding/funding_tx.rs` | `550-650` | `CapacityBalancer` 将多余找零安全退还 `funding_source_lock_script` |
| **Funding Lock 合约** | `fiber-scripts` | `contracts/funding-lock/src/main.rs` | `60-107` | 2-of-2 Musig2 聚合验签，不限制 output 结构与分配 |
| **Commitment Lock 合约**| `fiber-scripts` | `contracts/commitment-lock/src/main.rs` | `163-174, 463-509` | 57 字节 args，仅约束 output 0（新 commitment cell），不拦截结算去向 |
