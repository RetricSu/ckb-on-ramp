# CKB On-ramp

CKB On-ramp is a non-custodial first-deposit flow. A user starts a Fiber node in the browser, the operator prepares inbound UDT liquidity, the browser signs a Fiber invoice, and CCH turns it into a Lightning invoice that the user pays from their own LND node.

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

   `FNN_RPC_URL` is the API's operator Fiber JSON-RPC endpoint. `CCH_RPC_URL` is the CCH JSON-RPC endpoint; leave it empty when CCH runs in the same FNN process, or set it when CCH is standalone. Both services must belong to the **testnet** operator used by this web flow.

   `OPERATOR_CKB_PRIVATE_KEY` lets the API sponsor/sign the operator side of testnet channel funding. Use the key for the funded operator wallet; it must be 64 hexadecimal characters, with an optional `0x` prefix. `.env` is gitignored: never put a real private key in `.env.example`, a commit, logs, screenshots, or chat.

3. Start the API and Vite server:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:5173`; the API listens on `http://localhost:3001`.

The browser starts a passkey-backed Fiber WASM node on CKB testnet, uses testnet cWBTC, and creates `Fibt` invoices. `npm run dev` does not start or fund the testnet operator. The operator still needs CKB capacity, cWBTC liquidity, reachable FNN/CCH RPC, and a reachable P2P address.

Vite supplies the COOP/COEP headers required by Fiber WASM and proxies the public CKB RPC through the same origin. Use the Vite URL while developing; opening built files directly or serving them without those headers will break `SharedArrayBuffer` and WASM startup.

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

## Common failures

- **Bootstrap returns HTTP 501:** the API has no valid `OPERATOR_CKB_PRIVATE_KEY`. Add the funded testnet operator key to the uncommitted `.env`, then restart `npm run dev`.
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

Never send an LND macaroon, TLS key, seed phrase, passkey material, or Fiber key to this backend. The user pays the returned BOLT11 invoice from their own LND instance.
