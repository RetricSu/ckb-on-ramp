# Spend on Fiber

Pay a testnet Fiber invoice (`fibt…`) with cWBTC that is already in the browser channel. This is an L2 exit next to **Withdraw to CKB L1**. It does not close the channel, does not change the BTC → cWBTC Swap card, and does not pretend the node can route the whole Fiber network.

## What the UI does

1. Paste a testnet Fiber invoice in Account → **Spend on Fiber**.
2. Review amount and asset (cWBTC / Fibt). Empty, undecodable, mainnet (`fibb`), other UDT, and non-Fibt invoices are refused in plain language.
3. Confirm. If the browser node is down, unlock it with the existing passkey / `ensureNodeRunning` path.
4. The WASM node `sendPayment`s the invoice and polls `getPayment` until Success or Failed. Balance refreshes. The channel stays ready; **Withdraw to CKB L1** remains available.

Refuse when the amount is greater than channel `local_balance` (leftover can cover fees). Failures such as insufficient balance, not cWBTC, no channel, or peer unreachable are shown as human copy.

## Testnet manual steps

**Status: not run in this worktree** (no live operator invoice + funded browser channel here).

1. `npm run dev` with operator FNN + CCH up (`CCH_MODE=rpc`). Chrome desktop.
2. Connect Node (passkey / e2e password). Complete a testnet swap so a ready cWBTC channel has local balance.
3. On the operator Fiber node (the hop this browser channel can actually reach), create a **Fibt** invoice with `udt_type_script` = cWBTC and an amount ≤ the channel `local_balance`.
4. Open Account (balance pill). In **Spend on Fiber**, paste the `fibt…` invoice. Check the shown amount / cWBTC. Click **Confirm payment**.
5. Wait until the UI shows paid. Browser cWBTC balance should drop by the invoice amount (plus any fee). The channel should still be ready. **Withdraw to CKB L1** should still be available.

Fail-closed checks: empty paste → refuse; `fibb` mainnet → refuse; non-cWBTC UDT → refuse; amount above local balance → refuse; stop the node, then review without unlocking → passkey prompt / refuse if cancelled.
