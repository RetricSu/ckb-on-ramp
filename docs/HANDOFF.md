# CKB On-ramp handoff

更新时间：2026-09-17

## 当前交付状态

仓库已经有一个可运行的 mock vertical slice：浏览器 Fiber WASM 节点、报价、Fiber SHA-256 invoice、后端 CCH adapter、LND BOLT11 展示、订单轮询和恢复错误态。

当前实现仍然只应以 **mock scaffold** 交付。`CCH_MODE=rpc` 的 bootstrap 继续 fail-closed，真实资金路径没有被宣称完成。

已验证：

- `npm test`：8 个测试通过。
- `npm run typecheck`：contracts、api、web 全部通过。
- `npm run build`：生产构建通过。
- `npm audit --audit-level=high`：0 vulnerabilities。
- Mock HTTP：health、bootstrap、quote、order、轮询成功态，以及 malformed JSON 400、未知订单 404、幂等键冲突 409。

## 已完成的工程决策

- MVP 收敛为 testnet + cWBTC + 单一 CCH 服务商；暂不承诺任意 UDT。
- 用户只需要自己的 LND 和 BTC；后端不接收 macaroon、TLS 私钥、seed 或 Fiber 私钥。
- LND 支付的是 CCH 生成的 Lightning hold invoice，不是 Fiber invoice。
- quote 手续费使用 BigInt，避免大金额 Number 精度漂移。
- quote/idempotency/mock order 有界；恢复订单遇到 API 404 会停止轮询并允许丢弃本地记录。
- 字体改为本地 fontsource，满足 COEP；Vite 继续保留 COOP/COEP。

## 已做但未完成的 testnet PoC

使用了隔离临时目录 `/tmp/ckb-on-ramp-poc/`，没有读取现有 `~/.fiber-pay` profile。确认工具版本：

- `fiber-pay 0.3.0`
- `offckb 0.5.0-canary-ee0ad6b`
- managed FNN binary 实际启动后 `node_info` 显示 `0.9.0-rc7`。

新用户节点曾成功启动并连接 2 个 testnet peers，得到 `node_info`：

- `open_channel_auto_accept_min_ckb_funding_amount = 0x2540be400`（100 CKB）。
- `auto_accept_channel_ckb_funding_amount = 0x24e160300`（99 CKB）。
- `channel_count = 0`。

重要纠正：这两个值不是“用户必须持有 99 CKB”的简单结论。前者是自动接受门槛，后者是自动接受时本端默认协作出资；运营方可以主动向用户开通道，用户侧也可以走显式 `accept_channel` 并将 `funding_amount` 设为 0。下一步必须实测这个显式接受路径，而不是把默认 auto-accept 配置误当作协议硬要求。

通过 `https://faucet-cwbtc.ckb.dev/api/info` 获取到 cWBTC 配置：

- symbol：cWBTC，decimals：8。
- amount：100 cWBTC = `10000000000` raw。
- faucet 当前不要求 Turnstile。
- type script 和 cell dep 已加入两个临时节点的 `ckb.udt_whitelist`，但未完成通道结算。

`offckb deposit --network testnet` 已提交一笔 CKB faucet transfer，交易为：

`0x44539d439a673e5228c8a59252f78fed159ff6bb611d39f19b59e93f9cf1bafa`

查询时目标地址余额仍为 0，需后续确认交易状态。临时节点已尝试停止；如果系统仍有 FNN 进程，使用各自 data dir 的 `fiber-pay node stop` 清理。

## 下一步执行顺序

1. 创建或确认 operator testnet Fiber 节点，并确认其 cWBTC 余额和 CKB funding 能力。
2. operator 连接 browser node，主动调用 `open_channel`，`funding_udt_type_script` 使用 faucet 返回的 cWBTC script。
3. browser node 监听 pending channel，调用 `accept_channel({ temporary_channel_id, funding_amount: "0x0" })`，观察是否能进入 `CHANNEL_READY`。
4. 双方 `list_channels` 核对 `local_balance` / `remote_balance`，证明用户无需 CKB/UDT 即可获得入向流动性。
5. browser node 通过 Fiber RPC 创建带 `hash_algorithm: "sha256"`、cWBTC UDT 和 amount 的 invoice；不要使用当前 CLI 的默认 invoice 命令替代它，因为 CLI 可能不带 sha256 参数。
6. operator 对该 invoice 执行 `send_payment(dry_run: true)`，确认一跳路由可用。
7. 只有 operator/CCH actor、LND hold invoice 和实际 `receive_btc` 均可用时，才做 BTC testnet 支付；否则把阻塞记录为外部依赖，不在 UI 中伪装成功。
8. PoC 通过后，再实现 `/api/node-info`、browser `connect_peer`、真实 bootstrap 状态机和节点 UDT 余额证明。

## 当前阻塞与验收闸门

- 尚未拿到可用的 CCH operator endpoint、operator pubkey/WSS 地址和 LND hold-invoice 环境。
- 尚未完成 operator 主动开 cWBTC 通道 + browser 零 funding 显式接受。
- 尚未完成真实 `receive_btc`、LND 支付和 CKB UDT 到账。
- 浏览器 Passkey/IndexedDB 跨刷新恢复尚未做真实浏览器 E2E。

在上述闸门通过前，README 和 UI 必须继续使用 mock/testnet scaffold 语气，不能写成“普通 LND 用户已经可以无条件换到 CKB 资产”。
