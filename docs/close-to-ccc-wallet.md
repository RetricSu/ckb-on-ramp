# Close Fiber channel to a CCC wallet (CKB L1)

## Spike conclusion

Cooperative close **can** override the open-time `shutdown_script`. Fiber `shutdown_channel` stores `close_script` on `local_shutdown_info`; `build_shutdown_tx` uses that lock, not the lock from `open_channel`.

Existing channels opened with `shutdown_script: nodeInfo.default_funding_lock_script` are **not** deadlocked for cooperative close. Pass `close_script` = the user’s CCC wallet lock at shutdown time.

Force close still ignores `close_script` and settles to the node secp key. It is not the product path. Do not export passkey / Fiber / CKB keys.

This worktree did **not** re-run Fiber’s own tests; the conclusion is from Fiber v0.9.0-era source (`channel.rs` shutdown command `unwrap_or(local_shutdown_script)` + `build_shutdown_tx`).

Open-time `shutdown_script` was **not** changed. Spike showed close-time `close_script` is enough. External funding was not redone.

## What the UI does

1. Connect an injected CCC wallet (UniSat). JoyID iframes/popups are blocked by COEP `require-corp` + CSP; the page does not pretend JoyID connected.
2. User confirms the address.
3. Browser node `shutdownChannel({ channel_id, close_script: wallet lock, force: false, fee_rate: 0x3e8 })`.
4. Poll `listChannels({ include_closed: true })` for `shutdown_transaction_hash`, then `get_transaction` via same-origin `/ckb-rpc` until `committed`.
5. Show tx hash + address. Copy: CKB L1 xUDT (cWBTC + ~184 CKB), not RGB++, not Lightning. Channel balance goes to zero.

## Testnet manual steps

**Status: not run in this worktree** (no live UniSat + operator FNN session here).

1. `npm run dev` with operator FNN + CCH up (`CCH_MODE=rpc`). Chrome desktop.
2. Connect Node (passkey / e2e password). Complete a testnet swap so a ready cWBTC channel has local balance.
3. Open the account modal (balance pill). Click **Connect CKB wallet**. Approve UniSat on CKB testnet.
4. Confirm the shown address. Click **Confirm close to this address**.
5. Wait until the UI shows a tx hash. On [CKB testnet explorer](https://pudge.explorer.nervos.org/) the tx should have an xUDT output locked to that address (cWBTC type script + ~184 CKB capacity).
6. UniSat / Neuron / JoyID (if the same lock) should show the UDT cell. Browser Fiber cWBTC balance should read `0`.

Fail-closed checks: skip step 3 (no wallet) → refuse close; stop the node → refuse; no channel → refuse.

JoyID: if the only wallet is JoyID, connect should fail with the isolation / injected-wallet message. That is expected, not a silent success.
