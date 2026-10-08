# CKB On-ramp

CKB On-ramp is a non-custodial first-deposit flow. A user starts a Fiber node in the browser, the operator prepares inbound UDT liquidity, the browser signs a Fiber invoice, and CCH turns it into a BOLT11 invoice that the user pays with their own Lightning wallet, such as Phoenix, Zeus, Blink, or Cash App.

## Local runbook: choose one path

This repository has two local workflows. They exercise different networks and assets; do not combine their configuration.

| | Website / user path | Protocol / ops path |
| --- | --- | --- |
| Entry point | `npm run dev` | `npm run stack:up`, then `npm run stack:e2e` |
| User Fiber node | Browser WASM | offckb FNN CLI node |
| CKB network | Testnet | offckb devnet |
| Wrapped BTC | Testnet cWBTC | Locally issued xUDT |
| Fiber invoice currency | `Fibt` | `Fibd` |

The web app's `FiberProvider` deliberately uses `network: 'testnet'` and the checked-in testnet cWBTC script. The ops stack is a separate CLI protocol harness. **Do not point the Vite app at offckb, change the FiberProvider network, or replace its UDT to make these paths meet.**

## Prerequisites

- Node.js 22+ and npm 10+ for the website and root scripts.
- A modern browser with WebAuthn/passkey support for the website path.
- A reachable testnet operator FNN/CCH, testnet CKB/cWBTC funding, and its operator CKB private key for the website path.
- Docker Desktop (with the daemon running), `offckb` 0.5.0-canary or later with Fiber support, and `fiber-pay` 0.3.0 for the protocol path.
- `python3`, `jq`, and `openssl` for the protocol path.

Install JavaScript dependencies once:

```bash
npm install
```

## Path 1: run the website on CKB testnet

1. Create a local environment file:

   ```bash
   cp .env.example .env
   ```

2. Configure the testnet operator in `.env`:

   ```dotenv
   FNN_RPC_URL=http://127.0.0.1:8227
   CCH_RPC_URL=
   OPERATOR_CKB_PRIVATE_KEY=<32-byte-hex-private-key>
   ```

   `FNN_RPC_URL` is the API's operator Fiber JSON-RPC endpoint. `CCH_RPC_URL` is the CCH JSON-RPC endpoint; leave it empty when CCH runs in the same FNN process, or set it when CCH is standalone. Both services must belong to the **testnet** operator used by this web flow. Standalone CCH also needs `fiber.chain: testnet`. Fiber v0.9.0 requires Bitcoin testnet LND invoices for `Fibt`; the regtest LND in `ops/stack.sh` cannot serve this website path.

   `OPERATOR_CKB_PRIVATE_KEY` lets the API sponsor/sign the operator side of testnet channel funding. Use the key for the funded operator wallet; it must be 64 hexadecimal characters, with an optional `0x` prefix. `.env` is gitignored: never put a real private key in `.env.example`, a commit, logs, screenshots, or chat.

3. Start the API and Vite server:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:5173`; the API listens on `http://localhost:3001`.

The browser starts a passkey-backed Fiber WASM node on CKB testnet, uses testnet cWBTC, and creates `Fibt` invoices. `npm run dev` does not start or fund the testnet operator. The operator still needs CKB capacity, cWBTC liquidity, reachable FNN/CCH RPC, and a reachable P2P address.

For public Lightning operation, consumer wallets must be able to pay the BOLT11 invoice, and CCH's LND must be on the public Lightning Network with inbound liquidity. Do not ask users to connect their nodes to the operator.

`CKB_RPC_URL` configures both the API chain client and the same-origin browser RPC proxy. See [the 2026-10-08 live testnet record](docs/testnet-e2e-2026-10-08.md) for actual transactions, the CCH network blocker, and remaining desktop wallet checks.

The development server and production preview supply the COOP/COEP and CSP headers required by Fiber WASM, and proxy the API and public CKB RPC through the same origin. Use the Vite URL while developing; opening built files directly or serving them without those headers will break `SharedArrayBuffer` and WASM startup.

## Path 2: run the local protocol stack

The protocol path is fully local: Docker runs bitcoind and two LND nodes, offckb runs CKB devnet and two FNN nodes, and a standalone CCH bridges them. It does not use the browser node.

```bash
npm run stack:up
npm run stack:status
npm run stack:e2e
npm run stack:down
```

`stack:e2e` verifies the CLI flow from a local `Fibd` invoice through `receive_btc`, Lightning hold-invoice payment, CCH settlement, and receipt of the local xUDT by the user FNN. See the complete setup, generated files, ports, logs, and reset procedure in [ops/README.md](ops/README.md).

## Environment reference

`.env.example` documents application settings. The three settings most likely to block a run are:

| Variable | How it is used |
| --- | --- |
| `FNN_RPC_URL` | API → operator FNN JSON-RPC. For the website path this must be the testnet operator; the ops harness generates a local value for its own CLI stack. |
| `CCH_RPC_URL` | API → CCH JSON-RPC. Empty means “use `FNN_RPC_URL`”, appropriate for in-process CCH; standalone CCH needs its own URL. |
| `OPERATOR_CKB_PRIVATE_KEY` | Testnet operator's 32-byte hex signing key. Required for website liquidity provisioning; never commit it. The local ops harness uses generated devnet keys instead. |

Other defaults are listed in [.env.example](.env.example). `ops/stack.sh` writes a gitignored `ops/runtime.env` and, only when `.env` does not already exist, copies it to `.env`. That generated file is for local stack endpoints; replace it with testnet operator settings before returning to the website path.

`VITE_API_BASE_URL` defaults to the same-origin `/api` path. Production hosting must route that path to the API rather than configuring a cross-origin browser endpoint that CSP will reject.

External-funding authorization and signed results persist in `ops/data/bootstrap-sessions.json` (override with `BOOTSTRAP_STORE_PATH`). Keep this file across API restarts and use one API process per signing wallet. Identical funding requests share a signature and retrieve the saved result after a lost response; a changed transaction is refused. Corrupt/unwritable storage fails closed. Missing session records are never recreated from FNN channel status. If the API stopped after reserving authorization but before saving the signature, let the old pending channel resolve before starting a new bootstrap.

Retries must preserve the original transaction field values, including hex quantity encoding and witnesses. JSON key order and snake/camel field names are normalized; changing `0x0` to `0x00` counts as a different request. Replay the transaction saved in the browser's channel ticket.

## Common failures

- **Bootstrap returns HTTP 501:** the API has no valid `OPERATOR_CKB_PRIVATE_KEY`. Add the funded testnet operator key to the uncommitted `.env`, then restart `npm run dev`.
- **`/api/sign-funding` returns "exceeds maximum allowed budget":** the user's node picks operator gift cells itself and the API refuses to sign more than 800 CKB of operator inputs per channel. Keep the operator gift wallet split into cells well below that (e.g. 300 CKB each) instead of one large cell.
- **`/api/sign-funding` returns 409 "already in flight":** another node's funding of the same operator gift cells is still pending; the web app backs off and retries. A retry from the *same* node after a failed submit is not blocked: the API releases that node's earlier reservation once the CKB node reports its funding tx as unknown/rejected.
- **Docker is missing or stopped:** `stack:up` requires both the `docker` CLI and a running Docker daemon. Start Docker Desktop and retry.
- **Fiber WASM or `SharedArrayBuffer` fails:** use `http://localhost:5173` from Vite and confirm responses include `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Third-party assets without compatible cross-origin headers can also be blocked.
- **Passkey creation/unlock fails:** use a current browser with WebAuthn enabled, allow the prompt, and retry after a cancellation. Passkey capability varies by browser/platform; clearing site data also removes the local IndexedDB channel state.
- **The web node and operator cannot agree on an asset/network:** check that an ops-generated `.env` was not reused for the web path. The website requires testnet + cWBTC + `Fibt`; the CLI stack requires devnet + local xUDT + `Fibd`.

## Verify the repository

```bash
npm run typecheck
npm run build
npm test
```

Never send an LND macaroon, TLS key, seed phrase, passkey material, or Fiber key to this backend. The user only needs to pay the returned BOLT11 invoice with their own Lightning wallet.
